class MemoryTool {
  constructor(logger, database) {
    this.logger = logger;
    this.db = database;
    this.validCategories = ["fact", "preference", "relationship"];
  }

  /**
   * Store a memory about a user, keyed by their IRC username.
   * @param {Object} params
   * @param {string} params.username - IRC nick the memory is about
   * @param {string} params.category - fact | preference | relationship
   * @param {string} params.content
   * @param {string} [params.source_message_id]
   */
  async remember({ username, category, content, source_message_id = null }) {
    try {
      if (!username || typeof username !== "string") {
        return {
          success: false,
          error: "username is required and must be a string",
        };
      }

      if (!category || !this.validCategories.includes(category)) {
        return {
          success: false,
          error: `category must be one of: ${this.validCategories.join(", ")}`,
        };
      }

      if (!content || typeof content !== "string" || content.trim().length === 0) {
        return {
          success: false,
          error: "content is required and must be a non-empty string",
        };
      }

      const normalizedContent = content.trim();

      const memoryId = this.db.insertMemory({
        username,
        category,
        content: normalizedContent,
        sourceMessageId: source_message_id,
      });

      this.logger.info(
        `Stored ${category} memory for ${username}: "${normalizedContent.substring(0, 50)}..."`
      );

      return {
        success: true,
        output: `Memory stored successfully for ${username}`,
        memoryId,
      };
    } catch (error) {
      this.logger.error("Error storing memory:", error);
      return {
        success: false,
        error: `Failed to store memory: ${error.message}`,
      };
    }
  }
}

module.exports = MemoryTool;
