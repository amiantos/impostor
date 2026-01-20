const { Client, IntentsBitField } = require("discord.js");
const ContextUtils = require("./context_utils");
const PythonTool = require("./python_tool");
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

    // Initialize Python tool
    this.pythonTool = new PythonTool(logger);

    this.client.on("ready", () => {
      this.logger.info(`The bot is online as ${this.client.user.tag}!`);
    });

    this.client.on("messageCreate", async (message) => {
      this.handleMessageCreate(message);
    });
  }

  async login() {
    await this.client.login(this.config.bot.token);
  }

  async handleMessageCreate(message) {
    // Check that message is from the required channels
    if (this.config.channels.length > 0) {
      if (
        !this.config.channels.some((element) =>
          message.channel.id.includes(element)
        )
      )
        return;
    }

    // This ensures that the message either @mentions the bot, or is a reply to the bot
    if (
      !message.content.includes(this.client.user.id) &&
      !(
        message.mentions.repliedUser &&
        message.mentions.repliedUser.id == this.client.user.id
      )
    )
      return;

    this.logger.info(
      `Queuing message from @${message.author.username}.`,
      message
    );

    // Add message to queue
    this.messageQueue.push(message);

    // Start processing queue if not already processing
    if (!this.isProcessing) {
      this.processMessageQueue();
    }
  }

  async processMessageQueue() {
    if (this.isProcessing) return;

    this.isProcessing = true;

    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();

      try {
        this.logger.info(
          `Processing message from @${message.author.username}. Queue length: ${this.messageQueue.length}`,
          message
        );

        await this.processMessage(message);

        // Add a small delay between messages to appear more natural
        if (this.messageQueue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

      } catch (error) {
        this.logger.error("Error processing queued message:", error);
        await this.sendErrorResponse(message, error);
      }
    }

    this.isProcessing = false;
  }

  async processMessage(message) {
    const user_name = message.author.username
      .replace(/\s+/g, "_")
      .replace(/[^\w\s]/gi, "");
    const character_name = this.client.user.username;

    await message.channel.sendTyping();

    let messages;
    try {
      messages = await message.channel.messages.fetch({ limit: 40 });
    } catch (error) {
      throw error;
    }

    const response = await this.generateResponseWithChatCompletions({
      messages,
      userName: user_name,
      characterName: character_name,
      botUserId: this.client.user.id,
    });

    await message.reply(response);
  }

  async generateResponseWithChatCompletions({
    messages,
    userName,
    characterName,
    botUserId,
  }) {
    const systemPrompt = this.contextUtils.buildInstructions();
    this.logger.debug("Generated System Prompt...", systemPrompt);

    let inputMessages = this.contextUtils.buildChatMessagesForResponsesAPI(
      messages,
      botUserId
    );

    // Create initial conversation log
    let conversationLog = [
      {
        role: "system",
        content: systemPrompt,
      },
      ...inputMessages
    ];

    this.logger.debug("Generated Messages...", conversationLog);

    // First API call - check if tools are needed
    let response = await this.callDeepSeek(conversationLog);
    let structuredResponse = await this.parseStructuredResponse(response);

    let iterationCount = 0;
    const maxIterations = 10; // Prevent infinite loops
    let allToolResults = [];

    // Tool execution loop - can iterate multiple times
    while (structuredResponse.needs_tool && structuredResponse.tool_request && iterationCount < maxIterations) {
      iterationCount++;
      this.logger.info(`Tool execution iteration ${iterationCount}:`, structuredResponse.tool_request);

      // Execute the requested tool
      const toolResult = await this.executeTool(structuredResponse.tool_request);
      allToolResults.push({
        tool: structuredResponse.tool_request.tool_name,
        success: toolResult.success,
        iteration: iterationCount,
        code: structuredResponse.tool_request.code,
        output: toolResult.output,
        error: toolResult.error,
        reason: structuredResponse.tool_request.reason
      });

      // Add tool result to conversation
      conversationLog.push({
        role: "assistant",
        content: JSON.stringify(structuredResponse)
      });

      if (structuredResponse.continue_iterating) {
        // Build iteration summary for context
        const iterationSummary = this.buildIterationSummary(allToolResults, iterationCount);
        conversationLog.push({
          role: "user",
          content: `Tool execution result: ${JSON.stringify(toolResult)}

ITERATION HISTORY:
${iterationSummary}

REFLECTION: Look at your previous attempts above. What worked? What didn't? How can you adjust your approach based on the results? If you're close to the target (like 1-2 characters off), make small adjustments. Continue iterating to refine your approach, or provide your final response if satisfied.`
        });
      } else {
        conversationLog.push({
          role: "user",
          content: `Tool execution result: ${JSON.stringify(toolResult)}. Now provide your final response with the actual message.`
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
      this.logger.warn(`Reached maximum iterations (${maxIterations}), stopping tool execution`);
    }

    // Extract final message
    let replyMessage = structuredResponse.message || "Something went wrong with my processing.";

    this.logger.debug(`IsaacGPT mood: ${structuredResponse.mood}`);
    if (structuredResponse.tools_used.length > 0) {
      this.logger.debug(`Tools used:`, structuredResponse.tools_used);
    }

    if (replyMessage.length > 2000) {
      this.logger.warn("Message too long, truncating.");
      replyMessage = replyMessage.substring(0, 2000);
    }

    return replyMessage;
  }

  async callDeepSeek(conversationLog) {
    return await this.openai.chat.completions.create({
      model: this.config.generator.deepseek.model,
      messages: conversationLog,
      max_tokens: this.config.generator.deepseek.max_tokens,
      temperature: this.config.generator.deepseek.temperature,
      response_format: { type: "json_object" }
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
        tools_used: []
      };
    }
  }

  buildIterationSummary(allToolResults, currentIteration) {
    let summary = "";
    for (let i = 0; i < allToolResults.length; i++) {
      const result = allToolResults[i];
      summary += `Iteration ${result.iteration}:\n`;
      summary += `  Goal: ${result.reason}\n`;
      summary += `  Code: ${result.code.substring(0, 100)}${result.code.length > 100 ? '...' : ''}\n`;
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
    this.logger.info(`Executing ${toolRequest.tool_name} tool:`, toolRequest.reason);

    if (toolRequest.tool_name === "python") {
      const result = await this.pythonTool.executePython(toolRequest.code);
      this.logger.debug("Python execution result:", result);
      return result;
    }

    return {
      success: false,
      output: "",
      error: `Unknown tool: ${toolRequest.tool_name}`
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
}

module.exports = ImpostorClient;
