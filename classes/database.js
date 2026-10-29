const Database = require("better-sqlite3");
const path = require("path");

class DatabaseManager {
  constructor(logger, dbPath = null) {
    this.logger = logger;
    this.dbPath = dbPath || path.join(__dirname, "..", "data", "impostor.db");
    this.db = null;
  }

  initialize() {
    // Ensure data directory exists
    const fs = require("fs");
    const dataDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");

    this.createTables();
    this.runMigrations();
    this.logger.info(`Database initialized at ${this.dbPath}`);
  }

  runMigrations() {
    // The remember tool and its per-nick fact rows are gone; the Archivist
    // keeps a journal per conversation and a note per person instead. Both
    // legacy shapes (hostmask-keyed with a users table, then nick-keyed) are
    // dropped the first time a database from before the journal starts.
    this.db.exec(`DROP TABLE IF EXISTS user_memories`);
    this.db.exec(`DROP TABLE IF EXISTS users`);

    // One journal per conversation (channel or DM partner), rewritten whole by
    // each Archivist pass. watermark_rowid is the messages rowid the pass last
    // read up to, so a restart or a backlog picks up exactly where it left off.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journals (
        conversation_id TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        watermark_rowid INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        rationale TEXT,
        created_at DATETIME NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_journal_versions_conversation ON journal_versions(conversation_id, id)
    `);

    // One note per nick (lowercased for the key, display nick kept), shared
    // across the bot's conversations.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        nick_key TEXT PRIMARY KEY,
        nick TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS people_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nick_key TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        rationale TEXT,
        created_at DATETIME NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_people_versions_nick ON people_versions(nick_key, id)
    `);

    // Migration: Add enhanced message columns
    const messageColumns = this.db.pragma("table_info(messages)");
    const columnNames = messageColumns.map(c => c.name);

    if (!columnNames.includes("attachments")) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`);
      this.logger.info("Migration: Added attachments column to messages");
    }

    if (!columnNames.includes("vision_descriptions")) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN vision_descriptions TEXT`);
      this.logger.info("Migration: Added vision_descriptions column to messages");
    }

    if (!columnNames.includes("reply_to_message_id")) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
      this.logger.info("Migration: Added reply_to_message_id column to messages");
    }

    if (!columnNames.includes("channel_name")) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN channel_name TEXT`);
      this.logger.info("Migration: Added channel_name column to messages");
    }

    // Migration: Add trigger_message_id to responses
    const responsesColumns = this.db.pragma("table_info(responses)");
    const responsesColumnNames = responsesColumns.map(c => c.name);

    if (!responsesColumnNames.includes("trigger_message_id")) {
      this.db.exec(`ALTER TABLE responses ADD COLUMN trigger_message_id TEXT`);
      this.logger.info("Migration: Added trigger_message_id column to responses");
    }

    // Migration: Add evaluated_message_ids to decision_log
    const decisionColumns = this.db.pragma("table_info(decision_log)");
    const decisionColumnNames = decisionColumns.map(c => c.name);

    if (!decisionColumnNames.includes("evaluated_message_ids")) {
      this.db.exec(`ALTER TABLE decision_log ADD COLUMN evaluated_message_ids TEXT`);
      this.logger.info("Migration: Added evaluated_message_ids column to decision_log");
    }

    // Create prompts table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        response_id INTEGER,
        decision_id INTEGER,
        prompt_type TEXT NOT NULL,
        system_prompt TEXT,
        messages_json TEXT NOT NULL,
        model TEXT,
        temperature REAL,
        created_at DATETIME NOT NULL
      )
    `);

    // Create index for prompts
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_prompts_response ON prompts(response_id);
      CREATE INDEX IF NOT EXISTS idx_prompts_decision ON prompts(decision_id);
    `);

    // What each call cost: the token counts the API reports (with the
    // prefix-cache split) and how long it took, so spend per bot and per
    // kind of call can be read off the dashboard. conversation_id is for
    // calls with neither a response nor a decision (the Archivist).
    const promptColumns = this.db.pragma("table_info(prompts)").map((c) => c.name);
    for (const [name, type] of [
      ["conversation_id", "TEXT"],
      ["prompt_tokens", "INTEGER"],
      ["completion_tokens", "INTEGER"],
      ["cache_hit_tokens", "INTEGER"],
      ["cache_miss_tokens", "INTEGER"],
      ["reasoning_tokens", "INTEGER"],
      ["duration_ms", "INTEGER"],
    ]) {
      if (!promptColumns.includes(name)) {
        this.db.exec(`ALTER TABLE prompts ADD COLUMN ${name} ${type}`);
        this.logger.info(`Migration: Added ${name} column to prompts`);
      }
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_created ON prompts(created_at)`);

    // Migration: Add url_summaries column to messages
    if (!columnNames.includes("url_summaries")) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN url_summaries TEXT`);
      this.logger.info("Migration: Added url_summaries column to messages");
    }

    // The server's IRCv3 msgid for each stored message, which is what reacts
    // and reply tags point at. A message can have several: the bot's long
    // replies go out as several PRIVMSGs, each echoed back with its own. The
    // first one (lowest rowid) is the one the bot points at. No foreign key:
    // the echo of a bot line can arrive before the line is stored.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_msgids (
        msgid TEXT PRIMARY KEY,
        message_id TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_message_msgids_message ON message_msgids(message_id)
    `);

    // IRCv3 reactions (+draft/react TAGMSGs), the bot's own and everyone
    // else's, keyed by the msgid they were attached to. Not messages: they
    // never count toward cooldowns or the bot ratio.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        target_msgid TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        reaction TEXT NOT NULL,
        is_bot_message BOOLEAN DEFAULT FALSE,
        created_at DATETIME NOT NULL
      )
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_unique ON reactions(target_msgid, author_id, reaction);
      CREATE INDEX IF NOT EXISTS idx_reactions_channel ON reactions(channel_id, created_at);
    `);
  }

  createTables() {
    // Track all messages for context
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME NOT NULL,
        is_bot_message BOOLEAN DEFAULT FALSE
      )
    `);

    // Log all decision evaluations
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decision_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        evaluated_at DATETIME NOT NULL,
        messages_evaluated INTEGER,
        should_respond BOOLEAN,
        reply_to_message_id TEXT,
        reason TEXT,
        response_sent BOOLEAN DEFAULT FALSE
      )
    `);

    // Track bot responses
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        response_type TEXT,
        content TEXT,
        created_at DATETIME NOT NULL
      )
    `);

    // Create indexes for common queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_decisions_channel ON decision_log(channel_id, evaluated_at);
      CREATE INDEX IF NOT EXISTS idx_responses_channel ON responses(channel_id, created_at);
    `);
  }

  // Message operations
  insertMessage(message, isBotMessage = false) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, channel_id, author_id, author_name, content, created_at, is_bot_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      message.id,
      message.channel.id,
      message.author.id,
      message.author.username || "Unknown",
      message.content,
      message.createdAt.toISOString(),
      isBotMessage ? 1 : 0
    );
  }

  /**
   * Enhanced message insertion with attachments and vision
   * @param {Object} options - Message data options
   */
  insertMessageEnhanced({
    id,
    channelId,
    channelName = null,
    authorId,
    authorName,
    content,
    createdAt,
    isBotMessage = false,
    attachments = null,
    visionDescriptions = null,
    urlSummaries = null,
    replyToMessageId = null
  }) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, channel_id, channel_name, author_id, author_name, content, created_at,
        is_bot_message, attachments, vision_descriptions, url_summaries, reply_to_message_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      channelId,
      channelName,
      authorId,
      authorName,
      content,
      createdAt instanceof Date ? createdAt.toISOString() : createdAt,
      isBotMessage ? 1 : 0,
      attachments ? JSON.stringify(attachments) : null,
      visionDescriptions ? JSON.stringify(visionDescriptions) : null,
      urlSummaries ? JSON.stringify(urlSummaries) : null,
      replyToMessageId
    );
  }

  /**
   * Check if a message already exists in the database
   * @param {string} messageId - Message ID
   * @returns {boolean} True if message exists
   */
  messageExists(messageId) {
    const stmt = this.db.prepare(`SELECT 1 FROM messages WHERE id = ?`);
    return stmt.get(messageId) !== undefined;
  }

  /**
   * Update vision descriptions for an existing message
   * @param {string} messageId - Message ID
   * @param {string[]} visionDescriptions - Array of vision descriptions
   */
  updateMessageVision(messageId, visionDescriptions) {
    const stmt = this.db.prepare(`
      UPDATE messages SET vision_descriptions = ? WHERE id = ?
    `);
    stmt.run(JSON.stringify(visionDescriptions), messageId);
  }

  /**
   * Update URL summaries for an existing message
   * @param {string} messageId - Message ID
   * @param {Array} urlSummaries - Array of URL summary objects
   */
  updateMessageUrlSummaries(messageId, urlSummaries) {
    const stmt = this.db.prepare(`
      UPDATE messages SET url_summaries = ? WHERE id = ?
    `);
    stmt.run(JSON.stringify(urlSummaries), messageId);
  }

  /**
   * Update channel name for all messages in a channel
   * @param {string} channelId - Channel ID
   * @param {string} channelName - Channel name
   */
  updateChannelName(channelId, channelName) {
    const stmt = this.db.prepare(`
      UPDATE messages SET channel_name = ? WHERE channel_id = ? AND (channel_name IS NULL OR channel_name != ?)
    `);
    stmt.run(channelName, channelId, channelName);
  }

  /**
   * Get a single message by ID with parsed JSON fields
   * @param {string} messageId - Message ID
   * @returns {Object|null} Message object with parsed attachments and vision
   */
  getMessage(messageId) {
    const stmt = this.db.prepare(`SELECT * FROM messages WHERE id = ?`);
    const msg = stmt.get(messageId);
    if (msg) {
      return this._parseMessageRecord(msg);
    }
    return null;
  }

  /**
   * Get a message with all related data (decision, response, prompt)
   * @param {string} messageId - Message ID
   * @returns {Object|null} Message with relations
   */
  getMessageWithRelations(messageId) {
    const message = this.getMessage(messageId);
    if (!message) return null;

    // Find if this message triggered a response
    const responseStmt = this.db.prepare(`
      SELECT * FROM responses WHERE trigger_message_id = ?
    `);
    const response = responseStmt.get(messageId);

    // Find if this message was part of a decision evaluation
    const decisionStmt = this.db.prepare(`
      SELECT * FROM decision_log
      WHERE evaluated_message_ids LIKE ?
      ORDER BY evaluated_at DESC
      LIMIT 1
    `);
    const decision = decisionStmt.get(`%"${messageId}"%`);

    // Get any related prompts
    let responsePrompt = null;
    let decisionPrompt = null;

    if (response) {
      const promptStmt = this.db.prepare(`
        SELECT * FROM prompts WHERE response_id = ?
      `);
      responsePrompt = promptStmt.get(response.id);
      if (responsePrompt) {
        responsePrompt.messages_json = JSON.parse(responsePrompt.messages_json || "[]");
      }
    }

    if (decision) {
      const promptStmt = this.db.prepare(`
        SELECT * FROM prompts WHERE decision_id = ?
      `);
      decisionPrompt = promptStmt.get(decision.id);
      if (decisionPrompt) {
        decisionPrompt.messages_json = JSON.parse(decisionPrompt.messages_json || "[]");
      }
      if (decision.evaluated_message_ids) {
        decision.evaluated_message_ids = JSON.parse(decision.evaluated_message_ids);
      }
    }

    return {
      message,
      response,
      decision,
      responsePrompt,
      decisionPrompt
    };
  }

  /**
   * Get comprehensive details for a bot message
   * Returns the response, decision that led to it, prompts, and evaluated messages
   * @param {string} messageId - Message ID of the bot's response
   * @returns {Object|null} Bot message details
   */
  getBotMessageDetails(messageId) {
    const message = this.getMessage(messageId);
    if (!message || !message.is_bot_message) return null;

    // 1. Get the response record where message_id matches the bot's message ID
    const responseStmt = this.db.prepare(`
      SELECT * FROM responses WHERE message_id = ?
    `);
    const response = responseStmt.get(messageId);

    if (!response) {
      // Bot message without a response record - return basic info
      return {
        message,
        response: null,
        decision: null,
        decisionPrompt: null,
        responsePrompt: null,
        evaluatedMessages: []
      };
    }

    // 2. Find the decision that led to this response
    // For AUTONOMOUS responses: find decision with response_sent = 1, same channel, close timestamp
    // For DIRECT responses: there may not be a decision (direct mention/reply)
    let decision = null;
    let decisionPrompt = null;
    let evaluatedMessages = [];

    if (response.response_type === 'autonomous') {
      const decisionStmt = this.db.prepare(`
        SELECT * FROM decision_log
        WHERE channel_id = ? AND response_sent = 1
        AND datetime(evaluated_at) <= datetime(?, '+10 seconds')
        AND datetime(evaluated_at) >= datetime(?, '-60 seconds')
        ORDER BY evaluated_at DESC LIMIT 1
      `);
      decision = decisionStmt.get(response.channel_id, response.created_at, response.created_at);

      if (decision) {
        // Parse evaluated_message_ids
        if (decision.evaluated_message_ids) {
          try {
            decision.evaluated_message_ids = JSON.parse(decision.evaluated_message_ids);
          } catch (e) {
            decision.evaluated_message_ids = [];
          }
        }

        // Get decision prompt
        const decisionPromptStmt = this.db.prepare(`
          SELECT * FROM prompts WHERE decision_id = ?
        `);
        decisionPrompt = decisionPromptStmt.get(decision.id);
        if (decisionPrompt) {
          decisionPrompt.messages_json = JSON.parse(decisionPrompt.messages_json || "[]");
        }

        // Get the evaluated messages
        if (decision.evaluated_message_ids && decision.evaluated_message_ids.length > 0) {
          const placeholders = decision.evaluated_message_ids.map(() => '?').join(',');
          const evalMsgsStmt = this.db.prepare(`
            SELECT id, author_name, content, created_at, is_bot_message
            FROM messages WHERE id IN (${placeholders})
          `);
          const fetchedMsgs = evalMsgsStmt.all(...decision.evaluated_message_ids);

          // Sort by the order they appear in evaluated_message_ids
          const msgMap = new Map(fetchedMsgs.map(m => [m.id, m]));
          evaluatedMessages = decision.evaluated_message_ids
            .map(id => msgMap.get(id))
            .filter(m => m != null);
        }
      }
    }

    // 3. Get response prompt
    let responsePrompt = null;
    const responsePromptStmt = this.db.prepare(`
      SELECT * FROM prompts WHERE response_id = ?
    `);
    responsePrompt = responsePromptStmt.get(response.id);
    if (responsePrompt) {
      responsePrompt.messages_json = JSON.parse(responsePrompt.messages_json || "[]");
    }

    return {
      message,
      response,
      decision,
      decisionPrompt,
      responsePrompt,
      evaluatedMessages
    };
  }

  /**
   * Parse a message record from the database
   * @param {Object} record - Raw database record
   * @returns {Object} Parsed message object
   */
  _parseMessageRecord(record) {
    return {
      ...record,
      attachments: record.attachments ? JSON.parse(record.attachments) : null,
      vision_descriptions: record.vision_descriptions ? JSON.parse(record.vision_descriptions) : null,
      url_summaries: record.url_summaries ? JSON.parse(record.url_summaries) : null,
      is_bot_message: !!record.is_bot_message
    };
  }

  getRecentMessages(channelId, limit = 50, parseJson = false) {
    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE channel_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      ) ORDER BY created_at ASC
    `);
    const messages = stmt.all(channelId, limit);
    if (parseJson) {
      return this.attachThreading(messages.map(msg => this._parseMessageRecord(msg)));
    }
    return messages;
  }

  /**
   * The bot's own last `limit` lines in a conversation, oldest first, as
   * strings: what the tic ledger reads (classes/tics.js).
   */
  getRecentBotLines(channelId, limit = 30) {
    return this.db
      .prepare(`
        SELECT content FROM (
          SELECT content, created_at FROM messages
          WHERE channel_id = ? AND is_bot_message = 1
          ORDER BY created_at DESC
          LIMIT ?
        ) ORDER BY created_at ASC
      `)
      .all(channelId, limit)
      .map((row) => row.content);
  }

  /** The bot's own last `limit` reactions in a conversation, newest first, as strings. */
  getRecentBotReactions(channelId, limit = 10) {
    return this.db
      .prepare(`SELECT reaction FROM reactions WHERE channel_id = ? AND is_bot_message = 1 ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(channelId, limit)
      .map((row) => row.reaction);
  }

  // IRCv3 msgids, reactions and replies

  /** Record that the server knows this message as `msgid`. */
  addMsgid(messageId, msgid) {
    this.db.prepare(`INSERT OR IGNORE INTO message_msgids (msgid, message_id) VALUES (?, ?)`)
      .run(msgid, messageId);
  }

  /** The msgid to point a react or reply at, or null when the server never gave one. */
  getMsgidFor(messageId) {
    const row = this.db.prepare(`
      SELECT msgid FROM message_msgids WHERE message_id = ? ORDER BY rowid ASC LIMIT 1
    `).get(messageId);
    return row ? row.msgid : null;
  }

  /** The stored message a msgid belongs to, or null. */
  getMessageByMsgid(msgid) {
    const row = this.db.prepare(`
      SELECT m.* FROM message_msgids mm JOIN messages m ON m.id = mm.message_id WHERE mm.msgid = ?
    `).get(msgid);
    return row ? this._parseMessageRecord(row) : null;
  }

  /**
   * Store a reaction. The same person attaching the same reaction to the
   * same line twice is one reaction.
   */
  addReaction({ channelId, targetMsgid, authorId, authorName, reaction, isBotMessage = false, createdAt = new Date() }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO reactions (channel_id, target_msgid, author_id, author_name, reaction, is_bot_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      channelId,
      targetMsgid,
      authorId,
      authorName,
      reaction,
      isBotMessage ? 1 : 0,
      createdAt instanceof Date ? createdAt.toISOString() : createdAt
    );
  }

  /** Remove a reaction (+draft/unreact). */
  removeReaction(targetMsgid, authorId, reaction) {
    this.db.prepare(`
      DELETE FROM reactions WHERE target_msgid = ? AND author_id = ? AND reaction = ?
    `).run(targetMsgid, authorId, reaction);
  }

  /** Whether the bot has already reacted to this msgid. */
  hasBotReaction(targetMsgid) {
    return this.db.prepare(`
      SELECT 1 FROM reactions WHERE target_msgid = ? AND is_bot_message = 1
    `).get(targetMsgid) !== undefined;
  }

  /** The bot's most recent reaction in a conversation, or null. */
  getLastBotReaction(channelId) {
    return this.db.prepare(`
      SELECT * FROM reactions WHERE channel_id = ? AND is_bot_message = 1
      ORDER BY created_at DESC LIMIT 1
    `).get(channelId) || null;
  }

  /** How many messages other people have sent in a conversation after a time. */
  countHumanMessagesSince(channelId, since) {
    return this.db.prepare(`
      SELECT COUNT(*) AS count FROM messages
      WHERE channel_id = ? AND is_bot_message = 0 AND created_at > ?
    `).get(channelId, since instanceof Date ? since.toISOString() : since).count;
  }

  /**
   * How many messages were stored in a conversation after this one, i.e.
   * how deep it is buried. Null when the message is unknown.
   */
  countMessagesAfter(channelId, messageId) {
    const target = this.db.prepare(`SELECT rowid FROM messages WHERE id = ?`).get(messageId);
    if (!target) return null;
    return this.countMessagesAfterRowid(channelId, target.rowid);
  }

  /**
   * Fill in what IRCv3 adds to a parsed message: its msgid (`msgid`), the
   * reactions on it (`reactions`, [{nick, reaction, is_bot}]) and, when it
   * was sent as a reply, the line it answers (`reply_to`, {author_name,
   * is_bot_message, content}). Mutates and returns the list.
   * @param {Array} messages - Parsed message records
   */
  attachThreading(messages) {
    if (!messages || messages.length === 0) return messages;
    const ids = messages.map((m) => m.id);
    const marks = ids.map(() => "?").join(",");

    const msgids = new Map();
    for (const row of this.db.prepare(`
      SELECT msgid, message_id FROM message_msgids WHERE message_id IN (${marks}) ORDER BY rowid ASC
    `).all(...ids)) {
      if (!msgids.has(row.message_id)) msgids.set(row.message_id, row.msgid);
    }

    const reactions = new Map();
    for (const row of this.db.prepare(`
      SELECT r.author_name, r.reaction, r.is_bot_message, mm.message_id
      FROM reactions r JOIN message_msgids mm ON mm.msgid = r.target_msgid
      WHERE mm.message_id IN (${marks})
      ORDER BY r.created_at ASC
    `).all(...ids)) {
      if (!reactions.has(row.message_id)) reactions.set(row.message_id, []);
      reactions.get(row.message_id).push({
        nick: row.author_name,
        reaction: row.reaction,
        is_bot: !!row.is_bot_message,
      });
    }

    const replyIds = [...new Set(messages.map((m) => m.reply_to_message_id).filter(Boolean))];
    const replyTargets = new Map();
    if (replyIds.length > 0) {
      for (const row of this.db.prepare(`
        SELECT id, author_name, is_bot_message, content FROM messages WHERE id IN (${replyIds.map(() => "?").join(",")})
      `).all(...replyIds)) {
        replyTargets.set(row.id, {
          author_name: row.author_name,
          is_bot_message: !!row.is_bot_message,
          content: row.content,
        });
      }
    }

    for (const m of messages) {
      m.msgid = msgids.get(m.id) || null;
      m.reactions = reactions.get(m.id) || [];
      m.reply_to = (m.reply_to_message_id && replyTargets.get(m.reply_to_message_id)) || null;
    }
    return messages;
  }

  getMessagesSinceLastBotResponse(channelId) {
    // Get the timestamp of the last bot response
    const lastResponseStmt = this.db.prepare(`
      SELECT created_at FROM messages
      WHERE channel_id = ? AND is_bot_message = 1
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const lastResponse = lastResponseStmt.get(channelId);

    if (lastResponse) {
      const stmt = this.db.prepare(`
        SELECT * FROM messages
        WHERE channel_id = ? AND created_at > ?
        ORDER BY created_at ASC
      `);
      return stmt.all(channelId, lastResponse.created_at);
    } else {
      // No bot response yet, get recent messages
      const stmt = this.db.prepare(`
        SELECT * FROM (
          SELECT * FROM messages
          WHERE channel_id = ?
          ORDER BY created_at DESC
          LIMIT 50
        ) ORDER BY created_at ASC
      `);
      return stmt.all(channelId);
    }
  }

  getLastBotResponseTime(channelId) {
    const stmt = this.db.prepare(`
      SELECT created_at FROM messages
      WHERE channel_id = ? AND is_bot_message = 1
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const result = stmt.get(channelId);
    return result ? new Date(result.created_at) : null;
  }

  /**
   * Every human line since an instant, oldest first, across all
   * conversations. What the bot missed while it was away.
   * @param {Date|string} since
   */
  getHumanMessagesSince(since) {
    const iso = since instanceof Date ? since.toISOString() : String(since);
    return this.db.prepare(`
      SELECT id, channel_id, author_id, author_name, content, created_at FROM messages
      WHERE created_at > ? AND is_bot_message = 0
      ORDER BY created_at ASC
    `).all(iso);
  }

  // Clean up old messages to prevent unbounded growth
  pruneOldMessages(maxMessagesPerChannel = 1000) {
    // Get all distinct channel IDs
    const channels = this.db.prepare(`SELECT DISTINCT channel_id FROM messages`).all();

    for (const { channel_id } of channels) {
      const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM messages WHERE channel_id = ?`);
      const { count } = countStmt.get(channel_id);

      // Lines the Archivist has not read yet are kept however many there
      // are (a long model outage must not cost the journal its backlog).
      // Only conversations with a journal row are protected, so a DM the
      // bot never answers is still bounded.
      const journal = this.getJournal(channel_id);
      const unread = journal ? this.countMessagesAfterRowid(channel_id, journal.watermark_rowid) : 0;
      const keep = Math.max(maxMessagesPerChannel, unread);

      if (count > keep) {
        const deleteStmt = this.db.prepare(`
          DELETE FROM messages
          WHERE channel_id = ? AND id NOT IN (
            SELECT id FROM messages
            WHERE channel_id = ?
            ORDER BY rowid DESC
            LIMIT ?
          )
        `);
        deleteStmt.run(channel_id, channel_id, keep);
        this.logger.debug(`Pruned old messages from channel ${channel_id}`);
      }
    }

    // msgids of pruned messages go with them, and so do the reactions on
    // them. A reaction whose line was never stored is kept for a day in case
    // the line is still on its way in (a link being summarized).
    this.db.exec(`DELETE FROM message_msgids WHERE message_id NOT IN (SELECT id FROM messages)`);
    this.db.prepare(`
      DELETE FROM reactions
      WHERE target_msgid NOT IN (SELECT msgid FROM message_msgids) AND created_at < ?
    `).run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  }

  // Decision log operations
  logDecision(channelId, messagesEvaluated, shouldRespond, replyToMessageId, reason, evaluatedMessageIds = null) {
    const stmt = this.db.prepare(`
      INSERT INTO decision_log (channel_id, evaluated_at, messages_evaluated, should_respond, reply_to_message_id, reason, response_sent, evaluated_message_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      channelId,
      new Date().toISOString(),
      messagesEvaluated,
      shouldRespond ? 1 : 0,
      replyToMessageId || null,
      reason,
      0,
      evaluatedMessageIds ? JSON.stringify(evaluatedMessageIds) : null
    );

    return result.lastInsertRowid;
  }

  markDecisionResponseSent(decisionId) {
    const stmt = this.db.prepare(`
      UPDATE decision_log SET response_sent = 1 WHERE id = ?
    `);
    stmt.run(decisionId);
  }

  getRecentDecisions(limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM decision_log
      ORDER BY evaluated_at DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  getDecisionsByChannel(channelId, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM decision_log
      WHERE channel_id = ?
      ORDER BY evaluated_at DESC
      LIMIT ?
    `);
    return stmt.all(channelId, limit);
  }

  getLastEvaluationTime(channelId) {
    const stmt = this.db.prepare(`
      SELECT evaluated_at FROM decision_log
      WHERE channel_id = ?
      ORDER BY evaluated_at DESC
      LIMIT 1
    `);
    const result = stmt.get(channelId);
    return result ? new Date(result.evaluated_at) : null;
  }

  // Response operations
  logResponse(channelId, messageId, responseType, content, triggerMessageId = null) {
    const stmt = this.db.prepare(`
      INSERT INTO responses (channel_id, message_id, response_type, content, created_at, trigger_message_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      channelId,
      messageId,
      responseType,
      content,
      new Date().toISOString(),
      triggerMessageId
    );

    return result.lastInsertRowid;
  }

  getRecentResponses(limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM responses
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  getResponsesByChannel(channelId, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM responses
      WHERE channel_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(channelId, limit);
  }

  /**
   * Get a response by ID
   * @param {number} responseId - Response ID
   * @returns {Object|null} Response object
   */
  getResponse(responseId) {
    const stmt = this.db.prepare(`SELECT * FROM responses WHERE id = ?`);
    return stmt.get(responseId);
  }

  /**
   * Get a decision by ID
   * @param {number} decisionId - Decision ID
   * @returns {Object|null} Decision object with parsed JSON
   */
  getDecision(decisionId) {
    const stmt = this.db.prepare(`SELECT * FROM decision_log WHERE id = ?`);
    const decision = stmt.get(decisionId);
    if (decision && decision.evaluated_message_ids) {
      decision.evaluated_message_ids = JSON.parse(decision.evaluated_message_ids);
    }
    return decision;
  }

  // Prompt operations
  /**
   * Store a full AI prompt for debugging/inspection
   * @param {Object} promptData - Prompt data
   * @returns {number} Inserted prompt ID
   */
  storePrompt({
    responseId = null,
    decisionId = null,
    conversationId = null,
    promptType,
    systemPrompt,
    messagesJson,
    model,
    temperature,
    usage = null,
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO prompts (response_id, decision_id, conversation_id, prompt_type, system_prompt, messages_json, model, temperature, created_at,
        prompt_tokens, completion_tokens, cache_hit_tokens, cache_miss_tokens, reasoning_tokens, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const u = usage || {};
    const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);
    const result = stmt.run(
      responseId,
      decisionId,
      conversationId,
      promptType,
      systemPrompt,
      JSON.stringify(messagesJson),
      model,
      temperature,
      new Date().toISOString(),
      num(u.prompt_tokens),
      num(u.completion_tokens),
      num(u.cache_hit_tokens),
      num(u.cache_miss_tokens),
      num(u.reasoning_tokens),
      num(u.duration_ms)
    );

    return result.lastInsertRowid;
  }

  /**
   * The token counts out of one API response, in the shape storePrompt
   * takes, added onto `into` when given (a reply can take several calls).
   * DeepSeek reports the prefix-cache split as prompt_cache_hit_tokens /
   * prompt_cache_miss_tokens and reasoning under completion_tokens_details.
   * @param {Object|null} response - A chat completion
   * @param {number|null} [durationMs]
   * @param {Object|null} [into]
   */
  static usageOf(response, durationMs = null, into = null) {
    const u = response?.usage || {};
    const out = into || DatabaseManager.emptyUsage();
    const add = (key, value) => {
      if (Number.isFinite(value)) out[key] += value;
    };
    add("prompt_tokens", u.prompt_tokens);
    add("completion_tokens", u.completion_tokens);
    add("cache_hit_tokens", u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens);
    add("cache_miss_tokens", u.prompt_cache_miss_tokens ?? (Number.isFinite(u.prompt_tokens) && Number.isFinite(u.prompt_tokens_details?.cached_tokens) ? u.prompt_tokens - u.prompt_tokens_details.cached_tokens : undefined));
    add("reasoning_tokens", u.completion_tokens_details?.reasoning_tokens);
    add("duration_ms", durationMs);
    if (response) out.calls += 1;
    return out;
  }

  /** A zero usage record, for usageOf to add onto. */
  static emptyUsage() {
    return { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0, reasoning_tokens: 0, duration_ms: 0, calls: 0 };
  }

  /**
   * Spend by kind of call over the last `hours`: calls, tokens in and out,
   * how much of the input was a cache hit, and the average call time.
   * @param {number} [hours]
   * @returns {Array<{prompt_type: string, model: string, calls: number, prompt_tokens: number, completion_tokens: number, cache_hit_tokens: number, cache_miss_tokens: number, reasoning_tokens: number, avg_duration_ms: number|null, chars: number}>}
   */
  getUsage(hours = 24) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      SELECT prompt_type, COALESCE(model, '') AS model, COUNT(*) AS calls,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens,
        COALESCE(SUM(cache_miss_tokens), 0) AS cache_miss_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        ROUND(AVG(duration_ms)) AS avg_duration_ms,
        COALESCE(SUM(LENGTH(system_prompt) + LENGTH(messages_json)), 0) AS chars
      FROM prompts WHERE created_at >= ?
      GROUP BY prompt_type, model ORDER BY prompt_tokens DESC
    `).all(since);
  }

  /** Prompts older than `days` go; they are for debugging, and they are big. */
  pruneOldPrompts(days = 30) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`DELETE FROM prompts WHERE created_at < ?`).run(cutoff);
    if (result.changes > 0) this.logger.info(`Pruned ${result.changes} prompts older than ${days} days`);
    return result.changes;
  }

  /**
   * Get prompt by response ID
   * @param {number} responseId - Response ID
   * @returns {Object|null} Prompt object with parsed messages
   */
  getPromptByResponse(responseId) {
    const stmt = this.db.prepare(`SELECT * FROM prompts WHERE response_id = ?`);
    const prompt = stmt.get(responseId);
    if (prompt) {
      prompt.messages_json = JSON.parse(prompt.messages_json || "[]");
    }
    return prompt;
  }

  /**
   * Get prompt by decision ID
   * @param {number} decisionId - Decision ID
   * @returns {Object|null} Prompt object with parsed messages
   */
  getPromptByDecision(decisionId) {
    const stmt = this.db.prepare(`SELECT * FROM prompts WHERE decision_id = ?`);
    const prompt = stmt.get(decisionId);
    if (prompt) {
      prompt.messages_json = JSON.parse(prompt.messages_json || "[]");
    }
    return prompt;
  }

  /**
   * Get messages with bulk relation data for dashboard
   * Returns messages with associated decision/response info for inline indicators
   * @param {string|null} channelId - Channel ID (null for all channels)
   * @param {number} limit - Max messages to return
   * @returns {Object} { messages: [], relations: { messageId: { decision, response, triggeredResponse } } }
   */
  getMessagesWithRelations(channelId, limit = 100) {
    // Get messages (all channels or specific channel)
    let messages;
    if (channelId) {
      const messagesStmt = this.db.prepare(`
        SELECT * FROM messages
        WHERE channel_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
      messages = messagesStmt.all(channelId, limit).map(msg => this._parseMessageRecord(msg));
    } else {
      const messagesStmt = this.db.prepare(`
        SELECT * FROM messages
        ORDER BY created_at DESC
        LIMIT ?
      `);
      messages = messagesStmt.all(limit).map(msg => this._parseMessageRecord(msg));
    }

    if (messages.length === 0) {
      return { messages: [], relations: {} };
    }
    this.attachThreading(messages);

    const messageIds = messages.map(m => m.id);
    const messageIdSet = new Set(messageIds);
    const relations = {};

    // Initialize relations for each message
    messageIds.forEach(id => {
      relations[id] = {
        decision: null,
        response: null,
        triggeredResponse: false
      };
    });

    // Get recent decisions for this channel (or all channels)
    // This catches both RESPOND and PASS decisions
    let decisions;
    if (channelId) {
      const decisionsStmt = this.db.prepare(`
        SELECT * FROM decision_log
        WHERE channel_id = ?
        ORDER BY evaluated_at DESC
        LIMIT ?
      `);
      decisions = decisionsStmt.all(channelId, limit);
    } else {
      const decisionsStmt = this.db.prepare(`
        SELECT * FROM decision_log
        ORDER BY evaluated_at DESC
        LIMIT ?
      `);
      decisions = decisionsStmt.all(limit);
    }

    // For each decision, find the trigger message
    // The trigger is the LAST message in evaluated_message_ids (the most recent)
    decisions.forEach(decision => {
      let triggerMessageId = null;

      // First try to get the last message from evaluated_message_ids
      if (decision.evaluated_message_ids) {
        try {
          const ids = JSON.parse(decision.evaluated_message_ids);
          if (ids.length > 0) {
            // Last message in the array is the trigger (most recent)
            triggerMessageId = ids[ids.length - 1];
          }
        } catch (e) {
          // JSON parse failed, fall through to reply_to_message_id
        }
      }

      // Fallback to reply_to_message_id for direct mentions
      if (!triggerMessageId && decision.reply_to_message_id) {
        triggerMessageId = decision.reply_to_message_id;
      }

      // If this trigger message is in our current view, add the decision
      if (triggerMessageId && messageIdSet.has(triggerMessageId)) {
        // Only set if not already set (keep most recent decision for this message)
        if (!relations[triggerMessageId].decision) {
          relations[triggerMessageId].decision = {
            id: decision.id,
            should_respond: !!decision.should_respond,
            reason: decision.reason,
            evaluated_at: decision.evaluated_at
          };
        }
      }
    });

    // Find responses triggered by these messages
    const responsesStmt = this.db.prepare(`
      SELECT * FROM responses
      WHERE trigger_message_id IN (${messageIds.map(() => '?').join(',')})
    `);
    const responses = responsesStmt.all(...messageIds);

    responses.forEach(response => {
      if (response.trigger_message_id && relations[response.trigger_message_id]) {
        relations[response.trigger_message_id].triggeredResponse = true;
        relations[response.trigger_message_id].response = {
          id: response.id,
          response_type: response.response_type,
          message_id: response.message_id
        };
      }
    });

    // For bot messages, find the associated response record
    const botMessages = messages.filter(m => m.is_bot_message);
    if (botMessages.length > 0) {
      const botMsgIds = botMessages.map(m => m.id);
      const botResponsesStmt = this.db.prepare(`
        SELECT * FROM responses
        WHERE message_id IN (${botMsgIds.map(() => '?').join(',')})
      `);
      const botResponses = botResponsesStmt.all(...botMsgIds);

      botResponses.forEach(response => {
        if (response.message_id && relations[response.message_id]) {
          relations[response.message_id].response = {
            id: response.id,
            response_type: response.response_type,
            trigger_message_id: response.trigger_message_id
          };
        }
      });
    }

    return { messages, relations };
  }

  // Dashboard API helpers
  getActiveChannels() {
    const stmt = this.db.prepare(`
      SELECT DISTINCT channel_id,
             (SELECT channel_name FROM messages WHERE messages.channel_id = m.channel_id AND channel_name IS NOT NULL ORDER BY created_at DESC LIMIT 1) as channel_name,
             (SELECT COUNT(*) FROM messages WHERE messages.channel_id = m.channel_id) as message_count,
             (SELECT MAX(created_at) FROM messages WHERE messages.channel_id = m.channel_id) as last_activity
      FROM messages m
      ORDER BY last_activity DESC
    `);
    return stmt.all();
  }

  getStats() {
    const messageCount = this.db.prepare(`SELECT COUNT(*) as count FROM messages`).get().count;
    const decisionCount = this.db.prepare(`SELECT COUNT(*) as count FROM decision_log`).get().count;
    const responseCount = this.db.prepare(`SELECT COUNT(*) as count FROM responses`).get().count;
    const autonomousResponseCount = this.db.prepare(`SELECT COUNT(*) as count FROM responses WHERE response_type = 'autonomous'`).get().count;
    const directResponseCount = this.db.prepare(`SELECT COUNT(*) as count FROM responses WHERE response_type = 'direct'`).get().count;

    return {
      totalMessages: messageCount,
      totalDecisions: decisionCount,
      totalResponses: responseCount,
      autonomousResponses: autonomousResponseCount,
      directResponses: directResponseCount
    };
  }

  // ==================== Journal and people (the Archivist) ====================

  /**
   * Messages in a conversation after a rowid watermark, oldest first, with
   * their rowid. rowid is insertion order, which is arrival order, so it is a
   * safer watermark than created_at (two messages can share a millisecond).
   * @param {string} conversationId
   * @param {number} afterRowid
   * @param {number} limit
   * @returns {Array}
   */
  getMessagesAfterRowid(conversationId, afterRowid, limit = 200) {
    const stmt = this.db.prepare(`
      SELECT rowid AS rowid, * FROM messages
      WHERE channel_id = ? AND rowid > ?
      ORDER BY rowid ASC
      LIMIT ?
    `);
    return this.attachThreading(stmt.all(conversationId, afterRowid, limit).map((msg) => this._parseMessageRecord(msg)));
  }

  countMessagesAfterRowid(conversationId, afterRowid) {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) AS count FROM messages WHERE channel_id = ? AND rowid > ?
    `);
    return stmt.get(conversationId, afterRowid).count;
  }

  /** The newest message's rowid in a conversation, 0 when it has none. */
  getLastMessageRowid(conversationId) {
    const row = this.db.prepare(`
      SELECT MAX(rowid) AS rowid FROM messages WHERE channel_id = ?
    `).get(conversationId);
    return row?.rowid ?? 0;
  }

  /**
   * A conversation's journal row, or null before the first pass.
   * @returns {{conversation_id, content, watermark_rowid, updated_at}|null}
   */
  getJournal(conversationId) {
    return this.db.prepare(`SELECT * FROM journals WHERE conversation_id = ?`).get(conversationId) || null;
  }

  /** The journal's text, or "" when there is none. */
  getJournalText(conversationId) {
    return this.getJournal(conversationId)?.content ?? "";
  }

  /**
   * Replace a journal's text, keeping the old text as a version. Also moves
   * the watermark when one is given.
   * @param {string} conversationId
   * @param {string} content
   * @param {{source?: string, rationale?: string|null, watermarkRowid?: number|null}} [options]
   */
  setJournal(conversationId, content, { source = "archivist", rationale = null, watermarkRowid = null } = {}) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const existing = this.getJournal(conversationId);
      const watermark = watermarkRowid ?? existing?.watermark_rowid ?? 0;
      this.db.prepare(`
        INSERT INTO journals (conversation_id, content, watermark_rowid, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET content = excluded.content,
          watermark_rowid = excluded.watermark_rowid, updated_at = excluded.updated_at
      `).run(conversationId, content, watermark, now);
      this.db.prepare(`
        INSERT INTO journal_versions (conversation_id, content, source, rationale, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(conversationId, content, source, rationale, now);
    })();
  }

  /** Move the watermark without changing the text (a pass that found nothing). */
  setJournalWatermark(conversationId, watermarkRowid) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO journals (conversation_id, content, watermark_rowid, updated_at)
      VALUES (?, '', ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET watermark_rowid = excluded.watermark_rowid
    `).run(conversationId, watermarkRowid, now);
  }

  /** Every journal, newest update first, with its version count. */
  listJournals() {
    return this.db.prepare(`
      SELECT j.*, (SELECT COUNT(*) FROM journal_versions v WHERE v.conversation_id = j.conversation_id) AS version_count
      FROM journals j ORDER BY j.updated_at DESC
    `).all();
  }

  getJournalVersions(conversationId, limit = 50) {
    return this.db.prepare(`
      SELECT * FROM journal_versions WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
    `).all(conversationId, limit);
  }

  /** Forget a conversation's journal and its history. The watermark goes too, so the next pass rereads the backlog. */
  deleteJournal(conversationId) {
    return this.db.transaction(() => {
      this.db.prepare(`DELETE FROM journal_versions WHERE conversation_id = ?`).run(conversationId);
      return this.db.prepare(`DELETE FROM journals WHERE conversation_id = ?`).run(conversationId).changes > 0;
    })();
  }

  static nickKey(nick) {
    return String(nick).toLowerCase();
  }

  /** A person's note row, or null. */
  getPerson(nick) {
    return this.db.prepare(`SELECT * FROM people WHERE nick_key = ?`).get(DatabaseManager.nickKey(nick)) || null;
  }

  /**
   * Notes for several nicks as a Map of nick -> text, keyed by the nicks as
   * they were asked for (so a caller's lookup matches whatever case the
   * person is using today), only for those who have one.
   * @param {string[]} nicks
   * @returns {Map<string, string>}
   */
  getPeople(nicks) {
    const notes = new Map();
    if (!nicks || nicks.length === 0) return notes;
    const stmt = this.db.prepare(`SELECT * FROM people WHERE nick_key = ?`);
    for (const nick of nicks) {
      const row = stmt.get(DatabaseManager.nickKey(nick));
      if (row) notes.set(nick, row.content);
    }
    return notes;
  }

  /** Replace a person's note, keeping the old one as a version. */
  setPerson(nick, content, { source = "archivist", rationale = null } = {}) {
    const now = new Date().toISOString();
    const key = DatabaseManager.nickKey(nick);
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO people (nick_key, nick, content, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(nick_key) DO UPDATE SET nick = excluded.nick, content = excluded.content, updated_at = excluded.updated_at
      `).run(key, nick, content, now);
      this.db.prepare(`
        INSERT INTO people_versions (nick_key, content, source, rationale, created_at) VALUES (?, ?, ?, ?, ?)
      `).run(key, content, source, rationale, now);
    })();
  }

  /**
   * Someone changed nick: unless the new nick already has a note, the old
   * nick's note is copied under it, so the bot still knows who this is.
   * (layla and notlayla were two strangers to every bot before this.) The
   * old note stays, since nicks come back.
   * @returns {boolean} Whether a note was copied
   */
  inheritPerson(oldNick, newNick) {
    if (!oldNick || !newNick || DatabaseManager.nickKey(oldNick) === DatabaseManager.nickKey(newNick)) return false;
    const from = this.getPerson(oldNick);
    if (!from || !from.content?.trim()) return false;
    if (this.getPerson(newNick)?.content?.trim()) return false;
    this.setPerson(newNick, from.content, { source: "nick-change", rationale: `was ${from.nick}` });
    return true;
  }

  listPeople() {
    return this.db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM people_versions v WHERE v.nick_key = p.nick_key) AS version_count
      FROM people p ORDER BY p.updated_at DESC
    `).all();
  }

  getPersonVersions(nick, limit = 50) {
    return this.db.prepare(`
      SELECT * FROM people_versions WHERE nick_key = ? ORDER BY id DESC LIMIT ?
    `).all(DatabaseManager.nickKey(nick), limit);
  }

  deletePerson(nick) {
    const key = DatabaseManager.nickKey(nick);
    return this.db.transaction(() => {
      this.db.prepare(`DELETE FROM people_versions WHERE nick_key = ?`).run(key);
      return this.db.prepare(`DELETE FROM people WHERE nick_key = ?`).run(key).changes > 0;
    })();
  }

  close() {
    if (this.db) {
      this.db.close();
      this.logger.info("Database connection closed");
    }
  }
}

module.exports = DatabaseManager;
