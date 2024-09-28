class ContextUtils {
  constructor(logger) {
    this.logger = logger;
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
