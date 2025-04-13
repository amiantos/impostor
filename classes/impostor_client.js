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
    const characterInfo = require(`../${[this.config.character.file]}`);
    const instructions = this.contextUtils.buildInstructions(
      characterInfo,
      userName,
      characterName,
      this.config.character.nsfw_allowed
    );
    this.logger.debug("Generated Instructions...", instructions);

    let inputMessages = this.contextUtils.buildChatMessagesForResponsesAPI(
      messages,
      botUserId,
      characterName
    );

    this.logger.debug("Generated Messages...", inputMessages);

    const response = await this.openai.responses.create({
      model: "gpt-4o",
      tools: [ { type: "web_search_preview" } ],
      instructions: instructions,
      input: inputMessages,
      store: false,
    });

    this.logger.info("Received response - ", response);

    return response.output_text;
  }

  async generateResponseWithChatCompletions({
    messages,
    userName,
    characterName,
    botUserId,
  }) {
    // Build context
    const characterInfo = require(`../${[this.config.character.file]}`);
    const conversationLog = this.contextUtils.buildConversationLog(
      characterInfo,
      botUserId,
      messages,
      userName,
      characterName,
      this.config.character.nsfw_allowed
    );
    this.logger.info("Created prompt, awaiting response.", conversationLog);

    // Generate response with OpenAI API
    const chatCompletion = await this.openai.chat.completions.create({
      model: this.config.generator.openai.model,
      messages: conversationLog,
      temperature: this.config.generator.openai.temperature,
      frequency_penalty: this.config.generator.openai.frequency_penalty,
      presence_penalty: this.config.generator.openai.presence_penalty,
      top_p: this.config.generator.openai.top_p,
      max_tokens: this.config.generator.openai.max_tokens,
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
