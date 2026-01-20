const { OpenAI } = require("openai");

class VisionService {
  constructor(logger, config, database = null) {
    this.logger = logger;
    this.config = config;
    this.db = database;
    this.enabled = config.vision?.enabled ?? false;
    this.supportedFormats = config.vision?.supported_formats || ["png", "jpg", "jpeg", "gif", "webp"];
    this.maxFileSizeMb = config.vision?.max_file_size_mb || 20;

    if (this.enabled && config.openai?.api_key) {
      this.openai = new OpenAI({
        apiKey: config.openai.api_key,
      });
      this.model = config.openai?.model || "gpt-4o";
      this.maxTokens = config.openai?.max_tokens || 300;
      this.logger.info("VisionService initialized with GPT-4o");
    } else {
      this.openai = null;
      this.logger.info("VisionService disabled (no OpenAI API key or vision disabled)");
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
   * Check if an attachment is a supported image type and within size limits
   * @param {Attachment} attachment - Discord attachment object
   * @returns {boolean} True if the image is supported
   */
  isSupportedImage(attachment) {
    if (!attachment) return false;

    // Check file extension
    const fileName = attachment.name?.toLowerCase() || "";
    const extension = fileName.split(".").pop();
    if (!this.supportedFormats.includes(extension)) {
      return false;
    }

    // Check content type if available
    const contentType = attachment.contentType?.toLowerCase() || "";
    if (contentType && !contentType.startsWith("image/")) {
      return false;
    }

    // Check file size (Discord provides size in bytes)
    const fileSizeMb = (attachment.size || 0) / (1024 * 1024);
    if (fileSizeMb > this.maxFileSizeMb) {
      this.logger.debug(`Image ${fileName} exceeds max size (${fileSizeMb.toFixed(2)}MB > ${this.maxFileSizeMb}MB)`);
      return false;
    }

    return true;
  }

  /**
   * Extract image URLs from a Discord message's attachments
   * @param {Message} message - Discord message object
   * @returns {string[]} Array of image URLs
   */
  extractImageUrls(message) {
    if (!message.attachments || message.attachments.size === 0) {
      return [];
    }

    const imageUrls = [];
    message.attachments.forEach((attachment) => {
      if (this.isSupportedImage(attachment)) {
        imageUrls.push(attachment.url);
      }
    });

    return imageUrls;
  }

  /**
   * Call GPT-4o to describe an image
   * @param {string} imageUrl - URL of the image to describe
   * @returns {Promise<string|null>} Image description or null on error
   */
  async describeImage(imageUrl) {
    if (!this.openai) {
      this.logger.debug("VisionService: OpenAI client not available");
      return null;
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Describe this image in 1-2 concise sentences. Focus on the main subject and any notable details. Be direct and factual.",
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl,
                  detail: "low", // Use low detail to minimize costs
                },
              },
            ],
          },
        ],
        max_tokens: this.maxTokens,
      });

      const description = response.choices[0]?.message?.content?.trim();
      this.logger.debug(`Image description: ${description}`);
      return description;
    } catch (error) {
      this.logger.error(`Failed to describe image: ${error.message}`);
      return null;
    }
  }

  /**
   * Process all images in a message and return descriptions
   * @param {Message} message - Discord message object
   * @returns {Promise<string[]>} Array of image descriptions
   */
  async processMessageImages(message) {
    if (!this.enabled || !this.openai) {
      return [];
    }

    const imageUrls = this.extractImageUrls(message);
    if (imageUrls.length === 0) {
      return [];
    }

    this.logger.debug(`Processing ${imageUrls.length} image(s) from message ${message.id}`);

    const descriptions = [];
    for (const url of imageUrls) {
      const description = await this.describeImage(url);
      if (description) {
        descriptions.push(description);
      }
    }

    return descriptions;
  }

  /**
   * Process a single message immediately and cache results in database
   * @param {Message} message - Discord message object
   * @returns {Promise<string[]>} Array of image descriptions (may be empty)
   */
  async processMessageImmediate(message) {
    if (!this.enabled || !this.openai) {
      return [];
    }

    const imageUrls = this.extractImageUrls(message);
    if (imageUrls.length === 0) {
      return [];
    }

    this.logger.debug(`Immediate processing ${imageUrls.length} image(s) from message ${message.id}`);

    const descriptions = [];
    for (const url of imageUrls) {
      const description = await this.describeImage(url);
      if (description) {
        descriptions.push(description);
      }
    }

    // Cache in database if available
    if (this.db && descriptions.length > 0) {
      this.db.updateMessageVision(message.id, descriptions);
      this.logger.debug(`Cached ${descriptions.length} vision description(s) for message ${message.id}`);
    }

    return descriptions;
  }

  /**
   * Get cached vision descriptions for a message from database
   * @param {string} messageId - Discord message ID
   * @returns {string[]|null} Cached descriptions or null if not cached
   */
  getCachedVision(messageId) {
    if (!this.db) return null;

    const message = this.db.getMessage(messageId);
    if (message && message.vision_descriptions && message.vision_descriptions.length > 0) {
      return message.vision_descriptions;
    }
    return null;
  }

  /**
   * Process images from multiple messages and return a Map of message ID to descriptions
   * Checks database cache first before making API calls
   * @param {Collection<Message>} messages - Discord messages collection
   * @returns {Promise<Map<string, string[]>>} Map of message ID to array of descriptions
   */
  async processMessagesImages(messages) {
    if (!this.enabled || !this.openai) {
      return new Map();
    }

    const imageDescriptions = new Map();

    // Convert to array for easier processing
    const messageArray = Array.from(messages.values());

    for (const message of messageArray) {
      // Check cache first
      const cached = this.getCachedVision(message.id);
      if (cached) {
        imageDescriptions.set(message.id, cached);
        this.logger.debug(`Using cached vision for message ${message.id}`);
        continue;
      }

      // Not cached, process now
      const descriptions = await this.processMessageImages(message);
      if (descriptions.length > 0) {
        imageDescriptions.set(message.id, descriptions);

        // Cache the results if we have database access
        if (this.db) {
          this.db.updateMessageVision(message.id, descriptions);
        }
      }
    }

    if (imageDescriptions.size > 0) {
      this.logger.info(`Processed images from ${imageDescriptions.size} message(s)`);
    }

    return imageDescriptions;
  }

  /**
   * Build image descriptions map from database records
   * @param {Array} dbMessages - Array of message records from database
   * @returns {Map<string, string[]>} Map of message ID to descriptions
   */
  buildImageDescriptionsFromDB(dbMessages) {
    const imageDescriptions = new Map();

    for (const msg of dbMessages) {
      if (msg.vision_descriptions) {
        const descriptions = typeof msg.vision_descriptions === 'string'
          ? JSON.parse(msg.vision_descriptions)
          : msg.vision_descriptions;

        if (descriptions && descriptions.length > 0) {
          imageDescriptions.set(msg.id, descriptions);
        }
      }
    }

    return imageDescriptions;
  }

  /**
   * Serialize attachments from a Discord message
   * @param {Message} message - Discord message object
   * @returns {Array|null} Array of attachment objects or null
   */
  serializeAttachments(message) {
    if (!message.attachments || message.attachments.size === 0) {
      return null;
    }

    const attachments = [];
    message.attachments.forEach((attachment) => {
      attachments.push({
        id: attachment.id,
        name: attachment.name,
        url: attachment.url,
        proxyURL: attachment.proxyURL,
        size: attachment.size,
        contentType: attachment.contentType,
        width: attachment.width,
        height: attachment.height,
        isImage: this.isSupportedImage(attachment)
      });
    });

    return attachments.length > 0 ? attachments : null;
  }
}

module.exports = VisionService;
