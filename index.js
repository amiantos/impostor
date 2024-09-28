const { Client, IntentsBitField } = require("discord.js");
const { OpenAI } = require('openai');
const config = require("./conf/config.json");
const Logger = require("./logger");
const ContextUtils = require("./context_utils");

// Classes

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
});
const openai = new OpenAI({
  apiKey: config.generator.openai.api_key,
});
const logger = new Logger(false);
const contextUtils = new ContextUtils(logger);

// Constants

const default_main_prompt =
  "Write {{char}}'s next reply in a chat between {{char}} and {{user}}. {{user}} responded to you most recently, but others may be interacting in the chatroom as well. Write 1 reply only in basic human internet chat dialog, never use emojis, never italicize actions, and avoid quotation marks. Write at least 1 sentence, up to 2. Always stay in character and avoid repetition. Be concise. Do not repeat {{user}}'s question back to them. DO NOT reference your own personality characteristics or the fact that you are a chatbot. The bot will be used in a chatroom with other humans, so it should not be obvious that you are a bot. Always come up with graceful, in-character responses when you feel like you are out of things to say. Do not preface your messages with any sort of English interjections like \"well\" or \"um\" or \"uh\" or \"hmm\" or \"so\" or \"like\" or \"okay\" or \"well\" or \"oh\" or \"ah\".";
const default_nsfw_prompt =
  " NSFW/Smut is allowed. Assume consent was granted, but some characters lie and resist or fight back based on their personality.";

// Setup Discord Client

client.on("ready", () => {
  logger.info("The bot is online!");
  logger.debug(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  // Check that message is from the required channels
  if (config.channels.length > 0) {
    if (
      !config.channels.some((element) => message.channel.id.includes(element))
    )
      return;
  }

  // This ensures that the message either @mentions the bot, or is a reply to the bot
  if (
    !message.content.includes(client.user.id) &&
    !(
      message.mentions.repliedUser &&
      message.mentions.repliedUser.id == client.user.id
    )
  )
    return;

  logger.info(`Received new message from @${message.author.username}.`, message);

  // get message author name and bot's name
  const user_name = message.author.username
    .replace(/\s+/g, "_")
    .replace(/[^\w\s]/gi, "");
  const character_name = client.user.username;

  // get character info and create character context and example message groups
  const characterInfo = require(`./${[config.character.file]}`);
  const exampleMessages = contextUtils.craftExampleMessages(
    characterInfo.example_dialogue,
    user_name,
    character_name
  );
  const character_context = contextUtils.substituteParams(
    `${default_main_prompt}${
      config.character.nsfw_allowed ? default_nsfw_prompt : ""
    }\n\n` +
      ` ${characterInfo.description}\n` +
      `${character_name}'s personality: ${characterInfo.personality}\n` +
      `Circumstances and context of the dialogue: ${characterInfo.scenario}`,
    user_name,
    character_name
  );

  try {
    await message.channel.sendTyping();

    // Build message log from channel messages
    let prevMessages = await message.channel.messages.fetch({ limit: 40 });
    prevMessages.reverse();

    let newChatMessages = [];
    prevMessages.forEach((msg) => {
      if (msg.content.startsWith("!")) return;

      const role = msg.author.id === client.user.id ? "assistant" : "user";
      const name = msg.author.username
        .replace(/\s+/g, "_")
        .replace(/[^\w\s]/gi, "");

      let messageFormatted = {
        role: role,
        content: msg.content.replace(
          `<@${client.user.id}>`,
          `${character_name}`
        ),
      };
      if (role == "user") messageFormatted.name = name;

      newChatMessages.push(messageFormatted);
    });

    // start building conversation log
    let conversationLog = [
      {
        role: "system",
        content: character_context,
      },
    ];

    // TODO: Fancy token counting stuff to omit example messages automatically
    conversationLog.push(...exampleMessages);

    conversationLog.push({ role: "system", content: "[Start a new chat]" });
    conversationLog.push(...newChatMessages);

    logger.info("Created prompt, awaiting response.", conversationLog);

    // send prompt request to generator
    const chatCompletion = await openai.chat.completions.create({
        model: config.generator.openai.model,
        messages: conversationLog,
        temperature: config.generator.openai.temperature,
        frequency_penalty: config.generator.openai.frequency_penalty,
        presence_penalty: config.generator.openai.presence_penalty,
        top_p: config.generator.openai.top_p,
        max_tokens: config.generator.openai.max_tokens,
      })
      .catch((error) => {
        message.reply(
          "(OOC: Sorry, I appear to be having connectivity issues, please try your message again.)"
        );
        logger.error(`OPENAI ERR: ${error}`);
      });

    logger.info(`Received response - ${chatCompletion.usage.total_tokens} total tokens - ${chatCompletion.usage.prompt_tokens} prompt / ${chatCompletion.usage.completion_tokens} completion.`, chatCompletion);

    // Send the message
    let replyMessage = chatCompletion.choices[0].message.content;
    if (replyMessage.length > 2000) {
      logger.warn("Message too long, truncating.");
      replyMessage = replyMessage.substring(0, 2000);
    }
    message.reply(replyMessage);
    logger.info("Message sent to Discord.");
  } catch (error) {
    logger.error(`ERR: ${error}`);
  }
});

// Login to Discord

client.login(config.character.token);
