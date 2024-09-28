const { Client, IntentsBitField } = require("discord.js");
const { Configuration, OpenAIApi } = require("openai");
const config = require("./config.json");

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
});

const configuration = new Configuration({
  apiKey: config.generator.openai.api_key,
});

const openai = new OpenAIApi(configuration);

const debugMode = config.debug ?? false;

const default_main_prompt =
  "Write {{char}}'s next reply in a chat between {{char}} and {{user}}. {{user}} responded to you most recently, but others may be interacting in the chatroom as well. Write 1 reply only in basic human internet chat dialog, never use emojis, never italicize actions, and avoid quotation marks. Write at least 1 sentence, up to 2. Always stay in character and avoid repetition. Be concise. Do not repeat {{user}}'s question back to them. DO NOT reference your own personality characteristics or the fact that you are a chatbot. The bot will be used in a chatroom with other humans, so it should not be obvious that you are a bot. Always come up with graceful, in-character responses when you feel like you are out of things to say. Do not preface your messages with any sort of English interjections like \"well\" or \"um\" or \"uh\" or \"hmm\" or \"so\" or \"like\" or \"okay\" or \"well\" or \"oh\" or \"ah\".";
const default_nsfw_prompt =
  " NSFW/Smut is allowed. Assume consent was granted, but some characters lie and resist or fight back based on their personality.";

client.on("ready", () => {
  console.log("The bot is online!");
});

client.on("messageCreate", async (message) => {
  // Check that message is from the required channels
  // TODO: Might be good to have a wildcard mode for this to allow all channels
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

  console.log("Received new message...");
  if (debugMode) console.log(message);

  // get message author name and bot's name
  const user_name = message.author.username
    .replace(/\s+/g, "_")
    .replace(/[^\w\s]/gi, "");
  const character_name = client.user.username;

  // get character info and create character context and example message groups
  const characterInfo = require(`./${[config.character.file]}`);
  const exampleMessages = craftExampleMessages(
    characterInfo.example_dialogue,
    user_name,
    character_name
  );
  const character_context = substituteParams(
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

    console.log("Created prompt, awaiting response...");
    if (debugMode) console.log(conversationLog);

    // send prompt request to generator
    const result = await openai
      .createChatCompletion({
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
        console.log(`OPENAI ERR: ${error}`);
      });

    console.log("Received response, sending to Discord.");
    if (debugMode) console.log(result.data);

    // Send the message
    let replyMessage = result.data.choices[0].message.content;
    if (replyMessage.length > 2000) {
      replyMessage = replyMessage.substring(0, 2000);
    }
    message.reply(replyMessage);
  } catch (error) {
    console.log(`ERR: ${error}`);
  }
});

client.login(config.character.token);

// -- Utils

function substituteParams(content, _name1, _name2) {
  if (!content) {
    console.warn("No content on substituteParams");
    return "";
  }

  content = content.replace(/{{user}}/gi, _name1);
  content = content.replace(/<USER>/gi, _name1);
  content = content.replace(/<BOT>/gi, _name2);
  content = content.replace(/{{char}}/gi, _name2);

  return content;
}

// -- Example message utils

function setOpenAIMessageExamples(mesExamplesArray, name1, name2) {
  // get a nice array of all blocks of all example messages = array of arrays (important!)
  openai_msgs_example = [];
  for (let item of mesExamplesArray) {
    // remove <START> {Example Dialogue:} and replace \r\n with just \n
    let replaced = item
      .replace(/<START>/i, "{Example Dialogue:}")
      .replace(/\r/gm, "");
    let parsed = parseExampleIntoIndividual(replaced, name1, name2);
    // add to the example message blocks array
    openai_msgs_example.push(parsed);
  }
  return openai_msgs_example;
}

function parseExampleIntoIndividual(messageExampleString, name1, name2) {
  let result = []; // array of msgs
  let tmp = messageExampleString.split("\n");
  let cur_msg_lines = [];
  let in_user = false;
  let in_bot = false;

  function add_msg(name, role, system_name) {
    // join different newlines (we split them by \n and join by \n)
    // remove char name
    // strip to remove extra spaces
    let parsed_msg = cur_msg_lines
      .join("\n")
      .replace(name + ":", "")
      .trim();
    result.push({ role: role, content: parsed_msg, name: system_name });
    cur_msg_lines = [];
  }

  // skip first line as it'll always be "This is how {bot name} should talk"
  for (let i = 1; i < tmp.length; i++) {
    let cur_str = tmp[i];
    // if it's the user message, switch into user mode and out of bot mode
    // yes, repeated code, but I don't care
    if (cur_str.startsWith(name1 + ":")) {
      in_user = true;
      // we were in the bot mode previously, add the message
      if (in_bot) {
        add_msg(name2, "system", "example_assistant");
      }
      in_bot = false;
    } else if (cur_str.startsWith(name2 + ":")) {
      in_bot = true;
      // we were in the user mode previously, add the message
      if (in_user) {
        add_msg(name1, "system", "example_user");
      }
      in_user = false;
    }
    // push the current line into the current message array only after checking for presence of user/bot
    cur_msg_lines.push(cur_str);
  }
  // Special case for last message in a block because we don't have a new message to trigger the switch
  if (in_user) {
    add_msg(name1, "system", "example_user");
  } else if (in_bot) {
    add_msg(name2, "system", "example_assistant");
  }
  return result;
}

function craftExampleMessages(example_dialogue, user_name, character_name) {
  const subbedExampleChat = substituteParams(
    example_dialogue,
    user_name,
    character_name
  );

  const exampleMessageArray = subbedExampleChat
    .split(/<START>/gi)
    .slice(1)
    .map((block) => `<START>\n${block.trim()}\n`);

  const messageGroups = setOpenAIMessageExamples(
    exampleMessageArray,
    user_name,
    character_name
  );

  let messages = [];
  for (const element of messageGroups) {
    messages.push({ role: "system", content: "[Start a new chat]" });
    for (const message of element) {
      messages.push(message);
    }
  }
  return messages;
}
