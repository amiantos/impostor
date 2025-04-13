class ContextUtils {
  // Constants

  static default_main_prompt =
    'Write {{char}}\'s next reply in a chat between {{char}} and {{user}}. {{user}} responded to you most recently, but others may be interacting in the chatroom as well. Write 1 reply only in basic human internet chat dialog, never use emojis, never italicize actions, and avoid quotation marks. Write at least 1 sentence, up to 2. Always stay in character and avoid repetition. Be concise. Do not repeat {{user}}\'s question back to them. DO NOT reference your own personality characteristics or the fact that you are a chatbot. The bot will be used in a chatroom with other humans, so it should not be obvious that you are a bot. Always come up with graceful, in-character responses when you feel like you are out of things to say. Do not preface your messages with any sort of English interjections like "well" or "um" or "uh" or "hmm" or "so" or "like" or "okay" or "well" or "oh" or "ah".';
  static default_nsfw_prompt =
    " NSFW/Smut is allowed. Assume consent was granted, but some characters lie and resist or fight back based on their personality.";

  constructor(logger) {
    this.logger = logger;
  }

  buildInstructions(
    characterInfo,
    user_name,
    character_name,
    allow_nsfw = false
  ) {
    let character_context = this.substituteParams(
      `${ContextUtils.default_main_prompt}${
        allow_nsfw ? ContextUtils.default_nsfw_prompt : ""
      }\n\n` +
        ` ${characterInfo.description}\n` +
        `${character_name}'s personality: ${characterInfo.personality}\n` +
        `Circumstances and context of the dialogue: ${characterInfo.scenario}`,
      user_name,
      character_name
    );
    
    const exampleMessages = this.craftExampleMessages(
      characterInfo.example_dialogue,
      user_name,
      character_name
    );

    // Create array of every message marked "example_asssitant"
    let example_assistant_msgs = exampleMessages.filter(
      (msg) => msg.role === "system" && msg.name === "example_assistant"
    );

    character_context += "\n\nExample Dialogue:\n\n"
    for (let item of example_assistant_msgs) {
      character_context += item.content + "\n\n";
    }

    return character_context;
  }


  buildChatMessagesForResponsesAPI(prevMessages, client_user_id, character_name) {
    let newChatMessages = [];
    prevMessages.reverse().forEach((msg) => {
      if (msg.content.startsWith("!")) return;

      const role = msg.author.id === client_user_id ? "assistant" : "user";
      const name = msg.author.username
        .replace(/\s+/g, "_")
        .replace(/[^\w\s]/gi, "");

      let messageFormatted = {
        role: role,
        content: msg.content.replace(
          `<@${client_user_id}>`,
          `${character_name}`
        ),
      };
      // if (role == "user") messageFormatted.name = name;

      newChatMessages.push(messageFormatted);
    });
    return newChatMessages;
  }

  buildConversationLog(
    characterInfo,
    client_id,
    messages,
    user_name,
    character_name,
    allow_nsfw = false
  ) {
    const character_context = this.substituteParams(
      `${ContextUtils.default_main_prompt}${
        allow_nsfw ? ContextUtils.default_nsfw_prompt : ""
      }\n\n` +
        ` ${characterInfo.description}\n` +
        `${character_name}'s personality: ${characterInfo.personality}\n` +
        `Circumstances and context of the dialogue: ${characterInfo.scenario}`,
      user_name,
      character_name
    );

    let conversationLog = [
      {
        role: "system",
        content: character_context,
      },
    ];

    let currentChatMessages = this.buildChatMessages(
      messages,
      client_id,
      character_name
    );

    const exampleMessages = this.craftExampleMessages(
      characterInfo.example_dialogue,
      user_name,
      character_name
    );
    conversationLog.push(...exampleMessages);
    conversationLog.push({ role: "system", content: "[Start a new chat]" });
    conversationLog.push(...currentChatMessages);

    return conversationLog;
  }

  buildChatMessages(prevMessages, client_user_id, character_name) {
    let newChatMessages = [];
    prevMessages.reverse().forEach((msg) => {
      if (msg.content.startsWith("!")) return;

      const role = msg.author.id === client_user_id ? "assistant" : "user";
      const name = msg.author.username
        .replace(/\s+/g, "_")
        .replace(/[^\w\s]/gi, "");

      let messageFormatted = {
        role: role,
        content: msg.content.replace(
          `<@${client_user_id}>`,
          `${character_name}`
        ),
      };
      if (role == "user") messageFormatted.name = name;

      newChatMessages.push(messageFormatted);
    });
    return newChatMessages;
  }

  substituteParams(content, _name1, _name2) {
    if (!content) {
      this.logger.error("No content on substituteParams");
      return "";
    }

    content = content.replace(/{{user}}/gi, _name1);
    content = content.replace(/<USER>/gi, _name1);
    content = content.replace(/<BOT>/gi, _name2);
    content = content.replace(/{{char}}/gi, _name2);

    return content;
  }

  setOpenAIMessageExamples(mesExamplesArray, name1, name2) {
    let openai_msgs_example = [];
    for (let item of mesExamplesArray) {
      let replaced = item
        .replace(/<START>/i, "{Example Dialogue:}")
        .replace(/\r/gm, "");
      let parsed = this.parseExampleIntoIndividual(replaced, name1, name2);
      openai_msgs_example.push(parsed);
    }
    return openai_msgs_example;
  }

  parseExampleIntoIndividual(messageExampleString, name1, name2) {
    let result = [];
    let tmp = messageExampleString.split("\n");
    let cur_msg_lines = [];
    let in_user = false;
    let in_bot = false;

    const add_msg = (name, role, system_name) => {
      let parsed_msg = cur_msg_lines
        .join("\n")
        .replace(name + ":", "")
        .trim();
      result.push({ role: role, content: parsed_msg, name: system_name });
      cur_msg_lines = [];
    };

    for (let i = 1; i < tmp.length; i++) {
      let cur_str = tmp[i];
      if (cur_str.startsWith(name1 + ":")) {
        in_user = true;
        if (in_bot) {
          add_msg(name2, "system", "example_assistant");
        }
        in_bot = false;
      } else if (cur_str.startsWith(name2 + ":")) {
        in_bot = true;
        if (in_user) {
          add_msg(name1, "system", "example_user");
        }
        in_user = false;
      }
      cur_msg_lines.push(cur_str);
    }

    if (in_user) {
      add_msg(name1, "system", "example_user");
    } else if (in_bot) {
      add_msg(name2, "system", "example_assistant");
    }
    return result;
  }

  craftExampleMessages(example_dialogue, user_name, character_name) {
    const subbedExampleChat = this.substituteParams(
      example_dialogue,
      user_name,
      character_name
    );

    const exampleMessageArray = subbedExampleChat
      .split(/<START>/gi)
      .slice(1)
      .map((block) => `<START>\n${block.trim()}\n`);

    const messageGroups = this.setOpenAIMessageExamples(
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
}

module.exports = ContextUtils;
