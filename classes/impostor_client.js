const { Client, IntentsBitField } = require("discord.js");
const ContextUtils = require("./context_utils");
const PythonTool = require("./python_tool");
const WebSearchTool = require("./web_search_tool");
const WebFetchTool = require("./web_fetch_tool");
const DatabaseManager = require("./database");
const MessageTracker = require("./message_tracker");
const ResponseEvaluator = require("./response_evaluator");
const VisionService = require("./vision_service");
const UrlSummarizeService = require("./url_summarize_service");
const BackfillService = require("./backfill_service");
const { OpenAI } = require("openai");

class ImpostorClient {
  constructor(logger, config) {
    this.contextUtils = new ContextUtils(logger);
    this.config = config;
    this.logger = logger;
    this.client = new Client({
      intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent,
      ],
    });
    this.openai = new OpenAI({
      apiKey: config.generator.deepseek.api_key,
      baseURL: config.generator.deepseek.base_url,
    });

    // Message queue system
    this.messageQueue = [];
    this.isProcessing = false;

    // Debounce timers for autonomous evaluation (channelId -> timer)
    this.evaluationTimers = new Map();

    // Initialize tools
    this.pythonTool = new PythonTool(logger);
    this.webSearchTool = new WebSearchTool(logger, config);
    this.webFetchTool = new WebFetchTool(logger);

    // Initialize database
    this.db = new DatabaseManager(logger);
    this.db.initialize();

    // Initialize vision service with database for caching
    this.visionService = new VisionService(logger, config, this.db);

    // Initialize URL summarize service with database for caching
    this.urlSummarizeService = new UrlSummarizeService(logger, config, this.db);

    // Initialize message tracker with vision and URL summarize services
    this.messageTracker = new MessageTracker(logger, this.db, config, this.visionService, this.urlSummarizeService);
    this.evaluator = new ResponseEvaluator(logger, config, this.db, this.visionService);

    // Initialize backfill service
    this.backfillService = new BackfillService(logger, this.db, this.visionService, this.urlSummarizeService, config);

    // Set up periodic maintenance
    this.maintenanceInterval = setInterval(() => {
      this.messageTracker.runMaintenance();
    }, 60 * 60 * 1000); // Run every hour

    this.client.on("ready", async () => {
      this.logger.info(`The bot is online as ${this.client.user.tag}!`);

      // Run backfill on startup for configured channels
      if (config.backfill?.enabled ?? true) {
        const channelIds = config.channels || [];
        await this.backfillService.backfillAllChannels(this.client, channelIds);
      }
    });

    this.client.on("messageCreate", async (message) => {
      this.handleMessageCreate(message);
    });
  }

  async login() {
    await this.client.login(this.config.bot.token);
  }

  /**
   * Check if a channel is in the allowed list
   * @param {Message} message - Discord message
   * @returns {boolean} True if channel is allowed
   */
  isAllowedChannel(message) {
    if (this.config.channels.length === 0) return true;
    return this.config.channels.some((element) =>
      message.channel.id.includes(element)
    );
  }

  /**
   * Check if a message is a direct trigger (mention or reply to bot)
   * @param {Message} message - Discord message
   * @returns {boolean} True if message directly triggers the bot
   */
  isDirectTrigger(message) {
    // Check if message mentions the bot
    if (message.content.includes(this.client.user.id)) return true;

    // Check if message is a reply to the bot
    if (
      message.mentions.repliedUser &&
      message.mentions.repliedUser.id === this.client.user.id
    ) {
      return true;
    }

    return false;
  }

  async handleMessageCreate(message) {
    // Ignore bot messages (including our own)
    if (message.author.bot) return;

    // Check channel filtering
    if (!this.isAllowedChannel(message)) return;

    // Always track the message with vision processing (for autonomous responses)
    const isBotMessage = message.author.id === this.client.user.id;
    await this.messageTracker.addMessage(message, { isBotMessage, processVision: true });

    // Direct trigger (existing behavior) - @mention or reply to bot
    if (this.isDirectTrigger(message)) {
      this.logger.info(
        `Queuing direct message from @${message.author.username}.`,
        message
      );

      this.messageQueue.push({ message, type: "direct" });

      if (!this.isProcessing) {
        this.processMessageQueue();
      }
      return;
    }

    // Autonomous response evaluation (debounced)
    if (this.config.autonomous?.enabled) {
      this.scheduleAutonomousEvaluation(message.channel, message);
    }
  }

  /**
   * Schedule an autonomous evaluation with debouncing
   * Waits for conversation to settle before evaluating
   * @param {Channel} channel - Discord channel
   * @param {Message} message - Discord message that triggered the evaluation
   */
  scheduleAutonomousEvaluation(channel, message) {
    const channelId = channel.id;

    // Use shorter debounce if "isaac" is mentioned (likely being addressed)
    const mentionsIsaac = message && /\bisaac\b/i.test(message.content);
    const debounceMs = mentionsIsaac
      ? 3000
      : (this.config.autonomous?.debounce_seconds || 10) * 1000;

    // Clear any existing timer for this channel
    if (this.evaluationTimers.has(channelId)) {
      clearTimeout(this.evaluationTimers.get(channelId));
      this.logger.debug(`Reset evaluation timer for channel ${channelId}`);
    }

    // Set new timer
    const timer = setTimeout(async () => {
      this.evaluationTimers.delete(channelId);
      this.logger.debug(`Evaluation timer fired for channel ${channelId}`);
      await this.evaluateAutonomousResponse(channel);
    }, debounceMs);

    this.evaluationTimers.set(channelId, timer);
    this.logger.debug(`Scheduled evaluation for channel ${channelId} in ${debounceMs / 1000}s`);
  }

  /**
   * Evaluate whether to send an autonomous response
   * Called after debounce timer fires
   * @param {Channel} channel - Discord channel
   */
  async evaluateAutonomousResponse(channel) {
    // Get ALL recent messages for ratio calculation (50 messages)
    const recentMessages = this.db.getRecentMessages(channel.id, 50, true);

    // Calculate bot dominance ratio (passed to AI evaluator for context)
    const botRatio = this.evaluator.calculateBotRatio(
      recentMessages,
      this.client.user.id
    );

    // Check if there are any messages after the bot's last response
    const hasNewMessages = this.hasMessagesSinceLastBotResponse(recentMessages);
    if (!hasNewMessages) {
      this.logger.debug("No new messages since last bot response");
      return;
    }

    // Get evaluation context: includes context before bot's last response + bot's response + new messages
    const evaluationMessages = this.getMessagesForEvaluation(recentMessages, 5);

    // Ask AI if we should respond (pass ratio for context)
    const decision = await this.evaluator.shouldRespond(
      evaluationMessages,
      this.client.user.id,
      channel.id,
      botRatio
    );

    if (decision.should_respond) {
      this.logger.info(
        `Queueing autonomous response for channel ${channel.id}: ${decision.reason}`
      );

      this.messageQueue.push({
        channel,
        type: "autonomous",
        decisionId: decision.decisionId,
      });

      if (!this.isProcessing) {
        this.processMessageQueue();
      }
    }
  }

  /**
   * Check if there are any messages since the bot's last response
   * @param {Array} messages - Parsed messages from database (newest first)
   * @returns {boolean} True if there are new messages to evaluate
   */
  hasMessagesSinceLastBotResponse(messages) {
    if (!messages || messages.length === 0) return false;
    // If the newest message is from the bot, there's nothing new to evaluate
    return !messages[0].is_bot_message;
  }

  /**
   * Get messages for evaluation context, including bot's last response with surrounding context
   * Applies time-based filtering to exclude old/irrelevant messages
   * @param {Array} messages - Parsed messages from database (newest first)
   * @param {number} contextBefore - Number of messages to include before bot's last response (default 5)
   * @param {number} maxAgeMinutes - Maximum age of messages to include (default 30)
   * @param {number} maxGapMinutes - Maximum gap between messages before treating as new conversation (default 30)
   * @returns {Array} Messages with context (oldest first)
   */
  getMessagesForEvaluation(messages, contextBefore = 5, maxAgeMinutes = null, maxGapMinutes = null) {
    // Use config values if not specified
    maxAgeMinutes = maxAgeMinutes ?? this.config.autonomous?.max_context_age_minutes ?? 30;
    maxGapMinutes = maxGapMinutes ?? this.config.autonomous?.max_conversation_gap_minutes ?? 30;

    // Step 1: Filter messages to recent time window
    const cutoffTime = Date.now() - maxAgeMinutes * 60 * 1000;
    const recentMessages = messages.filter(m => {
      const msgTime = new Date(m.created_at).getTime();
      return msgTime >= cutoffTime;
    });

    if (recentMessages.length === 0) {
      this.logger.debug(`No messages within ${maxAgeMinutes} minute window`);
      return [];
    }

    // Step 2: Filter out messages from before conversation gaps
    const filteredMessages = this.filterByConversationGaps(recentMessages, maxGapMinutes);

    if (filteredMessages.length === 0) {
      return [];
    }

    // Step 3: Apply existing logic to find bot's last message and build context
    // Messages come in newest-first order, find the last bot message
    let lastBotIndex = -1;
    for (let i = 0; i < filteredMessages.length; i++) {
      if (filteredMessages[i].is_bot_message) {
        lastBotIndex = i;
        break;
      }
    }

    if (lastBotIndex === -1) {
      // No bot messages, return all filtered messages (reversed to oldest first)
      return [...filteredMessages].reverse();
    }

    // Build context: messages before bot + bot message + messages after bot
    // In newest-first order:
    //   - messages.slice(0, lastBotIndex) = messages AFTER bot spoke (chronologically)
    //   - messages[lastBotIndex] = bot's message
    //   - messages.slice(lastBotIndex + 1, ...) = messages BEFORE bot spoke (chronologically)

    const messagesAfterBot = filteredMessages.slice(0, lastBotIndex);
    const botMessage = filteredMessages[lastBotIndex];
    const messagesBeforeBot = filteredMessages.slice(
      lastBotIndex + 1,
      lastBotIndex + 1 + contextBefore
    );

    // Combine in chronological order (oldest first)
    return [...messagesBeforeBot.reverse(), botMessage, ...messagesAfterBot.reverse()];
  }

  /**
   * Filter messages by conversation gaps - removes messages from before large time gaps
   * This handles cases where a new conversation starts after a long pause
   * @param {Array} messages - Messages in newest-first order
   * @param {number} maxGapMinutes - Maximum allowed gap between messages
   * @returns {Array} Filtered messages (newest-first order)
   */
  filterByConversationGaps(messages, maxGapMinutes) {
    if (messages.length <= 1) {
      return messages;
    }

    const maxGapMs = maxGapMinutes * 60 * 1000;

    // Walk through newest-to-oldest and find the first large gap
    for (let i = 0; i < messages.length - 1; i++) {
      const currentTime = new Date(messages[i].created_at).getTime();
      const nextTime = new Date(messages[i + 1].created_at).getTime();
      const gap = currentTime - nextTime;

      if (gap > maxGapMs) {
        // Found a large gap, only keep messages after this point (newer messages)
        this.logger.debug(`Found ${Math.round(gap / 60000)} minute conversation gap, excluding ${messages.length - i - 1} older messages`);
        return messages.slice(0, i + 1);
      }
    }

    return messages; // No large gaps found
  }

  async processMessageQueue() {
    if (this.isProcessing) return;

    this.isProcessing = true;

    while (this.messageQueue.length > 0) {
      const queueItem = this.messageQueue.shift();

      try {
        if (queueItem.type === "direct") {
          this.logger.info(
            `Processing direct message from @${queueItem.message.author.username}. Queue length: ${this.messageQueue.length}`
          );
          await this.processDirectMessage(queueItem.message);
        } else if (queueItem.type === "autonomous") {
          this.logger.info(
            `Processing autonomous response for channel ${queueItem.channel.id}. Queue length: ${this.messageQueue.length}`
          );
          await this.processAutonomousMessage(queueItem.channel, queueItem.decisionId);
        }

        // Add a small delay between messages to appear more natural
        if (this.messageQueue.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        this.logger.error("Error processing queued message:", error);
        if (queueItem.type === "direct" && queueItem.message) {
          await this.sendErrorResponse(queueItem.message, error);
        }
      }
    }

    this.isProcessing = false;
  }

  /**
   * Build context from database instead of fetching from Discord
   * Uses the same filtering logic as evaluation for consistency
   * @param {string} channelId - Discord channel ID
   * @param {Object} options - Configuration options
   * @param {number} options.fetchLimit - Maximum messages to fetch from DB (default 50)
   * @param {number} options.contextBefore - Messages to include before bot's last response (default 5)
   * @param {boolean} options.useFiltering - Whether to apply time/gap filtering (default true)
   * @returns {Object} Context object with messages, imageDescriptions, and urlSummaries
   */
  buildContextFromDatabase(channelId, options = {}) {
    const {
      fetchLimit = 50,
      contextBefore = 5,
      useFiltering = true
    } = options;

    let dbMessages;
    if (useFiltering) {
      // Fetch raw messages then apply evaluation filtering
      const rawMessages = this.db.getRecentMessages(channelId, fetchLimit, true);
      dbMessages = this.getMessagesForEvaluation(rawMessages, contextBefore);
    } else {
      dbMessages = this.db.getRecentMessages(channelId, fetchLimit, true);
    }

    // Build image descriptions map from cached vision data
    const imageDescriptions = this.visionService.buildImageDescriptionsFromDB(dbMessages);

    // Build URL summaries map from cached URL data
    const urlSummaries = this.urlSummarizeService.buildUrlSummariesFromDB(dbMessages);

    return {
      dbMessages,
      imageDescriptions,
      urlSummaries
    };
  }

  /**
   * Process a direct message (existing behavior)
   * @param {Message} message - Discord message that triggered the bot
   */
  async processDirectMessage(message) {
    const user_name = message.author.username
      .replace(/\s+/g, "_")
      .replace(/[^\w\s]/gi, "");
    const character_name = this.client.user.username;

    await message.channel.sendTyping();

    // Build context from database (with cached vision)
    const { dbMessages, imageDescriptions } = this.buildContextFromDatabase(message.channel.id, {
      fetchLimit: 50,
      contextBefore: 10  // More context for direct mentions
    });

    // Build trigger info for the consolidated chatlog format
    const triggerInfo = {
      userId: message.author.id,
      userName: message.author.username,
      channelName: message.channel.name || "channel",
    };

    const { response, conversationLog } = await this.generateResponseWithChatCompletions({
      dbMessages,
      userName: user_name,
      characterName: character_name,
      botUserId: this.client.user.id,
      imageDescriptions,
      useDbContext: true,
      triggerInfo,
    });

    // Send to channel (not as a reply) - the bot knows who it's talking to from context
    const sentMessage = await message.channel.send(response);

    // Log the response with trigger message ID
    const responseId = this.db.logResponse(
      message.channel.id,
      sentMessage.id,
      "direct",
      response,
      message.id
    );

    // Store the full prompt for debugging
    this.db.storePrompt({
      responseId,
      promptType: "response",
      systemPrompt: this.contextUtils.buildInstructions(),
      messagesJson: conversationLog,
      model: this.config.generator.deepseek.model,
      temperature: this.config.generator.deepseek.temperature
    });

    // Track the bot's own message
    await this.messageTracker.addMessage(sentMessage, { isBotMessage: true, processVision: false });
    this.messageTracker.markResponded(message.channel.id);

    // Cancel any pending evaluation for this channel
    this.cancelEvaluationTimer(message.channel.id);
  }

  /**
   * Cancel a pending evaluation timer for a channel
   * @param {string} channelId - Discord channel ID
   */
  cancelEvaluationTimer(channelId) {
    if (this.evaluationTimers.has(channelId)) {
      clearTimeout(this.evaluationTimers.get(channelId));
      this.evaluationTimers.delete(channelId);
      this.logger.debug(`Cancelled evaluation timer for channel ${channelId}`);
    }
  }

  /**
   * Process an autonomous message
   * @param {Channel} channel - Discord channel to respond in
   * @param {number|null} decisionId - Optional decision ID that triggered this response
   */
  async processAutonomousMessage(channel, decisionId = null) {
    await channel.sendTyping();

    // Build context from database (with cached vision)
    const { dbMessages, imageDescriptions } = this.buildContextFromDatabase(channel.id, {
      fetchLimit: 50,
      contextBefore: 5  // Match evaluation settings
    });

    // For autonomous responses, find the most recent non-bot message to potentially address
    // But don't set a specific target - let the bot respond naturally to the conversation
    const triggerInfo = {
      userId: null,
      userName: null,
      channelName: channel.name || "channel",
    };

    const { response, conversationLog } = await this.generateResponseWithChatCompletions({
      dbMessages,
      userName: "various",
      characterName: this.client.user.username,
      botUserId: this.client.user.id,
      imageDescriptions,
      useDbContext: true,
      triggerInfo,
    });

    // Send to channel (not as a reply) - the bot addresses users naturally in its response
    const sentMessage = await channel.send(response);

    // Log the response
    const responseId = this.db.logResponse(
      channel.id,
      sentMessage.id,
      "autonomous",
      response,
      null  // No specific trigger message for autonomous responses
    );

    // Store the full prompt for debugging
    this.db.storePrompt({
      responseId,
      promptType: "response",
      systemPrompt: this.contextUtils.buildInstructions(),
      messagesJson: conversationLog,
      model: this.config.generator.deepseek.model,
      temperature: this.config.generator.deepseek.temperature
    });

    // Mark the decision as having sent a response
    if (decisionId) {
      this.db.markDecisionResponseSent(decisionId);
    }

    // Track the bot's own message
    await this.messageTracker.addMessage(sentMessage, { isBotMessage: true, processVision: false });
    this.messageTracker.markResponded(channel.id);

    // Cancel any pending evaluation for this channel (we just responded)
    this.cancelEvaluationTimer(channel.id);
  }

  async generateResponseWithChatCompletions({
    messages = null,
    dbMessages = null,
    userName,
    characterName,
    botUserId,
    imageDescriptions = null,
    useDbContext = false,
    triggerInfo = null,
  }) {
    const systemPrompt = this.contextUtils.buildInstructions();
    this.logger.debug("Generated System Prompt...", systemPrompt);

    let inputMessages;
    if (useDbContext && dbMessages && triggerInfo) {
      // Use consolidated chatlog format with trigger info
      inputMessages = this.contextUtils.buildChatMessagesConsolidated(
        dbMessages,
        botUserId,
        triggerInfo,
        imageDescriptions
      );
    } else if (useDbContext && dbMessages) {
      // Fallback to old method if no triggerInfo (shouldn't happen)
      inputMessages = this.contextUtils.buildChatMessagesFromDBRecords(
        dbMessages,
        botUserId,
        imageDescriptions
      );
    } else if (messages) {
      // Fallback to Discord messages
      inputMessages = this.contextUtils.buildChatMessagesForResponsesAPI(
        messages,
        botUserId,
        imageDescriptions
      );
    } else {
      throw new Error("Either messages or dbMessages must be provided");
    }

    // Create initial conversation log
    let conversationLog = [
      {
        role: "system",
        content: systemPrompt,
      },
      ...inputMessages,
    ];

    this.logger.debug("Generated Messages...", conversationLog);

    // First API call - check if tools are needed
    let response = await this.callDeepSeek(conversationLog);
    let structuredResponse = await this.parseStructuredResponse(response);

    let iterationCount = 0;
    const maxIterations = 10; // Prevent infinite loops
    let allToolResults = [];

    // Tool execution loop - can iterate multiple times
    while (
      structuredResponse.needs_tool &&
      structuredResponse.tool_request &&
      iterationCount < maxIterations
    ) {
      iterationCount++;
      this.logger.info(
        `Tool execution iteration ${iterationCount}:`,
        structuredResponse.tool_request
      );

      // Execute the requested tool
      const toolResult = await this.executeTool(structuredResponse.tool_request);
      allToolResults.push({
        tool: structuredResponse.tool_request.tool_name,
        success: toolResult.success,
        iteration: iterationCount,
        code: structuredResponse.tool_request.code,
        query: structuredResponse.tool_request.query,
        url: structuredResponse.tool_request.url,
        output: toolResult.output,
        error: toolResult.error,
        reason: structuredResponse.tool_request.reason,
      });

      // Add tool result to conversation
      conversationLog.push({
        role: "assistant",
        content: JSON.stringify(structuredResponse),
      });

      if (structuredResponse.continue_iterating) {
        // Build iteration summary for context
        const iterationSummary = this.buildIterationSummary(
          allToolResults,
          iterationCount
        );
        conversationLog.push({
          role: "user",
          content: `Tool execution result: ${JSON.stringify(toolResult)}

ITERATION HISTORY:
${iterationSummary}

REFLECTION: Look at your previous attempts above. What worked? What didn't? How can you adjust your approach based on the results? If you're close to the target (like 1-2 characters off), make small adjustments. Continue iterating to refine your approach, or provide your final response if satisfied.`,
        });
      } else {
        conversationLog.push({
          role: "user",
          content: `Tool execution result: ${JSON.stringify(toolResult)}. Now provide your final response with the actual message.`,
        });
      }

      // Next API call with tool results
      response = await this.callDeepSeek(conversationLog);
      structuredResponse = await this.parseStructuredResponse(response);

      // If not continuing to iterate, break the loop
      if (!structuredResponse.continue_iterating) {
        break;
      }
    }

    if (iterationCount >= maxIterations) {
      this.logger.warn(
        `Reached maximum iterations (${maxIterations}), stopping tool execution`
      );
    }

    // Extract final message
    let replyMessage =
      structuredResponse.message || "Something went wrong with my processing.";

    if (replyMessage.length > 2000) {
      this.logger.warn("Message too long, truncating.");
      replyMessage = replyMessage.substring(0, 2000);
    }

    return {
      response: replyMessage,
      conversationLog
    };
  }

  async callDeepSeek(conversationLog) {
    return await this.openai.chat.completions.create({
      model: this.config.generator.deepseek.model,
      messages: conversationLog,
      max_tokens: this.config.generator.deepseek.max_tokens,
      temperature: this.config.generator.deepseek.temperature,
      response_format: { type: "json_object" },
    });
  }

  async parseStructuredResponse(response) {
    this.logger.info("Received response - ", response);

    const rawResponse = response.choices[0].message.content;

    try {
      const structuredResponse = JSON.parse(rawResponse);
      this.logger.debug("Parsed structured response:", structuredResponse);

      return structuredResponse;
    } catch (error) {
      this.logger.error("Failed to parse JSON response:", error);
      this.logger.debug("Raw response was:", rawResponse);

      // Return a fallback structure
      return {
        needs_tool: false,
        continue_iterating: false,
        message: rawResponse || "Error parsing response.",
      };
    }
  }

  buildIterationSummary(allToolResults, currentIteration) {
    let summary = "";
    for (let i = 0; i < allToolResults.length; i++) {
      const result = allToolResults[i];
      summary += `Iteration ${result.iteration}:\n`;
      summary += `  Tool: ${result.tool}\n`;
      summary += `  Goal: ${result.reason}\n`;

      // Show tool-specific input
      if (result.code) {
        summary += `  Code: ${result.code.substring(0, 100)}${result.code.length > 100 ? "..." : ""}\n`;
      } else if (result.query) {
        summary += `  Query: ${result.query}\n`;
      } else if (result.url) {
        summary += `  URL: ${result.url}\n`;
      }

      if (result.success) {
        // Truncate long outputs for summary
        const outputStr = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
        const truncatedOutput = outputStr.length > 500 ? outputStr.substring(0, 500) + "..." : outputStr;
        summary += `  Result: ${truncatedOutput}\n`;
      } else {
        summary += `  Error: ${result.error}\n`;
      }
      summary += `\n`;
    }
    return summary.trim();
  }

  async executeTool(toolRequest) {
    this.logger.info(
      `Executing ${toolRequest.tool_name} tool:`,
      toolRequest.reason
    );

    if (toolRequest.tool_name === "python") {
      const result = await this.pythonTool.executePython(toolRequest.code);
      this.logger.debug("Python execution result:", result);
      return result;
    }

    if (toolRequest.tool_name === "web_search") {
      const result = await this.webSearchTool.searchWeb(toolRequest.query);
      this.logger.debug("Web search result:", result);
      return result;
    }

    if (toolRequest.tool_name === "web_fetch") {
      const result = await this.webFetchTool.fetchPage(toolRequest.url);
      this.logger.debug("Web fetch result:", result);
      return result;
    }

    return {
      success: false,
      output: "",
      error: `Unknown tool: ${toolRequest.tool_name}`,
    };
  }

  async sendErrorResponse(message, error) {
    try {
      this.logger.error(error);
      await message.reply(
        "(OOC: Sorry, I appear to be having connectivity issues, please try your message again.)"
      );
    } catch (error) {
      this.logger.error("Failed to send error response: ", error);
    }
  }

  /**
   * Get database instance for web dashboard
   * @returns {DatabaseManager} Database manager instance
   */
  getDatabase() {
    return this.db;
  }

  /**
   * Cleanup resources on shutdown
   */
  shutdown() {
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
    }
    // Clear all evaluation timers
    for (const timer of this.evaluationTimers.values()) {
      clearTimeout(timer);
    }
    this.evaluationTimers.clear();

    if (this.db) {
      this.db.close();
    }
    this.logger.info("ImpostorClient shutdown complete");
  }
}

module.exports = ImpostorClient;
