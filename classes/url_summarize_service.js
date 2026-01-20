const axios = require('axios');

/**
 * UrlSummarizeService - Proactive URL detection and summarization
 *
 * Detects URLs in messages, summarizes them using Kagi Universal Summarizer,
 * and caches results in the database for context building.
 */
class UrlSummarizeService {
  constructor(logger, config, database = null) {
    this.logger = logger;
    this.config = config;
    this.db = database;

    // Service configuration
    const urlConfig = config.url_summarize || {};
    this.enabled = urlConfig.enabled ?? true;
    this.summaryType = urlConfig.summary_type || 'takeaway';
    this.maxUrlsPerMessage = urlConfig.max_urls_per_message || 3;
    this.skipDomains = urlConfig.skip_domains || [
      'cdn.discordapp.com',
      'media.discordapp.net',
      'tenor.com',
      'giphy.com',
      'tenor.co'
    ];

    // Kagi API configuration
    this.apiKey = config.kagi?.api_key;
    this.baseUrl = 'https://kagi.com/api/v0/summarize';
    this.timeout = 30000; // 30 second timeout

    // URL regex for extraction
    this.urlRegex = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;

    // Image extensions to skip
    this.imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'];

    if (this.enabled && this.apiKey) {
      this.logger.info('UrlSummarizeService initialized');
    } else if (this.enabled && !this.apiKey) {
      this.logger.info('UrlSummarizeService disabled (no Kagi API key)');
      this.enabled = false;
    } else {
      this.logger.info('UrlSummarizeService disabled by config');
    }
  }

  /**
   * Set database reference (for late initialization)
   * @param {DatabaseManager} database - Database manager instance
   */
  setDatabase(database) {
    this.db = database;
  }

  /**
   * Extract URLs from message content
   * @param {string} content - Message content
   * @returns {string[]} Array of URLs found
   */
  extractUrls(content) {
    if (!content || typeof content !== 'string') {
      return [];
    }

    const matches = content.match(this.urlRegex);
    return matches ? [...new Set(matches)] : []; // Deduplicate
  }

  /**
   * Check if a URL should be summarized
   * @param {string} url - URL to check
   * @returns {boolean} True if the URL should be summarized
   */
  shouldSummarizeUrl(url) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();
      const pathname = urlObj.pathname.toLowerCase();

      // Skip Discord CDN and media
      for (const domain of this.skipDomains) {
        if (hostname.includes(domain)) {
          return false;
        }
      }

      // Skip image file extensions
      for (const ext of this.imageExtensions) {
        if (pathname.endsWith(ext)) {
          return false;
        }
      }

      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Summarize a single URL using Kagi Universal Summarizer
   * @param {string} url - URL to summarize
   * @returns {Promise<Object|null>} Summary object or null on error
   */
  async summarizeUrl(url) {
    if (!this.apiKey) {
      this.logger.debug('UrlSummarizeService: No API key configured');
      return null;
    }

    try {
      this.logger.debug(`Summarizing URL: ${url}`);

      const response = await axios.get(this.baseUrl, {
        params: {
          url: url,
          summary_type: this.summaryType,
          engine: 'cecil'
        },
        headers: {
          'Authorization': `Bot ${this.apiKey}`,
          'Accept': 'application/json'
        },
        timeout: this.timeout
      });

      // Check for API errors
      if (response.data.error) {
        this.logger.warn(`Kagi API error for ${url}: ${JSON.stringify(response.data.error)}`);
        return null;
      }

      const data = response.data.data;
      if (!data || !data.output) {
        this.logger.warn(`No summary returned for ${url}`);
        return null;
      }

      this.logger.debug(`Successfully summarized: ${url}`);

      return {
        url: url,
        summary: data.output,
        summary_type: this.summaryType,
        summarized_at: new Date().toISOString()
      };
    } catch (error) {
      let errorMessage = error.message;
      if (error.code === 'ECONNABORTED') {
        errorMessage = 'Request timed out';
      } else if (error.response) {
        errorMessage = `HTTP ${error.response.status}`;
      }
      this.logger.warn(`Failed to summarize ${url}: ${errorMessage}`);
      return null;
    }
  }

  /**
   * Process a message immediately and return URL summaries
   * @param {Message} message - Discord message object
   * @returns {Promise<Array>} Array of URL summary objects (may be empty)
   */
  async processMessageImmediate(message) {
    if (!this.enabled || !this.apiKey) {
      return [];
    }

    const urls = this.extractUrls(message.content);
    if (urls.length === 0) {
      return [];
    }

    // Filter to summarizable URLs
    const urlsToSummarize = urls
      .filter(url => this.shouldSummarizeUrl(url))
      .slice(0, this.maxUrlsPerMessage);

    if (urlsToSummarize.length === 0) {
      return [];
    }

    this.logger.debug(`Processing ${urlsToSummarize.length} URL(s) from message ${message.id}`);

    const summaries = [];
    for (const url of urlsToSummarize) {
      const summary = await this.summarizeUrl(url);
      if (summary) {
        summaries.push(summary);
      }
    }

    // Cache in database if available
    if (this.db && summaries.length > 0) {
      this.db.updateMessageUrlSummaries(message.id, summaries);
      this.logger.debug(`Cached ${summaries.length} URL summary(ies) for message ${message.id}`);
    }

    return summaries;
  }

  /**
   * Get cached URL summaries for a message from database
   * @param {string} messageId - Discord message ID
   * @returns {Array|null} Cached summaries or null if not cached
   */
  getCachedSummaries(messageId) {
    if (!this.db) return null;

    const message = this.db.getMessage(messageId);
    if (message && message.url_summaries && message.url_summaries.length > 0) {
      return message.url_summaries;
    }
    return null;
  }

  /**
   * Build URL summaries map from database records
   * @param {Array} dbMessages - Array of message records from database
   * @returns {Map<string, Array>} Map of message ID to summaries array
   */
  buildUrlSummariesFromDB(dbMessages) {
    const urlSummaries = new Map();

    for (const msg of dbMessages) {
      if (msg.url_summaries) {
        const summaries = typeof msg.url_summaries === 'string'
          ? JSON.parse(msg.url_summaries)
          : msg.url_summaries;

        if (summaries && summaries.length > 0) {
          urlSummaries.set(msg.id, summaries);
        }
      }
    }

    return urlSummaries;
  }

  /**
   * Process URLs from multiple messages (for backfill)
   * Checks database cache first before making API calls
   * @param {Array} messages - Array of messages (Discord Message objects or DB records)
   * @param {boolean} fromDb - Whether messages are from database records
   * @returns {Promise<Map<string, Array>>} Map of message ID to summaries array
   */
  async processMessagesUrls(messages, fromDb = false) {
    if (!this.enabled || !this.apiKey) {
      return new Map();
    }

    const urlSummaries = new Map();

    for (const message of messages) {
      const messageId = message.id;
      const content = fromDb ? message.content : message.content;

      // Check cache first
      const cached = this.getCachedSummaries(messageId);
      if (cached) {
        urlSummaries.set(messageId, cached);
        this.logger.debug(`Using cached URL summaries for message ${messageId}`);
        continue;
      }

      // Extract and filter URLs
      const urls = this.extractUrls(content);
      const urlsToSummarize = urls
        .filter(url => this.shouldSummarizeUrl(url))
        .slice(0, this.maxUrlsPerMessage);

      if (urlsToSummarize.length === 0) {
        continue;
      }

      // Process URLs
      const summaries = [];
      for (const url of urlsToSummarize) {
        const summary = await this.summarizeUrl(url);
        if (summary) {
          summaries.push(summary);
        }
      }

      if (summaries.length > 0) {
        urlSummaries.set(messageId, summaries);

        // Cache the results if we have database access
        if (this.db) {
          this.db.updateMessageUrlSummaries(messageId, summaries);
        }
      }
    }

    if (urlSummaries.size > 0) {
      this.logger.info(`Processed URLs from ${urlSummaries.size} message(s)`);
    }

    return urlSummaries;
  }
}

module.exports = UrlSummarizeService;
