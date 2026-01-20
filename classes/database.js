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

    if (!columnNames.includes("is_backfilled")) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN is_backfilled BOOLEAN DEFAULT FALSE`);
      this.logger.info("Migration: Added is_backfilled column to messages");
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
    authorId,
    authorName,
    content,
    createdAt,
    isBotMessage = false,
    attachments = null,
    visionDescriptions = null,
    replyToMessageId = null,
    isBackfilled = false
  }) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, channel_id, author_id, author_name, content, created_at,
        is_bot_message, attachments, vision_descriptions, reply_to_message_id, is_backfilled
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      channelId,
      authorId,
      authorName,
      content,
      createdAt instanceof Date ? createdAt.toISOString() : createdAt,
      isBotMessage ? 1 : 0,
      attachments ? JSON.stringify(attachments) : null,
      visionDescriptions ? JSON.stringify(visionDescriptions) : null,
      replyToMessageId,
      isBackfilled ? 1 : 0
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
   * Parse a message record from the database
   * @param {Object} record - Raw database record
   * @returns {Object} Parsed message object
   */
  _parseMessageRecord(record) {
    return {
      ...record,
      attachments: record.attachments ? JSON.parse(record.attachments) : null,
      vision_descriptions: record.vision_descriptions ? JSON.parse(record.vision_descriptions) : null,
      is_bot_message: !!record.is_bot_message,
      is_backfilled: !!record.is_backfilled
    };
  }

  getRecentMessages(channelId, limit = 50, parseJson = false) {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE channel_id = ?
      ORDER BY created_at DESC
      LIMIT ?
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
        SELECT * FROM messages
        WHERE channel_id = ?
        ORDER BY created_at DESC
        LIMIT 50
      `);
      return stmt.all(channelId).reverse();
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

  // Dashboard API helpers
  getActiveChannels() {
    const stmt = this.db.prepare(`
      SELECT DISTINCT channel_id,
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
