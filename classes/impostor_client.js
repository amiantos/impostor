const IRC = require("irc-framework");
const path = require("path");
const { createIrcMessage, ircUserId } = require("./irc_message");
const { splitMessage, splitForConcat } = require("./message_splitter");
const { parseBridgedMessage } = require("./bridge_parser");
const ContextUtils = require("./context_utils");
const DatabaseManager = require("./database");
const MessageTracker = require("./message_tracker");
const ResponseEvaluator = require("./response_evaluator");
const VisionService = require("./vision_service");
const UrlSummarizeService = require("./url_summarize_service");
const { Archivist } = require("./archivist");
const { debounceConfig, planEvaluation } = require("./eval_debounce");
const { Presence } = require("./presence");
const { Roster } = require("./roster");
const { SilenceDirector, Spontaneity, NewsDesk, seedsForDay } = require("./spontaneity");
const { findTics, ticLedgerText } = require("./tics");
const { localParts } = require("./schedule");

/**
 * One bot: its IRC connection, database, evaluator, reply pipeline and
 * Archivist. Several run side by side in one process, sharing the model
 * client and the tools (see index.js).
 */
class ImpostorClient {
  /** A multiline piece stays under this many UTF-8 bytes so the relayed line fits in 512. */
  static MULTILINE_PIECE_BYTES = 400;

  /**
   * @param {Object} logger - A logger tagged with this bot's id
   * @param {Object} config - This bot's resolved config (see bot_config.js)
   * @param {Object} deps
   * @param {Object} deps.openai - Shared chat completions client
   * @param {{name: string, character: string, evaluator: string}} deps.persona
   * @param {{pythonTool: Object, webSearchTool: Object, webFetchTool: Object}} deps.tools
   * @param {string} deps.dataDir - Root data directory; this bot's files go under its id
   * @param {SilenceDirector} [deps.director] - Shared between bots; private when absent
   * @param {NewsDesk} [deps.newsDesk] - Shared search cache for unprompted turns; private when absent
   */
  constructor(logger, config, { openai, persona, tools, dataDir, director = null, newsDesk = null }) {
    this.persona = persona;
    this.id = config.bot?.id || config.irc.nick.toLowerCase();
    // What people call the bot in chat. The persona's name unless the config
    // says otherwise; mentioning it or the nick is always an address.
    this.watchword = config.irc.watchword || persona.name;
    this.contextUtils = new ContextUtils(logger, persona, {
      nick: config.irc.nick,
      timezone: config.timezone,
      replyMinDistance: config.irc.reply_min_distance ?? 5,
      reactMaxLength: config.irc.reaction_max_length ?? 24,
      lullMinutes: config.context?.lull_minutes ?? 30,
      maxLinkSummaries: config.context?.max_link_summaries ?? 5,
    });
    this.config = config;
    this.logger = logger;

    // IRC client
    this.ircClient = new IRC.Client();
    this.botNick = config.irc.nick;

    this.openai = openai;

    // Message queue system
    this.messageQueue = [];
    this.isProcessing = false;

    // Pending autonomous evaluations (channelId -> { timer, deadline }).
    // See classes/eval_debounce.js for how the deadline is chosen.
    this.evaluationTimers = new Map();

    // Channels with an in-flight autonomous generation. We suppress new
    // evaluations for these channels because the eval would be deciding
    // whether to respond to messages we're already responding to, and any
    // "respond" decision it made would land in the queue as a duplicate of
    // the in-flight one once the latter finished.
    this.generatingChannels = new Set();

    // Tools are shared between bots; none of them keeps per-bot state.
    this.pythonTool = tools.pythonTool;
    this.webSearchTool = tools.webSearchTool;
    this.webFetchTool = tools.webFetchTool;

    // Each bot has its own database: its own copy of the channel log, its own
    // decisions, its own journal.
    this.dbPath = path.join(dataDir, this.id, "impostor.db");
    this.db = new DatabaseManager(logger, this.dbPath);
    this.db.initialize();

    // Initialize vision service with database for caching
    this.visionService = new VisionService(logger, config, this.db);

    // Initialize URL summarize service with database for caching
    this.urlSummarizeService = new UrlSummarizeService(logger, config, this.db);

    // Initialize message tracker with vision and URL summarize services
    this.messageTracker = new MessageTracker(logger, this.db, config, this.visionService, this.urlSummarizeService);
    this.evaluator = new ResponseEvaluator(logger, config, this.db, this.visionService, persona, this.openai, this.contextUtils);

    // The journal and people notes, updated from the chatlog in the background.
    this.archivist = new Archivist(logger, config, this.db, this.openai, this.contextUtils);
    this.archivist.resume();

    // Who is in each channel and who is away (see classes/roster.js); fed
    // by the IRC events below.
    this.roster = new Roster({ selfNick: config.irc.nick, bridgeNick: config.irc.bridge_nick || null });

    // Unprompted lines into a quiet channel (see classes/spontaneity.js):
    // this bot's own limits, and the director that hands out the floor.
    this.spontaneity = new Spontaneity({ logger, botId: this.id, config: config.spontaneous || {} });
    this.ownDirector = !director;
    this.director = director || new SilenceDirector({ logger, config: config.spontaneous || {} });
    this.director.register(this);
    if (this.ownDirector) this.director.start();
    this.newsDesk = newsDesk || new NewsDesk({ search: this.webSearchTool, ttlMinutes: config.spontaneous?.news_cache_minutes ?? 360 });

    // Where the bot is: its schedule (sleep, class, out grazing) and the
    // lurker-style afk status. See classes/presence.js.
    this.presence = new Presence({
      logger,
      schedule: persona.schedule || null,
      timezone: this.contextUtils.timezone,
      seed: this.id,
      config: config.presence || {},
      hooks: {
        setAway: (message) => this.setAway(message),
        onLeave: (occurrence) => this.sayGoodbyes(occurrence),
        onReturn: (occurrence, pending) => this.catchUp(occurrence, pending),
      },
    });

    // Set up periodic maintenance
    this.maintenanceInterval = setInterval(() => {
      this.messageTracker.runMaintenance();
    }, 60 * 60 * 1000); // Run every hour

    // Reconnect backoff state
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.shuttingDown = false;

    // IRCv3 message-tags carries +typing, msgids, +draft/react and
    // +draft/reply. Must be requested before connect — the registration
    // handler reads request_extra_caps during CAP negotiation. Server silently
    // drops it if unsupported, so this is safe on networks without IRCv3.
    this.ircClient.requestCap("message-tags");
    // IRCv3 metadata (draft/metadata-2): the bot's avatar and display name,
    // sent after registration (see sendMetadata). Only -2 is requested; Ergo
    // advertises -3 too and answers either the same way, and every client we
    // know of asks for -2.
    this.ircClient.requestCap("draft/metadata-2");
    // IRCv3 draft/multiline: a long reply goes out as one message (a BATCH
    // of PRIVMSG pieces joined with draft/multiline-concat) instead of
    // several lines, and other people's multiline messages arrive whole.
    if (config.irc.multiline !== false) this.ircClient.requestCap("draft/multiline");
    // Tags of multiline BATCH starts by batch id: irc-framework keeps the
    // inner lines but drops the start line's tags, and that is where the
    // msgid (and a +draft/reply) of a multiline message live.
    this.batchTags = new Map();

    // Per-target typing refresh timers (PRIVMSG target -> setInterval id)
    this.typingTimers = new Map();

    this.presence.start();

    // Lines sent but not yet echoed back (lowercased target -> [{messageId,
    // text, sentAt}]). With echo-message the server returns each of our
    // PRIVMSGs carrying its msgid, which is how the bot learns the msgids of
    // its own lines (so it can see reactions and replies to them).
    this.pendingEchoes = new Map();

    // IRC event handlers
    this.ircClient.on("registered", () => {
      this.reconnectDelay = 1000;
      this.logger.info(`Connected to IRC as ${this.botNick}!`);
      this.botModeSet = false;
      // A fresh connection has no away status; put ours back.
      this.presence.reconnected();
      this.sendMetadata();
      // Join configured channels
      for (const channel of config.irc.channels) {
        this.ircClient.join(channel);
        this.logger.info(`Joining ${channel}`);
      }
    });

    this.ircClient.on("join", (event) => {
      this.roster.join(event.nick, event.channel);
      if (event.nick.toLowerCase() === this.botNick.toLowerCase()) {
        this.logger.info(`Joined ${event.channel}`);
        // NAMES says who is here; WHO says who of them is away.
        this.ircClient.who(event.channel, (who) => this.roster.setWho(who?.users));
      }
    });

    this.ircClient.on("userlist", (event) => {
      this.roster.setUserlist(event.channel, event.users);
    });

    this.ircClient.on("part", (event) => {
      if (event.nick.toLowerCase() === this.botNick.toLowerCase()) this.roster.forget(event.channel);
      else this.roster.leave(event.nick, event.channel);
    });

    this.ircClient.on("kick", (event) => {
      if (event.kicked.toLowerCase() === this.botNick.toLowerCase()) this.roster.forget(event.channel);
      else this.roster.leave(event.kicked, event.channel);
    });

    this.ircClient.on("quit", (event) => {
      this.roster.quit(event.nick);
    });

    // away-notify: who went away (with their message) and who came back.
    this.ircClient.on("away", (event) => {
      if (event.self) return;
      this.roster.setAway(event.nick, event.message);
      this.logger.debug(`${event.nick} is away: ${event.message || "(no message)"}`);
    });

    this.ircClient.on("back", (event) => {
      if (event.self) return;
      this.roster.setBack(event.nick);
      this.logger.debug(`${event.nick} is back`);
    });

    this.ircClient.on("privmsg", (event) => {
      // A piece of a multiline message: the whole arrives at "batch end".
      if (event.batch?.type === "draft/multiline") return;
      this.handleIrcMessage(event);
    });

    this.ircClient.on("tagmsg", (event) => {
      this.handleTagmsg(event);
    });

    this.ircClient.on("action", (event) => {
      // Handle /me actions as regular messages with * prefix
      event.message = `* ${event.nick} ${event.message}`;
      this.handleIrcMessage(event);
    });

    this.ircClient.on("nick", (event) => {
      this.roster.rename(event.nick, event.new_nick);
      // Track our own nick changes
      if (event.nick === this.botNick) {
        this.logger.info(`Nick changed from ${this.botNick} to ${event.new_nick}`);
        this.botNick = event.new_nick;
      }
    });

    this.ircClient.on("close", () => {
      this.logger.info("IRC connection closed");
      this._scheduleReconnect();
    });

    this.ircClient.on("socket close", () => {
      this.logger.info("IRC socket closed");
    });

    this.ircClient.on("raw", (event) => {
      // Log raw IRC lines for debugging connection issues
      if (event.line) {
        // Both directions land here; "<-" is from the server, "->" is ours.
        this.logger.debug(`IRC RAW ${event.from_server ? "<-" : "->"} ${event.line}`);
        if (event.from_server) this.noteBatchStart(event.line);
      }
    });

    this.ircClient.on("batch end draft/multiline", (batch) => {
      this.handleMultilineBatch(batch).catch((err) => this.logger.error("Multiline batch failed:", err));
    });

    this.ircClient.on("irc error", (event) => {
      this.logger.error("IRC error:", event);
    });

    // irc-framework has no handler for standard replies, so a refused
    // METADATA SET (`FAIL METADATA RATE_LIMITED …`) surfaces here.
    this.ircClient.on("unknown command", (command) => {
      if (command.command !== "FAIL") return;
      const line = `IRC FAIL ${command.params.join(" ")}`;
      // Deleting a metadata key the server never had; expected on most connects.
      if (command.params[0] === "METADATA" && command.params[1] === "KEY_NOT_SET") this.logger.debug(line);
      else this.logger.warn(line);
    });

    // ISUPPORT (005) arrives after RPL_WELCOME, one event per line, so the
    // bot mode can only be set from here, once the BOT token has shown up.
    this.ircClient.on("server options", (event) => {
      this.logger.info("IRC server options received (connection established)");
      this.markAsBot(event.options);
    });
  }

  connect() {
    const ircConfig = this.config.irc;
    this.logger.info(`Connecting to IRC: ${ircConfig.host}:${ircConfig.port || 6697} (TLS: ${ircConfig.tls !== false}) as ${ircConfig.nick}`);
    if (ircConfig.sasl && ircConfig.password) {
      this.logger.info("SASL authentication enabled");
    }
    const connectOptions = {
      host: ircConfig.host,
      port: ircConfig.port || 6697,
      tls: ircConfig.tls !== false,
      nick: ircConfig.nick,
      username: ircConfig.username || ircConfig.nick.toLowerCase(),
      gecos: ircConfig.realname || ircConfig.nick,
      auto_reconnect: false, // We handle reconnection ourselves with exponential backoff
      // Our own lines come back with their msgids (see recordEcho).
      enable_echomessage: true,
    };

    // SASL authentication
    if (ircConfig.sasl && ircConfig.password) {
      connectOptions.account = {
        account: ircConfig.account || ircConfig.nick,
        password: ircConfig.password,
      };
    }

    this.connectOptions = connectOptions;
    this.ircClient.connect(connectOptions);
  }

  /**
   * Set the bot user mode on servers that advertise one (the BOT ISUPPORT
   * token names the mode letter, "B" on Ergo). Marks the bot in WHOIS and
   * tags its lines for other clients; servers without it are left alone.
   * Called on every ISUPPORT line; acts once per connection.
   * @param {Object} options - The server's ISUPPORT tokens so far
   */
  markAsBot(options) {
    if (this.botModeSet) return;
    const letter = options?.BOT;
    if (typeof letter !== "string" || letter.length !== 1) return;
    this.botModeSet = true;
    this.logger.info(`Server supports bot mode (+${letter}); setting it`);
    this.ircClient.mode(this.botNick, `+${letter}`);
  }

  /**
   * Push the bot's metadata (IRCv3 draft/metadata-2) to the server:
   * `irc.display_name` as `display-name` and `irc.avatar_url` as `avatar`.
   * The config is the source of truth for both keys: a set one is SET, an
   * unset one is deleted (SET with no value), since the server may remember
   * a value from an earlier config (Ergo keeps metadata for always-on
   * accounts). Sent after every registration rather than diffed against the
   * server; two commands per connect is far inside Ergo's throttle (10 per
   * 2 minutes). Never sent before registration: Ergo's pre-registration
   * values don't overwrite an existing key but answer as if they did. The
   * server confirms with a bare 761/766 and refuses with `FAIL METADATA …`;
   * deleting a key that was already unset is a KEY_NOT_SET refusal, which
   * is the normal case and logged at debug.
   */
  sendMetadata() {
    if (!this.ircClient.network?.cap?.isEnabled("draft/metadata-2")) return;
    const keys = { "display-name": this.config.irc.display_name, avatar: this.config.irc.avatar_url };
    for (const [key, value] of Object.entries(keys)) {
      if (value) {
        this.logger.info(`Setting metadata ${key}`);
        this.ircClient.raw("METADATA", "*", "SET", key, value);
      } else {
        this.logger.debug(`Clearing metadata ${key}`);
        this.ircClient.raw("METADATA", "*", "SET", key);
      }
    }
  }

  _scheduleReconnect() {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.logger.info(`Reconnecting to IRC in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
      try {
        this.ircClient.connect(this.connectOptions);
      } catch (err) {
        this.logger.error(`IRC reconnect failed: ${err.message}`);
        this._scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Check if a channel is in the allowed list
   * @param {string} channel - IRC channel name
   * @returns {boolean} True if channel is allowed
   */
  isAllowedChannel(channel) {
    const channels = this.config.irc.channels;
    if (!channels || channels.length === 0) return true;
    return channels.some((c) => c.toLowerCase() === channel.toLowerCase());
  }

  /**
   * Whether the bot should respond to a private message from this nick.
   * Default-deny: if irc.pm_allowed_users is unset or empty, we accept and
   * store DMs (so the dashboard sees them) but never reply. Otherwise only
   * the listed nicks get replies.
   */
  isAllowedPmSender(nick) {
    const allowed = this.config.irc.pm_allowed_users;
    if (!allowed || allowed.length === 0) return false;
    return allowed.some((n) => n.toLowerCase() === nick.toLowerCase());
  }

  /**
   * Handle an incoming IRC message event
   * @param {Object} event - irc-framework message event
   */
  async handleIrcMessage(event) {
    if (!event.target) return;
    // Our own messages come back only as echoes (IRC nicks are case-insensitive)
    if (event.nick.toLowerCase() === this.botNick.toLowerCase()) {
      this.recordEcho(event);
      return;
    }

    // IRC routes channel messages and PMs through the same PRIVMSG verb. The
    // only difference is the target: channels start with '#', everything else
    // is a nick. Use the target verbatim as the conversation key for channels;
    // for DMs use the sender's nick (since target is the bot itself).
    const isPrivate = !event.target.startsWith("#");
    const conversationId = isPrivate ? event.nick : event.target;

    if (!isPrivate && !this.isAllowedChannel(event.target)) return;

    // A relay bot is opt-in: without irc.bridge_nick nothing is unwrapped
    // and nothing is treated as an announcement.
    const bridgeNick = this.config.irc.bridge_nick || null;
    const { nick, message: messageText, isWebhookAnnouncement } =
      parseBridgedMessage(event.nick, event.message, bridgeNick, this.config.irc.bridge_tags);

    const message = createIrcMessage(nick, conversationId, messageText, {
      ident: event.ident,
      hostname: event.hostname,
      isBot: false,
    });

    // Stored ahead of the message itself: a link summary can hold the
    // message back for seconds, and a reaction to it may arrive first.
    const msgid = event.tags?.msgid;
    if (msgid) this.db.addMsgid(message.id, msgid);

    // A reply (+draft/reply) to a line we know is threaded onto it, and a
    // reply to one of his own lines is as good as using his name.
    const replyMsgid = event.tags?.["+draft/reply"];
    const replyTarget = replyMsgid ? this.db.getMessageByMsgid(replyMsgid) : null;
    if (replyTarget) message.reference = { messageId: replyTarget.id };
    const repliesToBot = Boolean(replyTarget?.is_bot_message);

    // Always track the message so the admin dashboard surfaces every chat,
    // including DMs from non-allowlisted senders.
    await this.messageTracker.addMessage(message, {
      isBotMessage: false,
      processVision: true,
      processUrls: !isWebhookAnnouncement,
    });

    // DMs: every message is a direct address. Only respond if the sender is
    // on the PM allowlist; otherwise stop here (still stored above). A DM
    // the bot never answers gets no journal either: anyone on the network
    // could otherwise run up model calls by pasting at the bot.
    if (isPrivate) {
      if (!this.isAllowedPmSender(event.nick)) {
        this.logger.info(
          `PM from ${event.nick} stored but not responded to (not in pm_allowed_users).`
        );
        return;
      }
      this.archivist.noteActivity(conversationId);
      if (this.presence.gone) {
        this.logger.info(`DM from ${nick} stored; answering when back.`);
        this.presence.notePending(conversationId, { addressed: true, dm: true });
        return;
      }
      this.presence.noteAddressed();
      this.logger.info(`Queuing DM from ${nick}.`, message);
      this.messageQueue.push({ message, channel: conversationId, type: "direct" });
      if (!this.isProcessing) this.processMessageQueue();
      return;
    }

    this.archivist.noteActivity(conversationId);

    // Channel: route every message through the evaluator. Direct mentions
    // used to short-circuit straight to a response, but that bypassed the
    // react/ignore branches — now the evaluator decides for everything.
    const addressed = repliesToBot || this.mentionsBot(messageText);
    if (addressed) this.presence.noteAddressed();

    // Gone (asleep, in class): the line is stored and the journal will
    // cover it, but nothing is read or answered until the bot is back.
    if (this.presence.gone) {
      this.presence.notePending(conversationId, { addressed });
      return;
    }

    if (this.config.autonomous?.enabled) {
      this.scheduleAutonomousEvaluation(conversationId, { addressed });
    }
  }

  /**
   * An IRCv3 TAGMSG. Only reactions matter here (+draft/react, or
   * +draft/unreact, aimed by +draft/reply at the line they belong to);
   * typing notifications and anything else are ignored. Reactions are
   * stored, not treated as messages: they show on their line in the
   * chatlog and never trigger an evaluation.
   * @param {Object} event - irc-framework tagmsg event
   */
  handleTagmsg(event) {
    if (!event.nick || !event.target) return;
    // Our own come back as echoes; his reactions are stored when he sends them.
    if (event.nick.toLowerCase() === this.botNick.toLowerCase()) return;

    const tags = event.tags || {};
    if (tags["+typing"] && event.target.startsWith("#")) {
      this.roster.noteTyping(event.target, event.nick, tags["+typing"]);
    }
    const targetMsgid = tags["+draft/reply"];
    const react = tags["+draft/react"];
    const unreact = tags["+draft/unreact"];
    if (!targetMsgid || (!react && !unreact)) return;

    const isPrivate = !event.target.startsWith("#");
    const conversationId = isPrivate ? event.nick : event.target;
    if (!isPrivate && !this.isAllowedChannel(event.target)) return;

    const authorId = ircUserId(event.nick, event.ident, event.hostname);
    if (react) {
      this.db.addReaction({
        channelId: conversationId,
        targetMsgid,
        authorId,
        authorName: event.nick,
        reaction: react,
      });
      this.logger.debug(`${event.nick} reacted ${react} to ${targetMsgid} in ${conversationId}`);
    } else {
      this.db.removeReaction(targetMsgid, authorId, unreact);
      this.logger.debug(`${event.nick} removed reaction ${unreact} from ${targetMsgid} in ${conversationId}`);
    }
  }

  /**
   * A raw line from the server that starts a multiline batch: keep its tags
   * (msgid, time, +draft/reply) under the batch id until the batch ends.
   * @param {string} line
   */
  noteBatchStart(line) {
    const m = line.match(/^(?:@(\S+) )?(?::\S+ )?BATCH \+(\S+) draft\/multiline\b/i);
    if (!m) return;
    const tags = {};
    for (const part of (m[1] || "").split(";")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const key = eq === -1 ? part : part.slice(0, eq);
      const raw = eq === -1 ? "" : part.slice(eq + 1);
      tags[key.toLowerCase()] = raw.replace(/\\(.)/g, (_, c) => ({ ":": ";", s: " ", r: "\r", n: "\n", "\\": "\\" })[c] ?? c);
    }
    this.batchTags.set(m[2], tags);
    // A batch the server never closes must not pile up.
    if (this.batchTags.size > 100) this.batchTags.delete(this.batchTags.keys().next().value);
  }

  /**
   * The limits the server advertised for draft/multiline, or null when the
   * capability is not enabled.
   * @returns {{maxBytes: number, maxLines: number}|null}
   */
  multilineLimits() {
    const cap = this.ircClient.network?.cap;
    if (!cap?.isEnabled?.("draft/multiline")) return null;
    const value = String(cap.available?.get?.("draft/multiline") || "");
    const read = (key, fallback) => {
      const m = value.match(new RegExp(`(?:^|,)${key}=(\\d+)`));
      return m ? Number(m[1]) : fallback;
    };
    return { maxBytes: read("max-bytes", 4096), maxLines: read("max-lines", 24) };
  }

  /**
   * A finished draft/multiline batch (irc-framework's "batch end" event):
   * join its PRIVMSG pieces into one message, with the start line's tags,
   * and handle it like any other line. Pieces tagged draft/multiline-concat
   * continue the previous piece; the others start a new line.
   * @param {{id: string, type: string, params: string[], commands: Object[]}} batch
   */
  async handleMultilineBatch(batch) {
    const tags = this.batchTags.get(batch.id) || {};
    this.batchTags.delete(batch.id);
    const pieces = (batch.commands || []).filter((c) => c.command === "PRIVMSG" && c.params?.length >= 2);
    if (pieces.length === 0) return;
    let text = "";
    pieces.forEach((c, i) => {
      const body = c.params[c.params.length - 1];
      const concat = c.tags && Object.prototype.hasOwnProperty.call(c.tags, "draft/multiline-concat");
      text += i > 0 && !concat ? `\n${body}` : body;
    });
    const first = pieces[0];
    await this.handleIrcMessage({
      nick: first.nick,
      ident: first.ident,
      hostname: first.hostname,
      target: first.params[0],
      message: text,
      tags: { ...tags, ...(first.getTag?.("account") ? { account: first.getTag("account") } : {}) },
      time: tags.time ? Date.parse(tags.time) || undefined : undefined,
      batch: { id: batch.id, type: batch.type, params: batch.params },
    });
  }

  /**
   * Match an echoed line of ours to the message it was sent for and record
   * its msgid. Echoes come back in the order the lines went out; a line the
   * server never echoed (dropped, or sent by something other than
   * sendIrcMessage) is skipped over, and one the library split further is
   * consumed piece by piece.
   * @param {Object} event - irc-framework privmsg event from our own nick
   */
  recordEcho(event) {
    const msgid = event.tags?.msgid;
    const key = event.target.toLowerCase();
    const queue = this.pendingEchoes.get(key);
    if (!msgid || !queue) return;

    const cutoff = Date.now() - 60 * 1000;
    while (queue.length > 0 && queue[0].sentAt < cutoff) queue.shift();

    const text = (event.message || "").trim();
    const index = text ? queue.findIndex((entry) => entry.text.startsWith(text)) : -1;
    if (index === -1) {
      if (queue.length === 0) this.pendingEchoes.delete(key);
      return;
    }
    queue.splice(0, index);
    const entry = queue[0];
    this.db.addMsgid(entry.messageId, msgid);
    entry.text = entry.text.slice(text.length).trim();
    if (!entry.text) queue.shift();
    if (queue.length === 0) this.pendingEchoes.delete(key);
  }

  /** Whether the server lets us send IRCv3 reactions at all. */
  canSendReactions() {
    if (this.config.irc.reactions === false) return false;
    const network = this.ircClient.network;
    return Boolean(network?.supportsTag("draft/react") && network?.supportsTag("draft/reply"));
  }

  /**
   * Reactions are cheap, and nothing else would stop a bot from reacting to
   * every line. After one he waits for a few lines from other people and
   * some wall clock.
   * @param {string} channelName
   * @returns {{blocked: boolean, reason: string}}
   */
  reactionCooldown(channelName) {
    const last = this.db.getLastBotReaction(channelName);
    if (!last) return { blocked: false, reason: "" };
    const minMessages = this.config.autonomous?.react_cooldown_messages ?? 3;
    const minSeconds = this.config.autonomous?.react_cooldown_seconds ?? 30;

    const since = this.db.countHumanMessagesSince(channelName, last.created_at);
    if (since < minMessages) {
      return { blocked: true, reason: `only ${since} message(s) since his last reaction (needs ${minMessages})` };
    }
    const elapsed = (Date.now() - new Date(last.created_at).getTime()) / 1000;
    if (elapsed < minSeconds) {
      return { blocked: true, reason: `only ${elapsed.toFixed(0)}s since his last reaction (needs ${minSeconds}s)` };
    }
    return { blocked: false, reason: "" };
  }

  /**
   * A reaction the model wrote, made fit to send: one line, trimmed, and
   * short (an emoji or a word or two). Null when nothing usable is left.
   * @param {*} raw
   * @returns {string|null}
   */
  cleanReaction(raw) {
    if (typeof raw !== "string") return null;
    const reaction = raw.replace(/\s+/g, " ").trim();
    const max = this.config.irc.reaction_max_length ?? 24;
    if (!reaction || [...reaction].length > max) return null;
    return reaction;
  }

  /**
   * Put a reaction on a line, if that's allowed: not his own line, not one
   * he already reacted to, not inside the reaction cooldown, and only when
   * the server and the line can carry an IRCv3 react.
   * @param {string} channelName - Conversation (PRIVMSG target)
   * @param {Object|null} target - Message record to react to
   * @param {*} rawReaction - What the model asked for
   * @returns {{sent: boolean, reason: string, reaction: string|null}}
   *   `reason` "unsupported" means only the transport was missing
   */
  sendReaction(channelName, target, rawReaction) {
    const reaction = this.cleanReaction(rawReaction);
    if (!reaction) return { sent: false, reason: `unusable reaction ${JSON.stringify(rawReaction)}`, reaction };
    if (!target) return { sent: false, reason: "no line to react to", reaction };
    if (target.is_bot_message) return { sent: false, reason: "that's his own line", reaction };

    const cooldown = this.reactionCooldown(channelName);
    if (cooldown.blocked) return { sent: false, reason: cooldown.reason, reaction };

    const msgid = this.db.getMsgidFor(target.id);
    if (!msgid || !this.canSendReactions()) return { sent: false, reason: "unsupported", reaction };
    if (this.db.hasBotReaction(msgid)) return { sent: false, reason: "already reacted to that line", reaction };

    this.ircClient.tagmsg(channelName, { "+draft/reply": msgid, "+draft/react": reaction });
    this.db.addReaction({
      channelId: channelName,
      targetMsgid: msgid,
      authorId: this.botNick.toLowerCase(),
      authorName: this.botNick,
      reaction,
      isBotMessage: true,
    });
    this.db.logResponse(channelName, null, "reaction", reaction, target.id);
    this.logger.info(`Reacted ${reaction} to ${target.author_name}'s line in ${channelName}`);
    return { sent: true, reason: "", reaction };
  }

  /**
   * The msgid to send a reply tag against, or null. Reply tags are only for
   * answering a line that has scrolled out of sight (`irc.reply_min_distance`
   * lines or more after it); on anything recent a "nick:" prefix does the
   * job, and a reply-threaded answer to the line just above is noise.
   * @param {string} channelName
   * @param {Object} target - Message record being answered
   * @returns {string|null}
   */
  replyTagFor(channelName, target) {
    const minDistance = this.config.irc.reply_min_distance ?? 5;
    const distance = this.db.countMessagesAfter(channelName, target.id);
    if (distance === null || distance < minDistance) {
      this.logger.debug(`Not reply-tagging ${target.author_name}'s line: ${distance ?? "?"} line(s) after it (needs ${minDistance})`);
      return null;
    }
    if (!this.ircClient.network?.supportsTag("draft/reply")) return null;
    return this.db.getMsgidFor(target.id);
  }

  /**
   * Schedule an autonomous evaluation. Each new line pushes the timer back
   * by the debounce so the bot reads a settled conversation, but a wait has
   * a deadline fixed when it began (`max_wait_seconds`), and a line that
   * names the bot pulls that deadline in (`address_wait_seconds`). Without
   * the deadline a busy channel resets the timer forever and he never gets
   * a turn, even when asked a question.
   * @param {string} channelName - IRC channel name (e.g. "#amiantos")
   * @param {Object} [options]
   * @param {boolean} [options.addressed] - The line that prompted this names the bot
   */
  scheduleAutonomousEvaluation(channelName, { addressed = false } = {}) {
    if (this.generatingChannels.has(channelName)) {
      this.logger.debug(
        `Skipped scheduling evaluation for ${channelName} — generation in flight`
      );
      return;
    }

    const now = Date.now();
    const pending = this.evaluationTimers.get(channelName);
    if (pending) {
      clearTimeout(pending.timer);
      this.logger.debug(`Reset evaluation timer for channel ${channelName}`);
    }

    const { fireAt, deadline } = planEvaluation({
      now,
      deadline: pending ? pending.deadline : null,
      addressed,
      cfg: debounceConfig(this.config.autonomous),
    });

    const timer = setTimeout(async () => {
      this.logger.debug(`Evaluation timer fired for channel ${channelName}`);
      this.evaluationTimers.delete(channelName);
      await this.evaluateAutonomousResponse(channelName);
    }, Math.max(0, fireAt - now));

    this.evaluationTimers.set(channelName, { timer, deadline });
    const why = addressed ? " (addressed)" : "";
    this.logger.debug(
      `Scheduled evaluation for channel ${channelName} in ${((fireAt - now) / 1000).toFixed(1)}s${why}, deadline in ${((deadline - now) / 1000).toFixed(1)}s`
    );
  }

  /**
   * Evaluate whether to send an autonomous response
   * @param {string} channelName - IRC channel name
   */
  async evaluateAutonomousResponse(channelName) {
    if (this.generatingChannels.has(channelName)) {
      this.logger.debug(
        `Skipped autonomous eval for ${channelName} — generation in flight`
      );
      return;
    }

    if (this.presence.gone) {
      this.presence.notePending(channelName);
      return;
    }

    const botUserId = this.botNick.toLowerCase();

    // Get ALL recent messages for ratio calculation (50 messages)
    const recentMessages = this.db.getRecentMessages(channelName, 50, true);

    // Calculate bot dominance ratio (passed to AI evaluator for context)
    const botRatio = this.evaluator.calculateBotRatio(
      recentMessages,
      botUserId
    );

    // Check if there are any messages after the bot's last response
    const hasNewMessages = this.hasMessagesSinceLastBotResponse(recentMessages);
    if (!hasNewMessages) {
      this.logger.debug("No new messages since last bot response");
      return;
    }

    // A reaction is a turn too: once he's reacted, the same lines don't get
    // weighed again.
    const lastReaction = this.db.getLastBotReaction(channelName);
    const newest = recentMessages[recentMessages.length - 1];
    if (lastReaction && new Date(newest.created_at) <= new Date(lastReaction.created_at)) {
      this.logger.debug("No new messages since last bot reaction");
      return;
    }

    // The evaluator sees the same screen the reply model does, and nothing
    // in code gates it. Whether the bot has been talking too much, and
    // whether a line that doesn't name them is still aimed at them, are the
    // evaluator's calls, made from the conversation and the persona. (A
    // message-count cooldown used to sit here for the unaddressed case. In a
    // slow channel it gagged a bot for hours after a 1:1 exchange, which
    // read as sulking: a worse failure than a line too many.)
    const evaluationMessages = this.screenFor(channelName);

    // Ask AI if we should respond (pass ratio and the journal for context)
    const decision = await this.evaluator.shouldRespond(
      evaluationMessages,
      botUserId,
      channelName,
      botRatio,
      {
        journal: this.db.getJournalText(channelName),
        canReact: !this.reactionCooldown(channelName).blocked,
        presence: this.presence.describe(),
        whoIsHere: this.roster.describe(channelName),
      }
    );

    if (decision.action === "respond") {
      this.logger.info(
        `Queueing autonomous response for channel ${channelName}: ${decision.reason}`
      );
      this.messageQueue.push({
        channel: channelName,
        type: "autonomous",
        decisionId: decision.decisionId,
        enqueuedAt: Date.now(),
      });
      if (!this.isProcessing) this.processMessageQueue();
    } else if (decision.action === "react") {
      this.logger.info(
        `Queueing reaction for channel ${channelName}: ${decision.reason}`
      );
      this.messageQueue.push({
        channel: channelName,
        type: "react",
        decisionId: decision.decisionId,
        targetMessageId: decision.reply_to_message_id,
        reaction: decision.reaction,
        enqueuedAt: Date.now(),
      });
      if (!this.isProcessing) this.processMessageQueue();
    }
  }

  /**
   * Check if there are any messages since the bot's last response
   * @param {Array} messages - Parsed messages from database (chronological order, oldest first)
   * @returns {boolean} True if there are new messages to evaluate
   */
  hasMessagesSinceLastBotResponse(messages) {
    if (!messages || messages.length === 0) return false;
    return !messages[messages.length - 1].is_bot_message;
  }

  /**
   * Whether a line names the bot (his watchword or nick, case-insensitive).
   * @param {string} text
   * @returns {boolean}
   */
  mentionsBot(text) {
    const content = (text || "").toLowerCase();
    return [this.watchword, this.botNick]
      .filter(Boolean)
      .some((n) => content.includes(n.toLowerCase()));
  }

  /**
   * What is on the bot's screen in a conversation: the last
   * `context.screen_lines` lines, however old (a lull shows as a "--- 3
   * hours later ---" marker, not a cut), reaching further back when the
   * journal hasn't read that far yet, so no line is in neither the chatlog
   * nor his memory. `context.max_lines` caps the reach.
   * @param {string} channelId
   * @returns {Array} Parsed messages, chronological
   */
  screenFor(channelId) {
    const screenLines = this.config.context?.screen_lines ?? 50;
    const maxLines = Math.max(screenLines, this.config.context?.max_lines ?? 150);
    let lines = screenLines;
    if (this.config.journal?.enabled !== false) {
      const watermark = this.db.getJournal(channelId)?.watermark_rowid ?? 0;
      lines = Math.min(maxLines, Math.max(screenLines, this.db.countMessagesAfterRowid(channelId, watermark)));
    }
    return this.db.getRecentMessages(channelId, lines, true);
  }

  async processMessageQueue() {
    if (this.isProcessing) return;

    this.isProcessing = true;

    while (this.messageQueue.length > 0) {
      const queueItem = this.messageQueue.shift();

      try {
        if (queueItem.type === "direct") {
          this.logger.info(
            `Processing direct message from ${queueItem.message.author.username}. Queue length: ${this.messageQueue.length}`
          );
          await this.processDirectMessage(queueItem.message, queueItem.channel);
        } else if (queueItem.type === "spontaneous") {
          // The silence this was meant to fill may be over by now.
          const newest = this.db.getRecentMessages(queueItem.channel, 1)[0];
          if (newest && new Date(newest.created_at).getTime() > queueItem.enqueuedAt) {
            this.logger.info(`Dropping spontaneous line for ${queueItem.channel} — someone spoke meanwhile`);
            this.director.abandon(queueItem.channel, this.id);
            continue;
          }
          this.generatingChannels.add(queueItem.channel);
          try {
            await this.processSpontaneousMessage(queueItem.channel, queueItem);
          } finally {
            this.generatingChannels.delete(queueItem.channel);
          }
        } else if (queueItem.type === "autonomous" || queueItem.type === "react") {
          // A decision can sit in the queue while an earlier in-flight
          // generation is still running. If the bot has already spoken in
          // this channel since this decision was enqueued, the decision is
          // stale — the question it was meant to address has likely already
          // been answered by the in-flight response.
          if (queueItem.enqueuedAt) {
            const lastBotTime = this.db.getLastBotResponseTime(queueItem.channel);
            if (lastBotTime && lastBotTime.getTime() > queueItem.enqueuedAt) {
              this.logger.info(
                `Dropping stale ${queueItem.type} for ${queueItem.channel} — bot already responded since this decision was enqueued`
              );
              if (queueItem.decisionId) {
                this.db.markDecisionResponseSent(queueItem.decisionId);
              }
              continue;
            }
          }

          this.generatingChannels.add(queueItem.channel);
          try {
            if (queueItem.type === "autonomous") {
              this.logger.info(
                `Processing autonomous response for channel ${queueItem.channel}. Queue length: ${this.messageQueue.length}`
              );
              await this.processAutonomousMessage(queueItem.channel, queueItem.decisionId);
            } else {
              this.logger.info(
                `Processing reaction for channel ${queueItem.channel}. Queue length: ${this.messageQueue.length}`
              );
              await this.processReactMessage(queueItem.channel, queueItem);
            }
          } finally {
            this.generatingChannels.delete(queueItem.channel);
          }
          // Catch up on messages that arrived during generation (their evals
          // were suppressed by the in-flight flag). The eval bails cheaply if
          // there's nothing post-bot-response to react to.
          if (this.config.autonomous?.enabled) {
            this.scheduleAutonomousEvaluation(queueItem.channel);
          }
        }

        // Add a small delay between messages to appear more natural
        if (this.messageQueue.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        this.logger.error("Error processing queued message:", error);
        if (queueItem.channel) {
          // Belt-and-suspenders: inner try/finally already sends done on
          // generation failures, but if the throw happened earlier this
          // ensures no typing indicator is left hanging.
          this.stopTyping(queueItem.channel, "done");
        }
        // No out-of-character apology: the typing indicator is gone and the
        // next time the bot speaks it can play off the silence itself.
      }
    }

    this.isProcessing = false;
  }

  /**
   * Build context from database: the screen (see screenFor) plus what goes
   * with it
   * @param {string} channelId - Channel identifier (IRC channel name)
   * @returns {Object} Context object with messages, imageDescriptions, and urlSummaries
   */
  buildContextFromDatabase(channelId) {
    const dbMessages = this.screenFor(channelId);

    const imageDescriptions = this.visionService.buildImageDescriptionsFromDB(dbMessages);
    const urlSummaries = this.urlSummarizeService.buildUrlSummariesFromDB(dbMessages);

    // The journal for this conversation and the notes for whoever is in the window.
    // One entry per person, under the spelling they used most recently.
    const bySpelling = new Map();
    for (const msg of dbMessages) {
      if (!msg.is_bot_message && msg.author_name) {
        bySpelling.set(msg.author_name.toLowerCase(), msg.author_name);
      }
    }
    const memory = this.archivist.memoryFor(channelId, [...bySpelling.values()]);

    return {
      dbMessages,
      imageDescriptions,
      urlSummaries,
      memory
    };
  }

  /**
   * Process a direct message (someone mentioned the bot's nick)
   * @param {Object} message - Normalized message object
   * @param {string} channelName - IRC channel name
   */
  async processDirectMessage(message, channelName) {
    const user_name = message.author.username
      .replace(/\s+/g, "_")
      .replace(/[^\w\s]/gi, "");
    const character_name = this.watchword;

    // Nobody reads and starts typing the instant a DM lands. A short random
    // pause first, with the screen built after it so a second line that
    // arrives meanwhile is on it.
    const minDelay = this.config.irc.dm_delay_min_seconds ?? 2;
    const maxDelay = Math.max(minDelay, this.config.irc.dm_delay_max_seconds ?? 6);
    const delay = minDelay + Math.random() * (maxDelay - minDelay);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay * 1000));

    const { dbMessages, imageDescriptions, memory } = this.buildContextFromDatabase(channelName);

    const triggerInfo = {
      userId: message.author.id,
      userName: message.author.username,
      channelName: channelName,
    };
    const refs = ContextUtils.assignRefs(dbMessages);

    this.startTyping(channelName);
    let response, conversationLog, react, replyTo, systemPrompt;
    try {
      ({ response, conversationLog, react, replyTo, systemPrompt } = await this.generateResponseWithChatCompletions({
        dbMessages,
        userName: user_name,
        characterName: character_name,
        botUserId: this.botNick.toLowerCase(),
        imageDescriptions,
        memory,
        triggerInfo,
        refs,
        canReact: this.canReactNow(channelName),
      }));
      // A PRIVMSG implicitly clears the indicator; a reaction alone doesn't.
      this.stopTyping(channelName, response ? null : "done");
    } catch (err) {
      this.stopTyping(channelName, "done");
      throw err;
    }

    // An empty response is the model's "stay silent" signal. Skip the IRC send
    // and chatlog tracking (an empty bot line would pollute future context),
    // but still log to the dashboard for transparency.
    const botMessage = createIrcMessage(this.botNick, channelName, response, {
      isBot: true,
    });

    const responseId = this.db.logResponse(
      channelName,
      botMessage.id,
      "direct",
      response,
      message.id
    );

    this.db.storePrompt({
      responseId,
      promptType: "response",
      systemPrompt,
      messagesJson: conversationLog,
      model: this.config.generator.deepseek.model,
      temperature: this.config.generator.deepseek.temperature
    });

    const { sent, reacted } = await this.deliverResponse(channelName, { response, react, replyTo, refs, botMessage });
    if (sent) {
      this.archivist.noteActivity(channelName);
    } else if (!reacted) {
      this.logger.info(`Bot chose silence for direct mention in ${channelName}`);
    }

    this.messageTracker.markResponded(channelName);
    this.cancelEvaluationTimer(channelName);
  }

  /**
   * Cancel a pending evaluation timer for a channel
   * @param {string} channelId - Channel identifier
   */
  cancelEvaluationTimer(channelId) {
    if (this.evaluationTimers.has(channelId)) {
      clearTimeout(this.evaluationTimers.get(channelId).timer);
      this.evaluationTimers.delete(channelId);
      this.logger.debug(`Cancelled evaluation timer for channel ${channelId}`);
    }
  }

  /**
   * Begin sending IRCv3 +typing=active TAGMSGs to a target. Sends one
   * immediately, then refreshes every refresh_seconds (the active state
   * expires client-side after ~6s without renewal). Safe to call repeatedly
   * — restarts the timer.
   * @param {string} target - PRIVMSG target (channel name or nick)
   */
  startTyping(target) {
    const cfg = this.config.irc.typing_notifications;
    if (cfg?.enabled === false) return;
    const refreshMs = (cfg?.refresh_seconds || 3) * 1000;
    // Nobody types for ten minutes. If the model is that slow, the indicator
    // goes to "paused" and stays there until the reply (or its failure).
    const maxMs = (cfg?.max_seconds ?? 300) * 1000;
    const startedAt = Date.now();

    this.stopTyping(target, null); // clear any prior timer without sending done

    const send = () => {
      if (Date.now() - startedAt >= maxMs) {
        this.logger.info(`Still generating for ${target} after ${Math.round(maxMs / 1000)}s; pausing the typing indicator`);
        this.stopTyping(target, "paused");
        return;
      }
      try {
        this.ircClient.tagmsg(target, { "+typing": "active" });
      } catch (err) {
        this.logger.debug(`tagmsg(active) failed for ${target}: ${err.message}`);
      }
    };
    send();
    const id = setInterval(send, refreshMs);
    this.typingTimers.set(target, id);
  }

  /**
   * Stop the typing refresh timer. If status is "done" or "paused", also
   * sends one final TAGMSG. Pass null to suppress the final send (e.g. when
   * about to send the actual PRIVMSG, which implicitly stops the indicator).
   * @param {string} target - PRIVMSG target (channel name or nick)
   * @param {string|null} status - "done", "paused", or null
   */
  stopTyping(target, status = "done") {
    const id = this.typingTimers.get(target);
    if (id) {
      clearInterval(id);
      this.typingTimers.delete(target);
    }
    if (status && this.config.irc.typing_notifications?.enabled !== false) {
      try {
        this.ircClient.tagmsg(target, { "+typing": status });
      } catch (err) {
        this.logger.debug(`tagmsg(${status}) failed for ${target}: ${err.message}`);
      }
    }
  }

  /**
   * Process an autonomous message
   * @param {string} channelName - IRC channel name
   * @param {number|null} decisionId - Optional decision ID that triggered this response
   */
  /**
   * @param {string} channelName
   * @param {number|null} [decisionId]
   * @param {Object} [options]
   * @param {Object} [options.leaving] - The schedule occurrence the bot is
   *   about to go into: this turn is a goodbye (see sayGoodbyes)
   */
  async processAutonomousMessage(channelName, decisionId = null, { leaving = null } = {}) {
    const { dbMessages, imageDescriptions, memory } = this.buildContextFromDatabase(channelName);

    const triggerInfo = {
      userId: null,
      userName: null,
      channelName: channelName,
    };
    const refs = ContextUtils.assignRefs(dbMessages);

    this.startTyping(channelName);
    let response, conversationLog, react, replyTo, systemPrompt;
    try {
      ({ response, conversationLog, react, replyTo, systemPrompt } = await this.generateResponseWithChatCompletions({
        dbMessages,
        userName: "various",
        characterName: this.watchword,
        botUserId: this.botNick.toLowerCase(),
        imageDescriptions,
        memory,
        triggerInfo,
        refs,
        canReact: !leaving && this.canReactNow(channelName),
        leaving,
      }));
      // A PRIVMSG implicitly clears the indicator; a reaction alone doesn't.
      this.stopTyping(channelName, response ? null : "done");
    } catch (err) {
      this.stopTyping(channelName, "done");
      throw err;
    }

    // Empty response = the model decided silence after generation. Skip IRC
    // and chatlog tracking but still log for the dashboard.
    const botMessage = createIrcMessage(this.botNick, channelName, response, {
      isBot: true,
    });

    const responseId = this.db.logResponse(
      channelName,
      botMessage.id,
      leaving ? "goodbye" : "autonomous",
      response,
      null
    );

    this.db.storePrompt({
      responseId,
      promptType: "response",
      systemPrompt,
      messagesJson: conversationLog,
      model: this.config.generator.deepseek.model,
      temperature: this.config.generator.deepseek.temperature
    });

    if (decisionId) {
      this.db.markDecisionResponseSent(decisionId);
    }

    const { sent, reacted } = await this.deliverResponse(channelName, { response, react, replyTo, refs, botMessage });
    if (sent) {
      this.archivist.noteActivity(channelName);
    } else if (!reacted) {
      this.logger.info(`Bot chose silence for autonomous trigger in ${channelName}`);
    }

    this.messageTracker.markResponded(channelName);
    this.cancelEvaluationTimer(channelName);
  }

  /**
   * Whether the reply model may attach a reaction this turn: the server can
   * carry one and he isn't inside the reaction cooldown.
   * @param {string} channelName
   */
  canReactNow(channelName) {
    return this.canSendReactions() && !this.reactionCooldown(channelName).blocked;
  }

  /**
   * Send what the reply model produced: its reaction first, if it asked for
   * one and one is allowed, then its message, sent as an IRCv3 reply when it
   * answers a line buried deep enough (see replyTagFor).
   * @param {string} channelName
   * @param {Object} reply
   * @param {string} reply.response - The message; empty means none
   * @param {{to: string, reaction: string}|null} reply.react
   * @param {string|null} reply.replyTo - Chatlog reference of the line answered
   * @param {Map<string, string>} reply.refs - message id -> reference, as shown to the model
   * @param {Object} reply.botMessage - The message record to send and store
   * @returns {Promise<{sent: boolean, reacted: boolean}>}
   */
  async deliverResponse(channelName, { response, react, replyTo, refs, botMessage }) {
    const byRef = new Map([...refs].map(([id, ref]) => [ref, id]));
    const lineFor = (ref) => {
      const id = typeof ref === "string" ? byRef.get(ref.trim()) : null;
      return id ? this.db.getMessage(id) : null;
    };

    let reacted = false;
    if (react && typeof react === "object") {
      const result = this.sendReaction(channelName, lineFor(react.to), react.reaction);
      reacted = result.sent;
      if (!result.sent) this.logger.info(`Dropping the reply's reaction in ${channelName}: ${result.reason}`);
    }

    if (!response) return { sent: false, reacted };

    const replyTarget = lineFor(replyTo);
    const replyMsgid = replyTarget ? this.replyTagFor(channelName, replyTarget) : null;
    if (replyMsgid) botMessage.reference = { messageId: replyTarget.id };
    await this.sendIrcMessage(channelName, response, { messageId: botMessage.id, replyToMsgid: replyMsgid });
    await this.messageTracker.addMessage(botMessage, { isBotMessage: true, processVision: false });
    return { sent: true, reacted };
  }

  /**
   * The evaluator picked "react": put its reaction on the line it chose
   * (the newest line from someone else if it named none). Where the server
   * or the line can't carry an IRCv3 react, the reaction is said as a
   * plain line instead, the way reactions worked before.
   * @param {string} channelName - IRC channel name
   * @param {Object} item - The queue item
   * @param {number|null} item.decisionId - Decision log id
   * @param {string|null} item.targetMessageId - Message to react to
   * @param {string|null} item.reaction - The reaction
   */
  async processReactMessage(channelName, { decisionId = null, targetMessageId = null, reaction = null } = {}) {
    const target =
      (targetMessageId && this.db.getMessage(targetMessageId)) ||
      this.db.getRecentMessages(channelName, 10, true).reverse().find((m) => !m.is_bot_message) ||
      null;

    const result = this.sendReaction(channelName, target, reaction);
    if (result.sent) {
      if (decisionId) this.db.markDecisionResponseSent(decisionId);
    } else if (result.reason === "unsupported") {
      const botMessage = createIrcMessage(this.botNick, channelName, result.reaction, {
        isBot: true,
      });
      await this.sendIrcMessage(channelName, result.reaction, { messageId: botMessage.id });
      this.db.logResponse(channelName, botMessage.id, "reaction", result.reaction, target?.id || null);
      if (decisionId) this.db.markDecisionResponseSent(decisionId);
      await this.messageTracker.addMessage(botMessage, { isBotMessage: true, processVision: false });
      this.archivist.noteActivity(channelName);
    } else {
      this.logger.info(`Not reacting in ${channelName}: ${result.reason}`);
    }

    this.messageTracker.markResponded(channelName);
    this.cancelEvaluationTimer(channelName);
  }

  /**
   * Send a message to an IRC channel, splitting into multiple lines if needed
   * @param {string} channel - IRC channel name
   * @param {string} text - Message text
   * @param {Object} [options]
   * @param {string} [options.messageId] - The stored message these lines are;
   *   their echoes are matched back to it to learn their msgids
   * @param {string} [options.replyToMsgid] - Send as an IRCv3 reply to this
   *   msgid (on the first line)
   */
  async sendIrcMessage(channel, text, { messageId = null, replyToMsgid = null } = {}) {
    const maxLen = this.config.irc.max_line_length || 350;

    // The bot is told to address users by leading with "nick: " (IRC channel
    // convention). In a 1:1 DM that prefix is just noise, since the only
    // other party in the conversation IS the recipient. Strip it post-hoc
    // rather than complicating the system prompt with another conditional.
    let payload = text;
    if (!channel.startsWith("#")) {
      const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      payload = payload.replace(new RegExp(`^${escaped}[:,]\\s+`, "i"), "");
    }

    const echoes = Boolean(messageId && this.ircClient.network?.cap.isEnabled("echo-message"));

    // With draft/multiline a long reply is one message: a batch of pieces
    // joined with draft/multiline-concat, one msgid, no inter-line delay.
    // Anything the server's limits can't hold falls back to plain lines.
    const limits = this.multilineLimits();
    if (limits) {
      const pieces = splitForConcat(payload, { maxChars: maxLen, maxBytes: ImpostorClient.MULTILINE_PIECE_BYTES });
      const bytes = Buffer.byteLength(pieces.join(""), "utf8");
      if (pieces.length > 1 && pieces.length <= limits.maxLines && bytes <= limits.maxBytes) {
        if (echoes) {
          const key = channel.toLowerCase();
          if (!this.pendingEchoes.has(key)) this.pendingEchoes.set(key, []);
          this.pendingEchoes.get(key).push({ messageId, text: pieces.join(""), sentAt: Date.now() });
        }
        const id = Math.random().toString(36).slice(2, 10);
        const startTags = replyToMsgid ? `@+draft/reply=${replyToMsgid} ` : "";
        this.ircClient.raw(`${startTags}BATCH +${id} draft/multiline ${channel}`);
        pieces.forEach((piece, i) => {
          this.ircClient.raw(`@batch=${id}${i > 0 ? ";draft/multiline-concat" : ""} PRIVMSG ${channel} :${piece}`);
        });
        this.ircClient.raw(`BATCH -${id}`);
        this.presence.noteSent();
        return;
      }
    }

    const lines = splitMessage(payload, maxLen);
    for (let i = 0; i < lines.length; i++) {
      if (echoes) {
        const key = channel.toLowerCase();
        if (!this.pendingEchoes.has(key)) this.pendingEchoes.set(key, []);
        this.pendingEchoes.get(key).push({ messageId, text: lines[i], sentAt: Date.now() });
      }
      const tags = i === 0 && replyToMsgid ? { "+draft/reply": replyToMsgid } : undefined;
      this.ircClient.say(channel, lines[i], tags);
      this.presence.noteSent();
      // Delay between lines to avoid flood protection
      if (i < lines.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  async generateResponseWithChatCompletions({
    dbMessages = null,
    userName,
    characterName,
    botUserId,
    imageDescriptions = null,
    memory = null,
    triggerInfo = null,
    refs = null,
    canReact = true,
    leaving = null,
    spontaneous = null,
  }) {
    // Today's seeds go in every prompt as ON YOUR MIND TODAY; a spontaneous
    // turn lists them in its own instruction instead.
    const systemPrompt = this.contextUtils.buildInstructions(this.presence.describe(undefined, { leaving }), new Date(), {
      onYourMind: spontaneous ? [] : this.todaysSeeds(),
    });
    this.logger.debug("Generated System Prompt...", systemPrompt);

    if (!dbMessages || !triggerInfo) {
      throw new Error("dbMessages and triggerInfo must be provided");
    }
    const inputMessages = this.contextUtils.buildChatMessagesConsolidated(
      dbMessages,
      botUserId,
      triggerInfo,
      imageDescriptions,
      memory,
      {
        refs: refs || undefined,
        canReact,
        leaving: leaving ? leaving.block.activity : null,
        spontaneous,
        whoIsHere: triggerInfo.channelName ? this.roster.describe(triggerInfo.channelName) : null,
        tics: triggerInfo.channelName ? this.ticLedger(triggerInfo.channelName) : null,
      }
    );

    let conversationLog = [
      {
        role: "system",
        content: systemPrompt,
      },
      ...inputMessages,
    ];

    this.logger.debug("Generated Messages...", conversationLog);

    let response = await this.callDeepSeek(conversationLog);
    let structuredResponse = await this.parseStructuredResponse(response);

    let iterationCount = 0;
    const maxIterations = 10;
    let allToolResults = [];

    while (
      structuredResponse.needs_tool &&
      structuredResponse.tool_request &&
      iterationCount < maxIterations
    ) {
      iterationCount++;
      this.logger.info(
        `Tool execution iteration ${iterationCount}:`,
        structuredResponse.tool_request
      );

      const toolResult = await this.executeTool(structuredResponse.tool_request);
      allToolResults.push({
        tool: structuredResponse.tool_request.tool_name,
        success: toolResult.success,
        iteration: iterationCount,
        code: structuredResponse.tool_request.code,
        query: structuredResponse.tool_request.query,
        url: structuredResponse.tool_request.url,
        output: toolResult.output,
        error: toolResult.error,
        reason: structuredResponse.tool_request.reason,
      });

      conversationLog.push({
        role: "assistant",
        content: JSON.stringify(structuredResponse),
      });

      if (structuredResponse.continue_iterating) {
        const iterationSummary = this.buildIterationSummary(
          allToolResults,
          iterationCount
        );
        conversationLog.push({
          role: "user",
          content: `Tool execution result: ${JSON.stringify(toolResult)}

ITERATION HISTORY:
${iterationSummary}

REFLECTION: Look at your previous attempts above. What worked? What didn't? How can you adjust your approach based on the results? If you're close to the target (like 1-2 characters off), make small adjustments. Continue iterating to refine your approach, or provide your final response if satisfied.

Reply with valid JSON in the format described above.`,
        });
      } else {
        conversationLog.push({
          role: "user",
          content: `Tool execution result: ${JSON.stringify(toolResult)}. Now provide your final response with the actual message. Reply with valid JSON in the format described above.`,
        });
      }

      response = await this.callDeepSeek(conversationLog);
      structuredResponse = await this.parseStructuredResponse(response);
    }

    if (iterationCount >= maxIterations) {
      this.logger.warn(
        `Reached maximum iterations (${maxIterations}), stopping tool execution`
      );
    }

    // Empty message field is intentional silence (see system prompt); pass
    // through and let callers decide not to send. callDeepSeek already retries
    // genuine API failures (empty raw content, non-"stop" finish_reason) up
    // front, so anything that reaches here with a blank message is the model's
    // deliberate choice.
    const replyMessage = (structuredResponse.message || "").trim();

    return {
      response: replyMessage,
      conversationLog,
      systemPrompt,
      react: structuredResponse.react || null,
      replyTo: structuredResponse.reply_to || null,
    };
  }

  async callDeepSeek(conversationLog) {
    const maxAttempts = 3;
    let lastResponse = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.openai.chat.completions.create({
        model: this.config.generator.deepseek.model,
        messages: conversationLog,
        max_tokens: this.config.generator.deepseek.max_tokens,
        temperature: this.config.generator.deepseek.temperature,
        // A mild frequency penalty leans against the bot echoing the phrases
        // on its own screen; kept small so the JSON envelope isn't penalised.
        frequency_penalty: this.config.generator.deepseek.frequency_penalty ?? 0.3,
        presence_penalty: this.config.generator.deepseek.presence_penalty ?? 0,
        response_format: { type: "json_object" },
        // Flash thinks by default and its reasoning tokens are drawn from the
        // same max_tokens budget as the JSON reply, so a long think can starve
        // the answer. Only send the param when explicitly turned off.
        ...(this.config.generator.deepseek.thinking === false
          ? { thinking: { type: "disabled" } }
          : {}),
      });

      const choice = response.choices?.[0];
      const content = choice?.message?.content;
      const finishReason = choice?.finish_reason;

      if (content && content.trim() && finishReason === "stop") {
        return response;
      }

      lastResponse = response;
      const reason = !content || !content.trim()
        ? "empty content"
        : `finish_reason=${finishReason}`;
      this.logger.warn(
        `DeepSeek returned bad response (${reason}), attempt ${attempt}/${maxAttempts}`
      );
      // Dump enough detail to diagnose: whitespace-only content looks identical
      // to truly-empty content in plain logs, and DeepSeek sometimes spends all
      // its budget on reasoning_content while emitting blanks for content.
      const reasoningContent = choice?.message?.reasoning_content;
      this.logger.debug("Bad response diagnostics:", {
        id: response.id,
        finish_reason: finishReason,
        content_type: content === null ? "null" : typeof content,
        content_length: typeof content === "string" ? content.length : null,
        content_trimmed_length: typeof content === "string" ? content.trim().length : null,
        content_raw: typeof content === "string" ? JSON.stringify(content) : content,
        reasoning_content_length: typeof reasoningContent === "string" ? reasoningContent.length : null,
        usage: response.usage,
      });

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }

    this.logger.error(
      `DeepSeek failed to return usable response after ${maxAttempts} attempts`,
      {
        last_response_id: lastResponse?.id,
        last_finish_reason: lastResponse?.choices?.[0]?.finish_reason,
        conversation_length: conversationLog.length,
        last_user_message_preview:
          typeof conversationLog[conversationLog.length - 1]?.content === "string"
            ? conversationLog[conversationLog.length - 1].content.slice(0, 300)
            : null,
      }
    );
    return lastResponse;
  }

  async parseStructuredResponse(response) {
    this.logger.info("Received response - ", response);

    const rawResponse = response.choices[0].message.content;

    try {
      const structuredResponse = JSON.parse(rawResponse);
      this.logger.debug("Parsed structured response:", structuredResponse);

      return structuredResponse;
    } catch (error) {
      this.logger.error("Failed to parse JSON response:", error);
      this.logger.debug("Raw response was:", rawResponse);

      return {
        needs_tool: false,
        continue_iterating: false,
        message: rawResponse || "Error parsing response.",
      };
    }
  }

  buildIterationSummary(allToolResults, currentIteration) {
    let summary = "";
    for (let i = 0; i < allToolResults.length; i++) {
      const result = allToolResults[i];
      summary += `Iteration ${result.iteration}:\n`;
      summary += `  Tool: ${result.tool}\n`;
      summary += `  Goal: ${result.reason}\n`;

      if (result.code) {
        summary += `  Code: ${result.code.substring(0, 100)}${result.code.length > 100 ? "..." : ""}\n`;
      } else if (result.query) {
        summary += `  Query: ${result.query}\n`;
      } else if (result.url) {
        summary += `  URL: ${result.url}\n`;
      }

      if (result.success) {
        const outputStr = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
        const truncatedOutput = outputStr.length > 500 ? outputStr.substring(0, 500) + "..." : outputStr;
        summary += `  Result: ${truncatedOutput}\n`;
      } else {
        summary += `  Error: ${result.error}\n`;
      }
      summary += `\n`;
    }
    return summary.trim();
  }

  async executeTool(toolRequest) {
    this.logger.info(
      `Executing ${toolRequest.tool_name} tool:`,
      toolRequest.reason
    );

    let result;
    switch (toolRequest.tool_name) {
      case "python":
        result = await this.pythonTool.executePython(toolRequest.code);
        break;
      case "web_search":
        result = await this.webSearchTool.searchWeb(toolRequest.query);
        break;
      case "web_fetch":
        result = await this.webFetchTool.fetchPage(toolRequest.url);
        break;
      default:
        return {
          success: false,
          output: "",
          error: `Unknown tool: ${toolRequest.tool_name}`,
        };
    }

    this.logger.debug(`${toolRequest.tool_name} result:`, result);
    return result;
  }

  /**
   * Get database instance for web dashboard
   * @returns {DatabaseManager} Database manager instance
   */
  getDatabase() {
    return this.db;
  }

  /** The channels this bot is in, for the director. */
  get channels() {
    return this.config.irc.channels || [];
  }

  /**
   * What the director needs to know about a channel from this bot's side.
   * People who are merely auto-afk count as present: they stopped typing,
   * they didn't leave, and a quiet channel is exactly when they're afk.
   * @param {string} channel
   * @param {Date} [now]
   * @returns {import("./spontaneity").SilenceFacts}
   */
  silenceFacts(channel, now = new Date()) {
    const inChannel = (this.config.irc.channels || []).some((c) => c.toLowerCase() === channel.toLowerCase());
    if (!inChannel) return { inChannel: false };
    const newest = this.db.getRecentMessages(channel, 1)[0];
    return {
      inChannel: true,
      lastLineAt: newest ? new Date(newest.created_at) : null,
      present: this.roster.reachable(channel).length,
      typing: this.roster.someoneTyping(channel, this.director.typingWaitSeconds, now),
      gone: this.presence.gone,
      busy:
        this.generatingChannels.has(channel) ||
        this.evaluationTimers.has(channel) ||
        this.messageQueue.some((item) => item.channel === channel),
    };
  }

  /** The director picked this bot for a quiet channel: queue the turn like any other generation. */
  takeSpontaneousTurn(channel, { quietMinutes, nudged = false }, now = new Date()) {
    this.logger.info(`Queueing a spontaneous line for ${channel} (quiet ${quietMinutes} min${nudged ? ", just back" : ""})`);
    this.messageQueue.push({ channel, type: "spontaneous", quietMinutes, nudged, enqueuedAt: now.getTime() });
    if (!this.isProcessing) this.processMessageQueue();
  }

  /** One look at every channel now (the director normally ticks on its own). */
  checkSilences(now = new Date()) {
    return this.director.tick(now);
  }

  /**
   * What an unprompted turn can draw on besides the screen: a few of the
   * persona's seeds for today, sometimes something looked up from its news
   * queries, and notes on everyone in the channel (not only whoever spoke
   * in the window), so it can ask after someone.
   * @param {string} channelName
   * @param {{journal: string|null, people: Map<string, string>}} memory - Extended in place
   */
  async spontaneousMaterial(channelName, memory) {
    const seeds = this.todaysSeeds();

    let news = null;
    const queries = this.persona.news || [];
    if (this.spontaneity.news && queries.length > 0 && this.spontaneity.random() < this.spontaneity.newsChance) {
      const query = queries[Math.floor(this.spontaneity.random() * queries.length)];
      news = await this.newsDesk.lookup(query);
      if (!news) this.logger.debug(`No news for "${query}"`);
    }

    const people = this.roster.others(channelName);
    const known = new Set([...(memory.people?.keys() || [])].map((n) => n.toLowerCase()));
    const missing = people.filter((nick) => !known.has(nick.toLowerCase()));
    if (missing.length > 0) {
      const notes = this.db.getPeople(missing);
      memory.people = new Map([...(memory.people || []), ...notes]);
    }
    return { seeds, news, people };
  }

  /**
   * A few of the persona's seeds for today (`seeds_per_day`), in every
   * prompt as ON YOUR MIND TODAY and in a spontaneous turn's material. The
   * day's order is fixed by bot id and date; the window slides one along
   * for each unprompted line spoken today, so a seed already used drops off.
   * @param {Date} [now]
   */
  todaysSeeds(now = new Date()) {
    const day = localParts(now, this.contextUtils.timezone);
    const dateKey = `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
    return seedsForDay(this.persona.seeds, `${this.id}|${dateKey}`, this.spontaneity.seedsPerDay, this.spontaneity.spokenInLastDay(now));
  }

  /**
   * The tic ledger for a conversation (see classes/tics.js): the phrases,
   * emoji and line shapes this bot has been repeating in its last
   * `context.tic_lines` lines there, as the prompt block, or null.
   * @param {string} channelId
   */
  ticLedger(channelId) {
    const lines = this.config.context?.tic_lines ?? 30;
    if (lines <= 0) return null;
    try {
      const ledger = findTics(this.db.getRecentBotLines(channelId, lines), {
        reactions: this.db.getRecentBotReactions(channelId, 10),
      });
      return ticLedgerText(ledger);
    } catch (err) {
      this.logger.warn(`Tic ledger for ${channelId} failed: ${err.message}`);
      return null;
    }
  }

  /**
   * The director offered this bot the floor: ask the reply model for an
   * unprompted line, with material to speak from. An empty message is
   * allowed and ends the turn quietly.
   * @param {string} channelName
   * @param {{quietMinutes: number, nudged?: boolean}} item
   */
  async processSpontaneousMessage(channelName, { quietMinutes }) {
    const { dbMessages, imageDescriptions, memory } = this.buildContextFromDatabase(channelName);
    const triggerInfo = { userId: null, userName: null, channelName };
    const refs = ContextUtils.assignRefs(dbMessages);
    let sent = false;
    let news = null;
    try {
      const material = await this.spontaneousMaterial(channelName, memory);
      news = material.news;
      const { seeds, people } = material;
      const { response, conversationLog, react, replyTo, systemPrompt } = await this.generateResponseWithChatCompletions({
        dbMessages,
        userName: "various",
        characterName: this.watchword,
        botUserId: this.botNick.toLowerCase(),
        imageDescriptions,
        memory,
        triggerInfo,
        refs,
        canReact: false,
        spontaneous: { quietMinutes, seeds, news, people },
      });
      const botMessage = createIrcMessage(this.botNick, channelName, response, { isBot: true });
      const responseId = this.db.logResponse(channelName, botMessage.id, "spontaneous", response, null);
      this.db.storePrompt({
        responseId,
        promptType: "response",
        systemPrompt,
        messagesJson: conversationLog,
        model: this.config.generator.deepseek.model,
        temperature: this.config.generator.deepseek.temperature,
      });
      if (response) this.startTyping(channelName);
      try {
        ({ sent } = await this.deliverResponse(channelName, { response, react, replyTo, refs, botMessage }));
      } finally {
        this.stopTyping(channelName, sent ? null : "done");
      }
      this.db.logDecision(
        channelName,
        dbMessages.length,
        sent,
        null,
        `[spontaneous] ${sent ? "spoke" : "stayed quiet"} after ${quietMinutes} quiet minutes${news ? ` (saw: "${news.query}")` : ""}`,
        dbMessages.map((m) => m.id)
      );
      if (sent) this.archivist.noteActivity(channelName);
      else this.logger.info(`Nothing to say into the quiet in ${channelName}`);
    } finally {
      if (sent) this.spontaneity.spoke();
      this.director.release(channelName, this.id, sent);
    }
  }

  /** What the dashboard shows for this bot. */
  describe() {
    return {
      id: this.id,
      nick: this.botNick,
      name: this.persona.name,
      channels: this.config.irc.channels,
      connected: Boolean(this.ircClient?.connected),
      presence: this.presence.snapshot(),
      spontaneous: this.spontaneity.snapshot(),
      on_your_mind: this.todaysSeeds(),
      silences: this.ownDirector ? this.director.snapshot() : undefined,
    };
  }

  /**
   * Set or clear the IRC away status (null clears). Nothing is sent while
   * disconnected; the registered handler puts the status back.
   * @param {string|null} message
   */
  setAway(message) {
    if (!this.ircClient?.connected) return;
    if (message) {
      this.logger.info(`Away status: ${message}`);
      this.ircClient.raw("AWAY", message);
    } else {
      this.logger.info("Away status cleared");
      this.ircClient.raw("AWAY");
    }
  }

  /**
   * The bot is about to go (bed, class). In every channel that has been
   * live in the last few minutes, ask the evaluator whether vanishing
   * silently would be odd, and if so say goodbye through the usual reply
   * pipeline. Pending evaluations are dropped: the lines they covered get
   * looked at again on return.
   * @param {Object} occurrence - The schedule occurrence being entered
   */
  async sayGoodbyes(occurrence) {
    const windowMinutes = this.config.presence?.goodbye_window_minutes ?? 10;
    const since = this.presence.clock().getTime() - windowMinutes * 60000;
    for (const channel of this.config.irc.channels || []) {
      try {
        if (this.generatingChannels.has(channel)) continue;
        const recent = this.db.getRecentMessages(channel, 50, true);
        const live = recent.some((m) => !m.is_bot_message && new Date(m.created_at).getTime() >= since);
        if (!live) continue;
        this.cancelEvaluationTimer(channel);
        const decision = await this.evaluator.shouldRespond(
          this.screenFor(channel),
          this.botNick.toLowerCase(),
          channel,
          null,
          {
            journal: this.db.getJournalText(channel),
            canReact: false,
            presence: this.presence.describe(undefined, { leaving: occurrence }),
            whoIsHere: this.roster.describe(channel),
            leaving: occurrence.block.activity,
          }
        );
        if (decision.action !== "respond") continue;
        this.generatingChannels.add(channel);
        try {
          await this.processAutonomousMessage(channel, decision.decisionId, { leaving: occurrence });
        } finally {
          this.generatingChannels.delete(channel);
        }
      } catch (err) {
        this.logger.error(`Goodbye in ${channel} failed: ${err.message}`);
      }
    }
    for (const channelId of [...this.evaluationTimers.keys()]) {
      this.cancelEvaluationTimer(channelId);
      this.presence.notePending(channelId);
    }
  }

  /**
   * The bot is back. Conversations that moved while it was gone get a
   * normal evaluation (the screen shows what it missed); DMs from people
   * it answers get a reply to their latest line. What moved is read from
   * the database, not just the in-memory list, so a restart mid-block
   * (the block's edges are the same after it) loses nothing.
   * @param {Object|null} occurrence - The occurrence that just ended
   * @param {Map<string, {addressed: boolean, dm: boolean}>} pending
   */
  catchUp(occurrence, pending) {
    // A quiet channel is the natural moment for "morning" / "ugh, class".
    for (const channel of this.config.irc.channels || []) this.spontaneity.nudge(channel);
    const missed = new Map(pending);
    if (occurrence?.start) {
      for (const m of this.db.getHumanMessagesSince(occurrence.start)) {
        const dm = !m.channel_id.startsWith("#");
        const entry = missed.get(m.channel_id) || { addressed: false, dm };
        entry.addressed = entry.addressed || dm || this.mentionsBot(m.content);
        missed.set(m.channel_id, entry);
      }
    }
    for (const [conversationId, { addressed, dm }] of missed) {
      if (dm) {
        if (!this.isAllowedPmSender(conversationId)) continue;
        const theirs = this.db.getRecentMessages(conversationId, 10, true).filter((m) => !m.is_bot_message);
        const last = theirs[theirs.length - 1];
        if (!last) continue;
        const message = {
          id: last.id,
          author: { id: last.author_id, username: last.author_name },
          content: last.content,
        };
        this.messageQueue.push({ message, channel: conversationId, type: "direct" });
        if (!this.isProcessing) this.processMessageQueue();
      } else if (this.config.autonomous?.enabled) {
        this.scheduleAutonomousEvaluation(conversationId, { addressed });
      }
    }
  }

  /**
   * Cleanup resources on shutdown
   */
  shutdown() {
    this.shuttingDown = true;
    this.presence.stop();
    this.director.unregister(this);
    if (this.ownDirector) this.director.stop();
    this.archivist.shutdown();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
    }
    for (const { timer } of this.evaluationTimers.values()) {
      clearTimeout(timer);
    }
    this.evaluationTimers.clear();

    for (const target of [...this.typingTimers.keys()]) {
      this.stopTyping(target, "done");
    }

    if (this.ircClient) {
      this.ircClient.quit("Shutting down...");
    }

    if (this.db) {
      this.db.close();
    }
    this.logger.info("ImpostorClient shutdown complete");
  }
}

module.exports = ImpostorClient;
