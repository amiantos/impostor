const { Client, IntentsBitField } = require("discord.js");
const ContextUtils = require("./context_utils");
const PythonTool = require("./python_tool");
const DatabaseManager = require("./database");
const MessageTracker = require("./message_tracker");
const ResponseEvaluator = require("./response_evaluator");
const VisionService = require("./vision_service");
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

    // Initialize Python tool
    this.pythonTool = new PythonTool(logger);

    // Initialize database
    this.db = new DatabaseManager(logger);
    this.db.initialize();

    // Initialize vision service with database for caching
    this.visionService = new VisionService(logger, config, this.db);

    // Initialize message tracker with vision service
    this.messageTracker = new MessageTracker(logger, this.db, config, this.visionService);
    this.evaluator = new ResponseEvaluator(logger, config, this.db, this.visionService);

    // Initialize backfill service
    this.backfillService = new BackfillService(logger, this.db, this.visionService, config);

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
      this.scheduleAutonomousEvaluation(message.channel);
    }
  }

  /**
   * Schedule an autonomous evaluation with debouncing
   * Waits for conversation to settle before evaluating
   * @param {Channel} channel - Discord channel
   */
  scheduleAutonomousEvaluation(channel) {
    const channelId = channel.id;
    const debounceMs = (this.config.autonomous?.debounce_seconds || 30) * 1000;

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

    // Calculate bot dominance ratio
    const botRatio = this.evaluator.calculateBotRatio(
      recentMessages,
      this.client.user.id
    );

    // Hard cap at 40%: skip if dominating too much
    if (botRatio > 0.4) {
      this.logger.debug(
        `Skipping evaluation - bot ratio ${(botRatio * 100).toFixed(0)}% exceeds 40%`
      );
      return;
    }

    // Soft cap at 15%: probabilistic skip
    if (botRatio > 0.15) {
      const skipChance = (botRatio - 0.15) * 2; // 25% ratio = 20% skip chance
      if (Math.random() < skipChance) {
        this.logger.debug(
          `Randomly skipping evaluation - bot ratio ${(botRatio * 100).toFixed(0)}%`
        );
        return;
      }
    }

    const messagesSinceResponse =
      this.getMessagesSinceLastBotResponseFromParsed(recentMessages);

    if (messagesSinceResponse.length === 0) {
      this.logger.debug("No messages to evaluate for autonomous response");
      return;
    }

    // Ask AI if we should respond (pass ratio for context)
    const decision = await this.evaluator.shouldRespond(
      messagesSinceResponse,
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
   * Get messages since last bot response from parsed DB messages
   * @param {Array} messages - Parsed messages from database (newest first)
   * @returns {Array} Messages since last bot response (oldest first)
   */
  getMessagesSinceLastBotResponseFromParsed(messages) {
    // Messages come in newest-first order, find the last bot message
    let lastBotIndex = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].is_bot_message) {
        lastBotIndex = i;
        break;
      }
    }

    if (lastBotIndex === -1) {
      // No bot messages, return all messages (reversed to oldest first)
      return [...messages].reverse();
    }

    // Return messages before the last bot message (reversed to oldest first)
    return messages.slice(0, lastBotIndex).reverse();
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
   * @param {string} channelId - Discord channel ID
   * @param {number} limit - Maximum messages to fetch
   * @returns {Object} Context object with messages and imageDescriptions
   */
  buildContextFromDatabase(channelId, limit = 40) {
    // Get recent messages from database (parsed JSON)
    const dbMessages = this.db.getRecentMessages(channelId, limit, true);

    // Build image descriptions map from cached vision data
    const imageDescriptions = this.visionService.buildImageDescriptionsFromDB(dbMessages);

    return {
      dbMessages,
      imageDescriptions
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
    const { dbMessages, imageDescriptions } = this.buildContextFromDatabase(message.channel.id, 40);

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
    const { dbMessages, imageDescriptions } = this.buildContextFromDatabase(channel.id, 40);

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

    // Update tools_used array with all iterations
    structuredResponse.tools_used = allToolResults;

    if (iterationCount >= maxIterations) {
      this.logger.warn(
        `Reached maximum iterations (${maxIterations}), stopping tool execution`
      );
    }

    // Extract final message
    let replyMessage =
      structuredResponse.message || "Something went wrong with my processing.";

    this.logger.debug(`IsaacGPT mood: ${structuredResponse.mood}`);
    if (structuredResponse.tools_used.length > 0) {
      this.logger.debug(`Tools used:`, structuredResponse.tools_used);
    }

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
        mood: "jaded",
        tools_used: [],
      };
    }
  }

  buildIterationSummary(allToolResults, currentIteration) {
    let summary = "";
    for (let i = 0; i < allToolResults.length; i++) {
      const result = allToolResults[i];
      summary += `Iteration ${result.iteration}:\n`;
      summary += `  Goal: ${result.reason}\n`;
      summary += `  Code: ${result.code.substring(0, 100)}${result.code.length > 100 ? "..." : ""}\n`;
      if (result.success) {
        summary += `  Result: ${result.output}\n`;
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
