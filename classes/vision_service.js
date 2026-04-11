const { OpenAI } = require("openai");
const fs = require("fs");
const path = require("path");

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
   * Get cached vision descriptions for a message from database
   * @param {string} messageId - Message ID
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

  // --- IRC image URL processing ---

  /**
   * Image extensions considered for vision processing
   */
  static IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

  /**
   * URL regex for extraction from message content
   */
  static URL_REGEX = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;

  /**
   * Extract image URLs from message text content
   * @param {string} content - Message text
   * @returns {string[]} Array of image URLs
   */
  extractImageUrlsFromContent(content) {
    if (!content || typeof content !== "string") return [];
    const matches = content.match(VisionService.URL_REGEX);
    if (!matches) return [];
    return [...new Set(matches)].filter((url) => {
      try {
        const pathname = new URL(url).pathname.toLowerCase();
        return VisionService.IMAGE_EXTENSIONS.some((ext) => pathname.endsWith(ext));
      } catch {
        return false;
      }
    });
  }

  /**
   * Fetch an image from a URL and cache it locally
   * @param {string} imageUrl - URL of the image
   * @param {string} messageId - Message ID for file naming
   * @param {number} index - Image index within the message
   * @returns {Promise<{base64DataUri: string, localPath: string}|null>}
   */
  async fetchAndCacheImage(imageUrl, messageId, index = 0) {
    try {
      const response = await fetch(imageUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; IsaacBot/1.0)",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        this.logger.warn(`VisionService: Failed to fetch image (${response.status}): ${imageUrl}`);
        return null;
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) {
        this.logger.debug(`VisionService: Not an image content-type (${contentType}): ${imageUrl}`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const sizeMb = buffer.length / (1024 * 1024);
      if (sizeMb > this.maxFileSizeMb) {
        this.logger.debug(`VisionService: Image too large (${sizeMb.toFixed(2)}MB): ${imageUrl}`);
        return null;
      }

      // Determine extension from content-type
      const extMap = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
      const ext = extMap[contentType.split(";")[0]] || ".jpg";

      // Save locally
      const imagesDir = path.join(__dirname, "..", "data", "images");
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
      }
      const filename = `${messageId}_${index}${ext}`;
      const localPath = path.join(imagesDir, filename);
      fs.writeFileSync(localPath, buffer);

      const base64 = buffer.toString("base64");
      const mimeType = contentType.split(";")[0];
      const base64DataUri = `data:${mimeType};base64,${base64}`;

      this.logger.debug(`VisionService: Cached image to ${filename} (${sizeMb.toFixed(2)}MB)`);
      return { base64DataUri, localPath: `/images/${filename}` };
    } catch (error) {
      this.logger.error(`VisionService: Error fetching image ${imageUrl}: ${error.message}`);
      return null;
    }
  }

  /**
   * Describe an image from a URL by downloading it and sending as base64
   * @param {string} imageUrl - URL of the image
   * @param {string} messageId - Message ID for caching
   * @param {number} index - Image index within the message
   * @returns {Promise<{description: string, localPath: string}|null>}
   */
  async describeImageFromUrl(imageUrl, messageId, index = 0) {
    if (!this.openai) {
      this.logger.debug("VisionService: OpenAI client not available");
      return null;
    }

    const cached = await this.fetchAndCacheImage(imageUrl, messageId, index);
    if (!cached) return null;

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
                  url: cached.base64DataUri,
                  detail: "low",
                },
              },
            ],
          },
        ],
        max_tokens: this.maxTokens,
      });

      const description = response.choices[0]?.message?.content?.trim();
      this.logger.debug(`VisionService: Image description: ${description}`);
      return { description, localPath: cached.localPath };
    } catch (error) {
      this.logger.error(`VisionService: Failed to describe image: ${error.message}`);
      return null;
    }
  }

  /**
   * Process image URLs found in message content
   * @param {string} messageId - Message ID
   * @param {string[]} imageUrls - Array of image URLs to process
   * @returns {Promise<string[]>} Array of image descriptions
   */
  async processImageUrls(messageId, imageUrls) {
    if (!this.enabled || !this.openai) return [];

    this.logger.debug(`VisionService: Processing ${imageUrls.length} image URL(s) for message ${messageId}`);

    const descriptions = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const result = await this.describeImageFromUrl(imageUrls[i], messageId, i);
      if (result?.description) {
        descriptions.push(result.description);
      }
    }

    if (this.db && descriptions.length > 0) {
      this.db.updateMessageVision(messageId, descriptions);
      this.logger.info(`VisionService: Cached ${descriptions.length} description(s) for message ${messageId}`);
    }

    return descriptions;
  }
}

module.exports = VisionService;
