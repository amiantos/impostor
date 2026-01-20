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
    this.logger.info(`Database initialized at ${this.dbPath}`);
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

  getRecentMessages(channelId, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE channel_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(channelId, limit);
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
  logDecision(channelId, messagesEvaluated, shouldRespond, replyToMessageId, reason) {
    const stmt = this.db.prepare(`
      INSERT INTO decision_log (channel_id, evaluated_at, messages_evaluated, should_respond, reply_to_message_id, reason, response_sent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      channelId,
      new Date().toISOString(),
      messagesEvaluated,
      shouldRespond ? 1 : 0,
      replyToMessageId || null,
      reason,
      0
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
  logResponse(channelId, messageId, responseType, content) {
    const stmt = this.db.prepare(`
      INSERT INTO responses (channel_id, message_id, response_type, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      channelId,
      messageId,
      responseType,
      content,
      new Date().toISOString()
    );
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
