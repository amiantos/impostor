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

    // Migration: Add url_summaries column to messages
    if (!columnNames.includes("url_summaries")) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN url_summaries TEXT`);
      this.logger.info("Migration: Added url_summaries column to messages");
    }
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
      message.author.username || message.author.displayName || "Unknown",
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
   * @param {string} messageId - Discord message ID
   * @returns {boolean} True if message exists
   */
  messageExists(messageId) {
    const stmt = this.db.prepare(`SELECT 1 FROM messages WHERE id = ?`);
    return stmt.get(messageId) !== undefined;
  }

  /**
   * Update vision descriptions for an existing message
   * @param {string} messageId - Discord message ID
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
   * @param {string} messageId - Discord message ID
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
   * @param {string} channelId - Discord channel ID
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
   * @param {string} messageId - Discord message ID
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
   * @param {string} messageId - Discord message ID
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
   * @param {string} messageId - Discord message ID of the bot's response
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
      return messages.map(msg => this._parseMessageRecord(msg));
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

  // Clean up old messages to prevent unbounded growth
  pruneOldMessages(maxMessagesPerChannel = 1000) {
    // Get all distinct channel IDs
    const channels = this.db.prepare(`SELECT DISTINCT channel_id FROM messages`).all();

    for (const { channel_id } of channels) {
      const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM messages WHERE channel_id = ?`);
      const { count } = countStmt.get(channel_id);

      if (count > maxMessagesPerChannel) {
        const deleteStmt = this.db.prepare(`
          DELETE FROM messages
          WHERE channel_id = ? AND id NOT IN (
            SELECT id FROM messages
            WHERE channel_id = ?
            ORDER BY created_at DESC
            LIMIT ?
          )
        `);
        deleteStmt.run(channel_id, channel_id, maxMessagesPerChannel);
        this.logger.debug(`Pruned old messages from channel ${channel_id}`);
      }
    }
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
    promptType,
    systemPrompt,
    messagesJson,
    model,
    temperature
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO prompts (response_id, decision_id, prompt_type, system_prompt, messages_json, model, temperature, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      responseId,
      decisionId,
      promptType,
      systemPrompt,
      JSON.stringify(messagesJson),
      model,
      temperature,
      new Date().toISOString()
    );

    return result.lastInsertRowid;
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

  close() {
    if (this.db) {
      this.db.close();
      this.logger.info("Database connection closed");
    }
  }
}

module.exports = DatabaseManager;
