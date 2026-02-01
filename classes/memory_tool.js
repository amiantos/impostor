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

      // Check for duplicate/similar memories before inserting
      const existingMemories = this.db.getMemoriesForUser(user_id, 50);
      const isDuplicate = this.checkForDuplicate(normalizedContent, existingMemories);
      if (isDuplicate) {
        this.logger.info(`Skipped duplicate memory for ${actualUsername}: "${normalizedContent.substring(0, 50)}..."`);
        return {
          success: true,
          output: `Memory already exists for ${actualUsername}, skipped duplicate`,
          skipped: true
        };
      }

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
  /**
   * Check if a memory is a duplicate of existing memories
   * @param {string} newContent - The new memory content
   * @param {Array} existingMemories - Existing memories for the user
   * @returns {boolean} True if duplicate
   */
  checkForDuplicate(newContent, existingMemories) {
    const newLower = newContent.toLowerCase().trim();

    for (const memory of existingMemories) {
      const existingLower = memory.content.toLowerCase().trim();

      // Exact match
      if (newLower === existingLower) {
        return true;
      }

      // One contains the other (catches "software engineer" vs "works as a software engineer")
      if (newLower.includes(existingLower) || existingLower.includes(newLower)) {
        return true;
      }

      // High word overlap (>70% of words match)
      const newWords = new Set(newLower.split(/\s+/).filter(w => w.length > 2));
      const existingWords = new Set(existingLower.split(/\s+/).filter(w => w.length > 2));

      if (newWords.size > 0 && existingWords.size > 0) {
        const intersection = [...newWords].filter(w => existingWords.has(w));
        const overlapRatio = intersection.length / Math.min(newWords.size, existingWords.size);
        if (overlapRatio > 0.7) {
          return true;
        }
      }
    }

    return false;
  }
}

module.exports = MemoryTool;
