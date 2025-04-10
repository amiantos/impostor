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
      apiKey: config.generator.openai.api_key,
    });

    this.client.on("ready", () => {
      this.logger.info(`The bot is online as ${this.client.user.tag}!`);
    });

    this.client.on("messageCreate", async (message) => {
      this.handleMessageCreate(message);
    });
  }

  async login() {
    await this.client.login(this.config.character.token);
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
      `Received new message from @${message.author.username}.`,
      message
    );

    const user_name = message.author.username
      .replace(/\s+/g, "_")
      .replace(/[^\w\s]/gi, "");
    const character_name = this.client.user.username;

    await message.channel.sendTyping();

    let messages;
    try {
      messages = await message.channel.messages.fetch({ limit: 40 });
    } catch (error) {
      this.sendErrorResponse(message, error);
      return;
    }

    // Build context
    const characterInfo = require(`../${[this.config.character.file]}`);
    const conversationLog = this.contextUtils.buildConversationLog(
      characterInfo,
      this.client.user.id,
      messages,
      user_name,
      character_name,
      this.config.character.nsfw_allowed
    );
    this.logger.info("Created prompt, awaiting response.", conversationLog);

    // Convert conversation log to Responses API format
    const responsesMessages = this.convertToResponsesFormat(conversationLog);
    this.logger.info("Converted messages to Responses format", responsesMessages);

    // Generate response with OpenAI Responses API
    try {
      const response = await this.openai.beta.responses.create({
        model: this.config.generator.openai.model,
        messages: responsesMessages,
        temperature: this.config.generator.openai.temperature,
        frequency_penalty: this.config.generator.openai.frequency_penalty,
        presence_penalty: this.config.generator.openai.presence_penalty,
        top_p: this.config.generator.openai.top_p,
        max_tokens: this.config.generator.openai.max_tokens,
        tools: this.config.web_search?.enabled ? [
          {
            type: "web_search",
            web_search: {
              enable_snippets: true,
              key: this.config.web_search?.bing_search_key || undefined
            }
          },
        ] : undefined,
      });
      
      this.logger.info(
        `Received response from Responses API - ${response.usage?.total_tokens || 'unknown'} tokens.`,
        response
      );

      // Extract the assistant's response
      let replyMessage = response.choices[0].message.content;
      if (replyMessage.length > 2000) {
        this.logger.warn("Message too long, truncating.");
        replyMessage = replyMessage.substring(0, 2000);
      }

      // Send response
      await message.reply(replyMessage);
    } catch (error) {
      this.sendErrorResponse(message, error);
      return;
    }
  }

  convertToResponsesFormat(conversationLog) {
    // Map conversation log to Responses API format
    return conversationLog.map(msg => {
      // For system messages that are not conversation examples, keep as system messages
      if (msg.role === "system" && 
          (!msg.name || (msg.name !== "example_user" && msg.name !== "example_assistant"))) {
        return {
          role: "system",
          content: msg.content
        };
      }
      // For example messages or regular messages, keep their role
      else {
        return {
          role: msg.role === "system" ? 
                (msg.name === "example_user" ? "user" : "assistant") : 
                msg.role,
          content: msg.content,
          name: msg.name && msg.name !== "example_user" && msg.name !== "example_assistant" ? 
                msg.name : undefined
        };
      }
    });
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
