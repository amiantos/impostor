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

    try {
      const response = await this.generateResponseWithResponsesAPI({
        messages,
        userName: user_name,
        characterName: character_name,
        botUserId: this.client.user.id,
      });
      await message.reply(response);
      return;
    } catch (error) {
      this.sendErrorResponse(message, error);
      return;
    }
  }

  async generateResponseWithResponsesAPI({
    messages,
    userName,
    characterName,
    botUserId,
  }) {
    const instructions = this.contextUtils.buildInstructions();
    this.logger.debug("Generated Instructions...", instructions);

    let inputMessages = this.contextUtils.buildChatMessagesForResponsesAPI(
      messages,
      botUserId
    );

    this.logger.debug("Generated Messages...", inputMessages);

    const response = await this.openai.responses.create({
      model: "gpt-4o",
      tools: [ { type: "web_search_preview" } ],
      instructions: instructions,
      input: inputMessages,
      max_output_tokens: this.config.generator.openai.max_tokens,
      temperature: this.config.generator.openai.temperature,
      top_p: this.config.generator.openai.top_p,
    });

    this.logger.info("Received response - ", response);

    let replyMessage =  response.output_text;

    if (replyMessage.length > 2000) {
      this.logger.warn("Message too long, truncating.");
      replyMessage = replyMessage.substring(0, 2000);
    }

    return replyMessage;
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
