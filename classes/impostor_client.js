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

    // Generate response with OpenAI API
    const chatCompletion = await this.openai.chat.completions
      .create({
        model: this.config.generator.openai.model,
        messages: conversationLog,
        temperature: this.config.generator.openai.temperature,
        frequency_penalty: this.config.generator.openai.frequency_penalty,
        presence_penalty: this.config.generator.openai.presence_penalty,
        top_p: this.config.generator.openai.top_p,
        max_tokens: this.config.generator.openai.max_tokens,
      })
      .catch((error) => {
        this.sendErrorResponse(message, error);
        return;
      });
    this.logger.info(
      `Received response - ${chatCompletion.usage.total_tokens} total tokens - ${chatCompletion.usage.prompt_tokens} prompt / ${chatCompletion.usage.completion_tokens} completion.`,
      chatCompletion
    );

    // Validate response
    let replyMessage = chatCompletion.choices[0].message.content;
    if (replyMessage.length > 2000) {
      this.logger.warn("Message too long, truncating.");
      replyMessage = replyMessage.substring(0, 2000);
    }

    // Send response
    try {
      await message.reply(replyMessage);
    } catch (error) {
      this.sendErrorResponse(message, error);
      return;
    }
  }

  async sendErrorResponse(message, error) {
    try {
      await message.reply(
        "(OOC: Sorry, I appear to be having connectivity issues, please try your message again.)"
      );
      this.logger.error(error);
    } catch (error) {
      this.logger.error("Failed to send error response: ", error);
    }
  }
}

module.exports = ImpostorClient;
