const { Client, IntentsBitField } = require("discord.js");
const ContextUtils = require("./context_utils");
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
      apiKey: config.generator.openrouter.api_key,
      baseURL: config.generator.openrouter.base_url,
    });

    // Message queue system
    this.messageQueue = [];
    this.isProcessing = false;

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

    // Create conversation log with system message
    let conversationLog = [
      {
        role: "system",
        content: systemPrompt,
      },
      ...inputMessages
    ];

    this.logger.debug("Generated Messages...", conversationLog);

    const response = await this.openai.chat.completions.create({
      model: this.config.generator.openrouter.model,
      messages: conversationLog,
      max_tokens: this.config.generator.openrouter.max_tokens,
      temperature: this.config.generator.openrouter.temperature,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "isaacgpt_response",
          schema: this.contextUtils.constructor.response_schema
        }
      }
    });

    this.logger.info("Received response - ", response);

    const rawResponse = response.choices[0].message.content;

    try {
      const structuredResponse = JSON.parse(rawResponse);
      this.logger.debug("Parsed structured response:", structuredResponse);

      // Validate the structured response
      if (!this.contextUtils.validateStructuredResponse(structuredResponse)) {
        this.logger.warn("Invalid structured response format, using fallback");
        throw new Error("Invalid response structure");
      }

      let replyMessage = structuredResponse.message;

      // Log mood and any tools used for debugging/future features
      this.logger.debug(`IsaacGPT mood: ${structuredResponse.mood}`);
      if (structuredResponse.tools_used.length > 0) {
        this.logger.debug(`Tools used: ${structuredResponse.tools_used.join(', ')}`);
      }

      if (replyMessage.length > 2000) {
        this.logger.warn("Message too long, truncating.");
        replyMessage = replyMessage.substring(0, 2000);
      }

      return replyMessage;

    } catch (error) {
      this.logger.error("Failed to parse JSON response, using raw content:", error);
      this.logger.debug("Raw response was:", rawResponse);

      // Fallback to raw response if JSON parsing fails
      let replyMessage = rawResponse;
      if (replyMessage.length > 2000) {
        this.logger.warn("Message too long, truncating.");
        replyMessage = replyMessage.substring(0, 2000);
      }
      return replyMessage;
    }
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
