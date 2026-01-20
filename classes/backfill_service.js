/**
 * BackfillService - Fetches Discord history and stores in database
 *
 * Handles backfilling message history on startup to populate the database
 * with recent messages from configured channels.
 */
class BackfillService {
  constructor(logger, database, visionService, urlSummarizeService, config) {
    this.logger = logger;
    this.db = database;
    this.visionService = visionService;
    this.urlSummarizeService = urlSummarizeService;
    this.config = config;

    // Default backfill settings
    this.messageLimit = config.backfill?.message_limit || 20;
    this.processVision = config.backfill?.process_vision ?? true;
    this.processUrls = config.backfill?.process_urls ?? false; // Disabled by default to avoid API costs on backfill
    this.maxChannelAgeDays = config.backfill?.max_channel_age_days || 14; // Only backfill channels active in last 2 weeks
  }

  /**
   * Backfill messages from a single channel
   * @param {Channel} channel - Discord channel object
   * @param {Object} options - Backfill options
   * @param {number} options.limit - Maximum messages to fetch (default: 100)
   * @param {boolean} options.processVision - Whether to process images (default: true)
   * @param {boolean} options.processUrls - Whether to process URLs (default: false)
   * @returns {Promise<Object>} Backfill results
   */
  async backfillChannel(channel, options = {}) {
    const {
      limit = this.messageLimit,
      processVision = this.processVision,
      processUrls = this.processUrls
    } = options;

    const channelId = channel.id;
    this.logger.info(`Starting backfill for channel ${channelId} (limit: ${limit})`);

    let messagesProcessed = 0;
    let messagesSkipped = 0;
    let imagesProcessed = 0;
    let urlsProcessed = 0;

    try {
      // Fetch messages from Discord
      const messages = await channel.messages.fetch({ limit });

      // Convert to array and sort by date (oldest first)
      const messageArray = Array.from(messages.values()).sort(
        (a, b) => a.createdAt - b.createdAt
      );

      // Update channel name for all messages in this channel (even if they exist)
      // This ensures channel names get populated for channels that were backfilled before this feature
      if (channel.name) {
        this.db.updateChannelName(channel.id, channel.name);
      }

      for (const message of messageArray) {
        // Skip if already in database
        if (this.db.messageExists(message.id)) {
          messagesSkipped++;
          continue;
        }

        // Serialize attachments
        const attachments = this.visionService
          ? this.visionService.serializeAttachments(message)
          : null;

        // Get reply reference
        const replyToMessageId = message.reference?.messageId || null;

        // Process vision if enabled and message has images
        let visionDescriptions = null;
        if (processVision && this.visionService && attachments) {
          const hasImages = attachments.some(a => a.isImage);
          if (hasImages) {
            this.logger.debug(`Backfill: Processing vision for message ${message.id}`);
            visionDescriptions = await this.visionService.processMessageImmediate(message);
            if (visionDescriptions && visionDescriptions.length > 0) {
              imagesProcessed++;
            }
          }
        }

        // Process URLs if enabled and not a bot message
        let urlSummaries = null;
        if (processUrls && this.urlSummarizeService && !message.author.bot) {
          this.logger.debug(`Backfill: Processing URLs for message ${message.id}`);
          urlSummaries = await this.urlSummarizeService.processMessageImmediate(message);
          if (urlSummaries && urlSummaries.length > 0) {
            urlsProcessed++;
          }
        }

        // Store in database
        this.db.insertMessageEnhanced({
          id: message.id,
          channelId: message.channel.id,
          channelName: message.channel.name || null,
          authorId: message.author.id,
          authorName: message.author.username || message.author.displayName || "Unknown",
          content: message.content,
          createdAt: message.createdAt,
          isBotMessage: message.author.bot,
          attachments,
          visionDescriptions,
          urlSummaries,
          replyToMessageId,
          isBackfilled: true
        });

        messagesProcessed++;
      }

      this.logger.info(
        `Backfill complete for channel ${channelId}: ` +
        `${messagesProcessed} added, ${messagesSkipped} skipped, ${imagesProcessed} images processed, ${urlsProcessed} URLs processed`
      );

      return {
        channelId,
        messagesProcessed,
        messagesSkipped,
        imagesProcessed,
        urlsProcessed,
        success: true
      };
    } catch (error) {
      this.logger.error(`Backfill error for channel ${channelId}:`, error);
      return {
        channelId,
        messagesProcessed,
        messagesSkipped,
        imagesProcessed,
        urlsProcessed,
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Check if a channel has recent activity (within maxChannelAgeDays)
   * @param {Channel} channel - Discord channel
   * @returns {Promise<boolean>} True if channel has recent activity
   */
  async hasRecentActivity(channel) {
    try {
      // Fetch just 1 message to check the most recent activity
      const messages = await channel.messages.fetch({ limit: 1 });
      if (messages.size === 0) return false;

      const lastMessage = messages.first();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.maxChannelAgeDays);

      return lastMessage.createdAt >= cutoffDate;
    } catch (error) {
      this.logger.debug(`Could not check activity for channel ${channel.id}: ${error.message}`);
      return false;
    }
  }

  /**
   * Backfill messages from all configured channels
   * Only backfills channels with activity in the last maxChannelAgeDays
   * @param {Client} client - Discord client
   * @param {string[]} channelIds - Array of channel IDs to backfill (empty = all available)
   * @returns {Promise<Object>} Combined backfill results
   */
  async backfillAllChannels(client, channelIds = []) {
    this.logger.info(`Starting backfill (limit: ${this.messageLimit} messages, max age: ${this.maxChannelAgeDays} days)...`);

    const results = {
      totalMessagesProcessed: 0,
      totalMessagesSkipped: 0,
      totalImagesProcessed: 0,
      totalUrlsProcessed: 0,
      channels: [],
      channelsSkipped: 0,
      errors: []
    };

    // If specific channel IDs provided, use those
    // Otherwise, get channels from guilds
    let candidateChannels = [];

    if (channelIds.length > 0) {
      // Fetch specified channels
      for (const channelId of channelIds) {
        try {
          const channel = await client.channels.fetch(channelId);
          if (channel && channel.isTextBased()) {
            candidateChannels.push(channel);
          }
        } catch (error) {
          this.logger.warn(`Could not fetch channel ${channelId}: ${error.message}`);
          results.errors.push({ channelId, error: error.message });
        }
      }
    } else {
      // Get all text channels from all guilds
      for (const guild of client.guilds.cache.values()) {
        for (const channel of guild.channels.cache.values()) {
          if (channel.isTextBased() && !channel.isVoiceBased()) {
            candidateChannels.push(channel);
          }
        }
      }
    }

    this.logger.info(`Found ${candidateChannels.length} candidate channels, checking for recent activity...`);

    // Filter to only channels with recent activity
    let channelsToProcess = [];
    for (const channel of candidateChannels) {
      if (await this.hasRecentActivity(channel)) {
        channelsToProcess.push(channel);
      } else {
        results.channelsSkipped++;
        this.logger.debug(`Skipping channel ${channel.id} (no activity in last ${this.maxChannelAgeDays} days)`);
      }
    }

    this.logger.info(`${channelsToProcess.length} channels have recent activity, ${results.channelsSkipped} skipped`);

    // Process each channel sequentially to avoid rate limits
    for (const channel of channelsToProcess) {
      const result = await this.backfillChannel(channel);
      results.channels.push(result);

      if (result.success) {
        results.totalMessagesProcessed += result.messagesProcessed;
        results.totalMessagesSkipped += result.messagesSkipped;
        results.totalImagesProcessed += result.imagesProcessed;
        results.totalUrlsProcessed += result.urlsProcessed || 0;
      } else {
        results.errors.push({ channelId: channel.id, error: result.error });
      }

      // Small delay between channels to be nice to Discord API
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    this.logger.info(
      `Backfill complete: ${results.totalMessagesProcessed} messages added, ` +
      `${results.totalMessagesSkipped} skipped, ${results.totalImagesProcessed} images processed, ` +
      `${results.totalUrlsProcessed} URLs processed ` +
      `across ${results.channels.length} channels (${results.channelsSkipped} inactive channels skipped)`
    );

    return results;
  }
}

module.exports = BackfillService;
