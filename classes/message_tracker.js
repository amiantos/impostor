/**
 * MessageTracker - Per-channel message tracking with SQLite storage
 *
 * Handles tracking of messages and determines when autonomous response
 * evaluations should be triggered based on message count and time thresholds.
 */
class MessageTracker {
  constructor(logger, database, config) {
    this.logger = logger;
    this.db = database;
    this.config = config.autonomous || {};

    // In-memory tracking for evaluation timing (not persisted)
    this.lastEvaluation = new Map(); // channelId → timestamp
    this.messageCountSinceEval = new Map(); // channelId → count
  }

  /**
   * Track a new message
   * @param {Message} message - Discord message object
   * @param {boolean} isBotMessage - Whether this message is from the bot
   */
  addMessage(message, isBotMessage = false) {
    // Store in database
    this.db.insertMessage(message, isBotMessage);

    // Update in-memory counter
    const channelId = message.channel.id;
    const currentCount = this.messageCountSinceEval.get(channelId) || 0;
    this.messageCountSinceEval.set(channelId, currentCount + 1);

    this.logger.debug(`Tracked message in channel ${channelId}. Count since eval: ${currentCount + 1}`);
  }

  /**
   * Get recent messages from a channel
   * @param {string} channelId - Discord channel ID
   * @param {number} limit - Maximum number of messages to retrieve
   * @returns {Array} Array of message objects from database
   */
  getRecentMessages(channelId, limit = 50) {
    return this.db.getRecentMessages(channelId, limit);
  }

  /**
   * Get messages since the bot's last response in the channel
   * @param {string} channelId - Discord channel ID
   * @returns {Array} Array of message objects
   */
  getMessagesSinceLastResponse(channelId) {
    return this.db.getMessagesSinceLastBotResponse(channelId);
  }

  /**
   * Determine if an autonomous response evaluation should be triggered
   * @param {string} channelId - Discord channel ID
   * @returns {boolean} True if evaluation should run
   */
  shouldEvaluate(channelId) {
    const messagesThreshold = this.config.messages_before_evaluation || 5;
    const secondsThreshold = this.config.seconds_before_evaluation || 60;
    const cooldownSeconds = this.config.cooldown_seconds || 60;

    // Check message count threshold
    const messageCount = this.messageCountSinceEval.get(channelId) || 0;
    const hasEnoughMessages = messageCount >= messagesThreshold;

    // Check time threshold
    const lastEvalTime = this.lastEvaluation.get(channelId);
    const now = Date.now();
    const timeSinceLastEval = lastEvalTime ? (now - lastEvalTime) / 1000 : Infinity;
    const hasEnoughTimePassed = timeSinceLastEval >= secondsThreshold;

    // Check cooldown from last bot response
    const lastBotResponseTime = this.db.getLastBotResponseTime(channelId);
    const timeSinceLastResponse = lastBotResponseTime ? (now - lastBotResponseTime.getTime()) / 1000 : Infinity;
    const cooldownPassed = timeSinceLastResponse >= cooldownSeconds;

    // Must have both enough time since last eval AND cooldown passed
    // Plus either enough messages OR enough time
    if (!cooldownPassed) {
      this.logger.debug(`Channel ${channelId}: Cooldown not passed (${timeSinceLastResponse.toFixed(0)}s < ${cooldownSeconds}s)`);
      return false;
    }

    if (hasEnoughMessages) {
      this.logger.debug(`Channel ${channelId}: Triggering eval - ${messageCount} messages (threshold: ${messagesThreshold})`);
      return true;
    }

    if (hasEnoughTimePassed && messageCount > 0) {
      this.logger.debug(`Channel ${channelId}: Triggering eval - ${timeSinceLastEval.toFixed(0)}s since last eval (threshold: ${secondsThreshold}s)`);
      return true;
    }

    return false;
  }

  /**
   * Mark that an evaluation has been performed for a channel
   * @param {string} channelId - Discord channel ID
   */
  markEvaluated(channelId) {
    this.lastEvaluation.set(channelId, Date.now());
    this.messageCountSinceEval.set(channelId, 0);
    this.logger.debug(`Marked channel ${channelId} as evaluated`);
  }

  /**
   * Mark that the bot has responded in a channel
   * This resets the message counter and updates timing
   * @param {string} channelId - Discord channel ID
   */
  markResponded(channelId) {
    this.messageCountSinceEval.set(channelId, 0);
    this.logger.debug(`Marked channel ${channelId} as responded`);
  }

  /**
   * Get the count of messages since last evaluation
   * @param {string} channelId - Discord channel ID
   * @returns {number} Message count
   */
  getMessageCountSinceEval(channelId) {
    return this.messageCountSinceEval.get(channelId) || 0;
  }

  /**
   * Get the time of last evaluation
   * @param {string} channelId - Discord channel ID
   * @returns {Date|null} Last evaluation timestamp
   */
  getLastEvaluationTime(channelId) {
    const timestamp = this.lastEvaluation.get(channelId);
    return timestamp ? new Date(timestamp) : null;
  }

  /**
   * Run periodic maintenance tasks
   */
  runMaintenance() {
    const maxMessages = this.config.max_messages_stored || 1000;
    this.db.pruneOldMessages(maxMessages);
    this.logger.debug("Message tracker maintenance completed");
  }
}

module.exports = MessageTracker;
