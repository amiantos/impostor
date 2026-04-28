const IRC = require("irc-framework");
const { createIrcMessage } = require("./irc_message");
const { splitMessage } = require("./message_splitter");
const { parseBridgedMessage } = require("./bridge_parser");
const ContextUtils = require("./context_utils");
const PythonTool = require("./python_tool");
const WebSearchTool = require("./web_search_tool");
const WebFetchTool = require("./web_fetch_tool");
const MemoryTool = require("./memory_tool");
const DatabaseManager = require("./database");
const MessageTracker = require("./message_tracker");
const ResponseEvaluator = require("./response_evaluator");
const VisionService = require("./vision_service");
const UrlSummarizeService = require("./url_summarize_service");
const { OpenAI } = require("openai");

class ImpostorClient {
  constructor(logger, config) {
    this.watchword = config.irc.watchword || config.irc.nick;
    this.contextUtils = new ContextUtils(logger, this.watchword);
    this.config = config;
    this.logger = logger;

    // IRC client
    this.ircClient = new IRC.Client();
    this.botNick = config.irc.nick;

    this.openai = new OpenAI({
      apiKey: config.generator.deepseek.api_key,
      baseURL: config.generator.deepseek.base_url,
    });

    // Message queue system
    this.messageQueue = [];
    this.isProcessing = false;

    // Debounce timers for autonomous evaluation (channelId -> timer)
    this.evaluationTimers = new Map();

    // Initialize tools
    this.pythonTool = new PythonTool(logger);
    this.webSearchTool = new WebSearchTool(logger, config);
    this.webFetchTool = new WebFetchTool(logger);

    // Initialize database
    this.db = new DatabaseManager(logger);
    this.db.initialize();

    // Initialize memory tool (needs database)
    this.memoryTool = new MemoryTool(logger, this.db);

    // Initialize vision service with database for caching
    this.visionService = new VisionService(logger, config, this.db);

    // Initialize URL summarize service with database for caching
    this.urlSummarizeService = new UrlSummarizeService(logger, config, this.db);

    // Initialize message tracker with vision and URL summarize services
    this.messageTracker = new MessageTracker(logger, this.db, config, this.visionService, this.urlSummarizeService);
    this.evaluator = new ResponseEvaluator(logger, config, this.db, this.visionService, this.watchword, this.openai);

    // Set up periodic maintenance
    this.maintenanceInterval = setInterval(() => {
      this.messageTracker.runMaintenance();
    }, 60 * 60 * 1000); // Run every hour

    // Reconnect backoff state
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.shuttingDown = false;

    // IRC event handlers
    this.ircClient.on("registered", () => {
      this.reconnectDelay = 1000;
      this.logger.info(`Connected to IRC as ${this.botNick}!`);
      // Join configured channels
      for (const channel of config.irc.channels) {
        this.ircClient.join(channel);
        this.logger.info(`Joining ${channel}`);
      }
    });

    this.ircClient.on("join", (event) => {
      if (event.nick === this.botNick) {
        this.logger.info(`Joined ${event.channel}`);
      }
    });

    this.ircClient.on("privmsg", (event) => {
      this.handleIrcMessage(event);
    });

    this.ircClient.on("action", (event) => {
      // Handle /me actions as regular messages with * prefix
      event.message = `* ${event.nick} ${event.message}`;
      this.handleIrcMessage(event);
    });

    this.ircClient.on("nick", (event) => {
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
        this.logger.debug(`IRC RAW: ${event.line}`);
      }
    });

    this.ircClient.on("irc error", (event) => {
      this.logger.error("IRC error:", event);
    });

    this.ircClient.on("server options", (event) => {
      this.logger.info("IRC server options received (connection established)");
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
    };

    // SASL authentication
    if (ircConfig.sasl && ircConfig.password) {
      connectOptions.account = {
        account: ircConfig.nick,
        password: ircConfig.password,
      };
    }

    this.connectOptions = connectOptions;
    this.ircClient.connect(connectOptions);
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
   * Check if a message is a direct trigger (mentions the bot's nick)
   * @param {string} content - Message content
   * @returns {boolean} True if message directly triggers the bot
   */
  isDirectTrigger(content) {
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nick = escape(this.botNick);
    const watchword = escape(this.watchword);
    const pattern = nick === watchword
      ? `\\b${nick}\\b`
      : `\\b(?:${nick}|${watchword})\\b`;
    return new RegExp(pattern, "i").test(content);
  }

  /**
   * Handle an incoming IRC message event
   * @param {Object} event - irc-framework message event
   */
  async handleIrcMessage(event) {
    // Ignore our own messages (IRC nicks are case-insensitive)
    if (event.nick.toLowerCase() === this.botNick.toLowerCase()) return;
    if (!event.target) return;

    // IRC routes channel messages and PMs through the same PRIVMSG verb. The
    // only difference is the target: channels start with '#', everything else
    // is a nick. Use the target verbatim as the conversation key for channels;
    // for DMs use the sender's nick (since target is the bot itself).
    const isPrivate = !event.target.startsWith("#");
    const conversationId = isPrivate ? event.nick : event.target;

    if (!isPrivate && !this.isAllowedChannel(event.target)) return;

    const bridgeNick = this.config.discord?.bridge_nick || "EyeBridge";
    const { nick, message: messageText, isWebhookAnnouncement } =
      parseBridgedMessage(event.nick, event.message, bridgeNick);

    const message = createIrcMessage(nick, conversationId, messageText, {
      ident: event.ident,
      hostname: event.hostname,
      isBot: false,
    });

    // Always track the message so the admin dashboard surfaces every chat,
    // including DMs from non-allowlisted senders.
    await this.messageTracker.addMessage(message, {
      isBotMessage: false,
      processVision: true,
      processUrls: !isWebhookAnnouncement,
    });

    // DMs: every message is a direct address. Only respond if the sender is
    // on the PM allowlist; otherwise stop here (still stored above).
    if (isPrivate) {
      if (!this.isAllowedPmSender(event.nick)) {
        this.logger.info(
          `PM from ${event.nick} stored but not responded to (not in pm_allowed_users).`
        );
        return;
      }
      this.logger.info(`Queuing DM from ${nick}.`, message);
      this.messageQueue.push({ message, channel: conversationId, type: "direct" });
      if (!this.isProcessing) this.processMessageQueue();
      return;
    }

    // Channel: respond directly when nick is mentioned, otherwise debounce.
    if (this.isDirectTrigger(messageText)) {
      this.logger.info(`Queuing direct message from ${nick}.`, message);
      this.messageQueue.push({ message, channel: conversationId, type: "direct" });
      if (!this.isProcessing) this.processMessageQueue();
      return;
    }

    if (this.config.autonomous?.enabled) {
      this.scheduleAutonomousEvaluation(conversationId, message);
    }
  }

  /**
   * Schedule an autonomous evaluation with debouncing
   * @param {string} channelName - IRC channel name (e.g. "#amiantos")
   * @param {Object} message - Normalized message object
   */
  scheduleAutonomousEvaluation(channelName, message) {
    // Use shorter debounce if bot nick is mentioned (likely being addressed)
    const mentionsBot = message && this.isDirectTrigger(message.content);
    const debounceMs = mentionsBot
      ? 3000
      : (this.config.autonomous?.debounce_seconds || 10) * 1000;

    // Clear any existing timer for this channel
    if (this.evaluationTimers.has(channelName)) {
      clearTimeout(this.evaluationTimers.get(channelName));
      this.logger.debug(`Reset evaluation timer for channel ${channelName}`);
    }

    // Set new timer
    const timer = setTimeout(async () => {
      this.logger.debug(`Evaluation timer fired for channel ${channelName}`);
      await this.evaluateAutonomousResponse(channelName);
      this.evaluationTimers.delete(channelName);
    }, debounceMs);

    this.evaluationTimers.set(channelName, timer);
    this.logger.debug(`Scheduled evaluation for channel ${channelName} in ${debounceMs / 1000}s`);
  }

  /**
   * Evaluate whether to send an autonomous response
   * @param {string} channelName - IRC channel name
   */
  async evaluateAutonomousResponse(channelName) {
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

    // Get evaluation context
    const evaluationMessages = this.getMessagesForEvaluation(recentMessages, 5);

    // Ask AI if we should respond (pass ratio for context)
    const decision = await this.evaluator.shouldRespond(
      evaluationMessages,
      botUserId,
      channelName,
      botRatio
    );

    if (decision.should_respond) {
      this.logger.info(
        `Queueing autonomous response for channel ${channelName}: ${decision.reason}`
      );

      this.messageQueue.push({
        channel: channelName,
        type: "autonomous",
        decisionId: decision.decisionId,
      });

      if (!this.isProcessing) {
        this.processMessageQueue();
      }
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
   * Get messages for evaluation context, including bot's last response with surrounding context
   * @param {Array} messages - Parsed messages from database (chronological order, oldest first)
   * @param {number} contextBefore - Number of messages to include before bot's last response
   * @param {number} maxAgeMinutes - Maximum age of messages to include
   * @param {number} maxGapMinutes - Maximum gap between messages before treating as new conversation
   * @returns {Array} Messages with context (chronological order, oldest first)
   */
  getMessagesForEvaluation(messages, contextBefore = 5, maxAgeMinutes = null, maxGapMinutes = null) {
    maxAgeMinutes = maxAgeMinutes ?? this.config.autonomous?.max_context_age_minutes ?? 30;
    maxGapMinutes = maxGapMinutes ?? this.config.autonomous?.max_conversation_gap_minutes ?? 30;

    const cutoffTime = Date.now() - maxAgeMinutes * 60 * 1000;
    const recentMessages = messages.filter(m => {
      const msgTime = new Date(m.created_at).getTime();
      return msgTime >= cutoffTime;
    });

    if (recentMessages.length === 0) {
      this.logger.debug(`No messages within ${maxAgeMinutes} minute window`);
      return [];
    }

    const filteredMessages = this.filterByConversationGaps(recentMessages, maxGapMinutes);

    if (filteredMessages.length === 0) {
      return [];
    }

    let lastBotIndex = -1;
    for (let i = filteredMessages.length - 1; i >= 0; i--) {
      if (filteredMessages[i].is_bot_message) {
        lastBotIndex = i;
        break;
      }
    }

    if (lastBotIndex === -1) {
      return filteredMessages;
    }

    const startIndex = Math.max(0, lastBotIndex - contextBefore);
    const messagesBeforeBot = filteredMessages.slice(startIndex, lastBotIndex);
    const botMessage = filteredMessages[lastBotIndex];
    const messagesAfterBot = filteredMessages.slice(lastBotIndex + 1);

    return [...messagesBeforeBot, botMessage, ...messagesAfterBot];
  }

  /**
   * Filter messages by conversation gaps
   * @param {Array} messages - Messages in chronological order (oldest first)
   * @param {number} maxGapMinutes - Maximum allowed gap between messages
   * @returns {Array} Filtered messages (chronological order, oldest first)
   */
  filterByConversationGaps(messages, maxGapMinutes) {
    if (messages.length <= 1) {
      return messages;
    }

    const maxGapMs = maxGapMinutes * 60 * 1000;
    let lastGapIndex = -1;

    for (let i = 0; i < messages.length - 1; i++) {
      const currentTime = new Date(messages[i].created_at).getTime();
      const nextTime = new Date(messages[i + 1].created_at).getTime();
      const gap = nextTime - currentTime;

      if (gap > maxGapMs) {
        lastGapIndex = i;
        this.logger.debug(`Found ${Math.round(gap / 60000)} minute conversation gap at index ${i}`);
      }
    }

    if (lastGapIndex >= 0) {
      this.logger.debug(`Excluding ${lastGapIndex + 1} older messages before conversation gap`);
      return messages.slice(lastGapIndex + 1);
    }

    return messages;
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
        } else if (queueItem.type === "autonomous") {
          this.logger.info(
            `Processing autonomous response for channel ${queueItem.channel}. Queue length: ${this.messageQueue.length}`
          );
          await this.processAutonomousMessage(queueItem.channel, queueItem.decisionId);
        }

        // Add a small delay between messages to appear more natural
        if (this.messageQueue.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        this.logger.error("Error processing queued message:", error);
        if (queueItem.type === "direct" && queueItem.channel) {
          this.sendIrcMessage(queueItem.channel, "(OOC: Sorry, I appear to be having connectivity issues, please try your message again.)");
        }
      }
    }

    this.isProcessing = false;
  }

  /**
   * Build context from database
   * @param {string} channelId - Channel identifier (IRC channel name)
   * @param {Object} options - Configuration options
   * @returns {Object} Context object with messages, imageDescriptions, and urlSummaries
   */
  buildContextFromDatabase(channelId, options = {}) {
    const {
      fetchLimit = 50,
      contextBefore = 5,
      useFiltering = true
    } = options;

    let dbMessages;
    if (useFiltering) {
      const rawMessages = this.db.getRecentMessages(channelId, fetchLimit, true);
      dbMessages = this.getMessagesForEvaluation(rawMessages, contextBefore);
    } else {
      dbMessages = this.db.getRecentMessages(channelId, fetchLimit, true);
    }

    const imageDescriptions = this.visionService.buildImageDescriptionsFromDB(dbMessages);
    const urlSummaries = this.urlSummarizeService.buildUrlSummariesFromDB(dbMessages);

    const usernames = [...new Set(
      dbMessages
        .filter(msg => !msg.is_bot_message && msg.author_name)
        .map(msg => msg.author_name)
    )];
    const userMemories = this.db.getMemoriesForUsers(usernames, 10);

    return {
      dbMessages,
      imageDescriptions,
      urlSummaries,
      userMemories
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

    const { dbMessages, imageDescriptions, userMemories } = this.buildContextFromDatabase(channelName, {
      fetchLimit: 50,
      contextBefore: 10
    });

    const triggerInfo = {
      userId: message.author.id,
      userName: message.author.username,
      channelName: channelName,
    };

    const { response, conversationLog } = await this.generateResponseWithChatCompletions({
      dbMessages,
      userName: user_name,
      characterName: character_name,
      botUserId: this.botNick.toLowerCase(),
      imageDescriptions,
      userMemories,
      useDbContext: true,
      triggerInfo,
    });

    // Send to IRC channel (split into lines if needed)
    await this.sendIrcMessage(channelName, response);

    // Create a normalized message for the bot's own response and track it
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
      systemPrompt: this.contextUtils.buildInstructions(),
      messagesJson: conversationLog,
      model: this.config.generator.deepseek.model,
      temperature: this.config.generator.deepseek.temperature
    });

    await this.messageTracker.addMessage(botMessage, { isBotMessage: true, processVision: false });
    this.messageTracker.markResponded(channelName);

    this.cancelEvaluationTimer(channelName);
  }

  /**
   * Cancel a pending evaluation timer for a channel
   * @param {string} channelId - Channel identifier
   */
  cancelEvaluationTimer(channelId) {
    if (this.evaluationTimers.has(channelId)) {
      clearTimeout(this.evaluationTimers.get(channelId));
      this.evaluationTimers.delete(channelId);
      this.logger.debug(`Cancelled evaluation timer for channel ${channelId}`);
    }
  }

  /**
   * Process an autonomous message
   * @param {string} channelName - IRC channel name
   * @param {number|null} decisionId - Optional decision ID that triggered this response
   */
  async processAutonomousMessage(channelName, decisionId = null) {
    const { dbMessages, imageDescriptions, userMemories } = this.buildContextFromDatabase(channelName, {
      fetchLimit: 50,
      contextBefore: 5
    });

    const triggerInfo = {
      userId: null,
      userName: null,
      channelName: channelName,
    };

    const { response, conversationLog } = await this.generateResponseWithChatCompletions({
      dbMessages,
      userName: "various",
      characterName: this.watchword,
      botUserId: this.botNick.toLowerCase(),
      imageDescriptions,
      userMemories,
      useDbContext: true,
      triggerInfo,
    });

    // Send to IRC channel
    await this.sendIrcMessage(channelName, response);

    // Track the bot's own message
    const botMessage = createIrcMessage(this.botNick, channelName, response, {
      isBot: true,
    });

    const responseId = this.db.logResponse(
      channelName,
      botMessage.id,
      "autonomous",
      response,
      null
    );

    this.db.storePrompt({
      responseId,
      promptType: "response",
      systemPrompt: this.contextUtils.buildInstructions(),
      messagesJson: conversationLog,
      model: this.config.generator.deepseek.model,
      temperature: this.config.generator.deepseek.temperature
    });

    if (decisionId) {
      this.db.markDecisionResponseSent(decisionId);
    }

    await this.messageTracker.addMessage(botMessage, { isBotMessage: true, processVision: false });
    this.messageTracker.markResponded(channelName);

    this.cancelEvaluationTimer(channelName);
  }

  /**
   * Send a message to an IRC channel, splitting into multiple lines if needed
   * @param {string} channel - IRC channel name
   * @param {string} text - Message text
   */
  async sendIrcMessage(channel, text) {
    const maxLen = this.config.irc.max_line_length || 350;

    // Isaac is told to address users by leading with "nick: " (IRC channel
    // convention). In a 1:1 DM that prefix is just noise, since the only
    // other party in the conversation IS the recipient. Strip it post-hoc
    // rather than complicating the system prompt with another conditional.
    let payload = text;
    if (!channel.startsWith("#")) {
      const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      payload = payload.replace(new RegExp(`^${escaped}[:,]\\s+`, "i"), "");
    }

    const lines = splitMessage(payload, maxLen);

    for (let i = 0; i < lines.length; i++) {
      this.ircClient.say(channel, lines[i]);
      // Delay between lines to avoid flood protection
      if (i < lines.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  async generateResponseWithChatCompletions({
    messages = null,
    dbMessages = null,
    userName,
    characterName,
    botUserId,
    imageDescriptions = null,
    userMemories = null,
    useDbContext = false,
    triggerInfo = null,
  }) {
    const systemPrompt = this.contextUtils.buildInstructions();
    this.logger.debug("Generated System Prompt...", systemPrompt);

    let inputMessages;
    if (useDbContext && dbMessages && triggerInfo) {
      inputMessages = this.contextUtils.buildChatMessagesConsolidated(
        dbMessages,
        botUserId,
        triggerInfo,
        imageDescriptions,
        userMemories
      );
    } else if (useDbContext && dbMessages) {
      inputMessages = this.contextUtils.buildChatMessagesFromDBRecords(
        dbMessages,
        botUserId,
        imageDescriptions
      );
    } else {
      throw new Error("dbMessages must be provided");
    }

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

REFLECTION: Look at your previous attempts above. What worked? What didn't? How can you adjust your approach based on the results? If you're close to the target (like 1-2 characters off), make small adjustments. Continue iterating to refine your approach, or provide your final response if satisfied.`,
        });
      } else {
        conversationLog.push({
          role: "user",
          content: `Tool execution result: ${JSON.stringify(toolResult)}. Now provide your final response with the actual message.`,
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

    let replyMessage = structuredResponse.message;
    if (!replyMessage || !replyMessage.trim()) {
      this.logger.warn(
        "Final response has empty message field, retrying once before falling back"
      );
      response = await this.callDeepSeek(conversationLog);
      structuredResponse = await this.parseStructuredResponse(response);
      replyMessage = structuredResponse.message;
    }
    if (!replyMessage || !replyMessage.trim()) {
      replyMessage = "Something went wrong with my processing.";
    }

    return {
      response: replyMessage,
      conversationLog
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
        response_format: { type: "json_object" },
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

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }

    this.logger.error(
      `DeepSeek failed to return usable response after ${maxAttempts} attempts`
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
      case "remember":
        result = await this.memoryTool.remember({
          username: toolRequest.username,
          category: toolRequest.category,
          content: toolRequest.content,
          source_message_id: toolRequest.source_message_id || null,
        });
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

  /**
   * Cleanup resources on shutdown
   */
  shutdown() {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
    }
    for (const timer of this.evaluationTimers.values()) {
      clearTimeout(timer);
    }
    this.evaluationTimers.clear();

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
