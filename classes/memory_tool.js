class MemoryTool {
  constructor(logger, database) {
    this.logger = logger;
    this.db = database;
    this.validCategories = ["fact", "preference", "relationship"];
  }

  /**
   * Store a memory about a user
   * @param {Object} params - Memory parameters
   * @param {string} params.user_id - Discord user ID
   * @param {string} params.username - Discord username
   * @param {string} params.category - Memory category (fact, preference, relationship)
   * @param {string} params.content - The memory content
   * @param {string} params.source_message_id - Optional source message ID
   * @returns {Object} Result with success/error
   */
  async remember({ user_id, username, category, content, source_message_id = null }) {
    try {
      // Validate inputs
      if (!user_id || typeof user_id !== "string") {
        return {
          success: false,
          error: "user_id is required and must be a string"
        };
      }

      if (!username || typeof username !== "string") {
        return {
          success: false,
          error: "username is required and must be a string"
        };
      }

      if (!category || !this.validCategories.includes(category)) {
        return {
          success: false,
          error: `category must be one of: ${this.validCategories.join(", ")}`
        };
      }

      if (!content || typeof content !== "string" || content.trim().length === 0) {
        return {
          success: false,
          error: "content is required and must be a non-empty string"
        };
      }

      // Trim and normalize content
      const normalizedContent = content.trim();

      // Get the real username from the database if available
      // (AI might misspell it, so prefer DB data)
      let actualUsername = username;
      const existingUser = this.db.getUser(user_id);
      if (existingUser && existingUser.username) {
        actualUsername = existingUser.username;
      } else {
        // Try to find username from recent messages
        const userFromMessages = this.db.getUsernameFromMessages(user_id);
        if (userFromMessages) {
          actualUsername = userFromMessages;
        }
      }

      // Upsert user record with the correct username
      this.db.upsertUser(user_id, actualUsername);

      // Insert memory
      const memoryId = this.db.insertMemory({
        userId: user_id,
        category,
        content: normalizedContent,
        sourceMessageId: source_message_id
      });

      this.logger.info(`Stored ${category} memory for user ${actualUsername} (${user_id}): "${normalizedContent.substring(0, 50)}..."`);

      return {
        success: true,
        output: `Memory stored successfully for ${actualUsername}`,
        memoryId
      };
    } catch (error) {
      this.logger.error("Error storing memory:", error);
      return {
        success: false,
        error: `Failed to store memory: ${error.message}`
      };
    }
  }
}

module.exports = MemoryTool;
