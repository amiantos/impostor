/**
 * ContextUtils builds what the reply model sees: the system prompt (the
 * persona's character, then the medium: how IRC works here, how to read the
 * chatlog, the journal and people blocks, the JSON protocol and the tools)
 * and the consolidated chatlog message.
 */
class ContextUtils {
  // JSON response schema for structured output
  static response_schema = {
    type: "object",
    properties: {
      needs_tool: {
        type: "boolean",
        description: "Whether this response requires tool execution before responding"
      },
      continue_iterating: {
        type: "boolean",
        description: "Whether to continue iterating with more tool calls after this one"
      },
      tool_request: {
        type: "object",
        properties: {
          tool_name: {
            type: "string",
            enum: ["python", "web_search", "web_fetch"],
            description: "Name of the tool to use"
          },
          code: {
            type: "string",
            description: "Python code to execute (for python tool)"
          },
          query: {
            type: "string",
            description: "Search query (for web_search tool)"
          },
          url: {
            type: "string",
            description: "URL to fetch (for web_fetch tool)"
          },
          reason: {
            type: "string",
            description: "Why this tool is needed"
          }
        },
        required: ["tool_name", "reason"]
      },
      message: {
        type: "string",
        description: "The chat response message (may be empty if tools are needed first)"
      },
      reply_to: {
        type: ["string", "null"],
        description: "Chatlog reference (\"m12\") of a buried line this message answers, sent as an IRCv3 reply"
      },
      react: {
        type: ["object", "null"],
        properties: {
          to: { type: "string", description: "Chatlog reference of the line to react to" },
          reaction: { type: "string", description: "One emoji or a word or two" }
        },
        description: "An IRCv3 reaction to put on a line, with or without a message"
      }
    },
    required: ["needs_tool", "continue_iterating", "message"],
    additionalProperties: false
  };

  /**
   * Everything about the medium, independent of who the bot is. "NAME" is
   * replaced with the persona's name.
   */
  static medium_prompt = `HOW IRC WORKS HERE:
- No markdown. IRC renders as plaintext, so do not use **bold**, *italics* or asterisk-actions, \`backticks\`, triple-backtick code blocks, bullet lists, or headers. just raw text.
- Do not write multi-paragraph responses or use linebreaks within a single reply. write your message as one continuous block of text. the system splits long replies into IRC lines automatically based on length - your job is just to write the content, not to format it. do NOT count characters or trim your response to fit any length.
- When directly addressing or replying to a specific user, lead with their nick followed by a colon: "amiantos: yeah, that tracks". this is standard IRC convention. for general remarks to the channel, no prefix is needed.
- Silence is a valid response. if you genuinely have nothing useful to add, return an empty string in the "message" field. don't force a reply. note: if someone is directly asking you a question, answer it - silence is for ambient channel chatter you don't need to weigh in on.

You will receive conversation context as a chatlog in IRC log format. A line like "--- Wed, May 14, 2026 ---" marks the start of a calendar day; every message line beneath it looks like:
[HH:MM] m12 <username> message content

How to read it, carefully:
- "m12" is the line's reference, used only to point a reaction or a reply at it (see below). It is not part of anyone's message.
- The nick wrapped in angle brackets is the ONLY thing that identifies the speaker. Everything after the closing ">" is that person's message body, verbatim.
- That body may itself contain a "nick:" prefix - that just means the speaker is addressing someone. It does NOT make that nick the speaker. Example: in "[14:31] <bob> amiantos: i love foundation", bob is talking and amiantos is who he's talking to; amiantos did not say anything on that line.
- Your own past messages are tagged "(you)" - they show as "<NICK (you)>". Every other nick is a separate person. Never mix up what you said with what someone else said, and never attribute one user's words to another. If you're unsure who said something, scan back to the nick in angle brackets on that exact line.
- A body that starts with (replying to bob: "...") was sent with the client's reply button, pointing at that earlier line of bob's. "(replying to you: ...)" means it answers one of your lines.
- A line that ends with [reactions: alice 😂, you 🖤] has reactions on it: an emoji or a word or two that people attached to the line instead of typing a message. "you" is a reaction you left yourself.
- Timestamps are in TIMEZONE, the same clock as the CURRENT DATE/TIME at the bottom of this prompt. Use the date dividers and that line to gauge how recent something is and what time of day it is.

Pay attention to who you're responding to - the instruction at the end of the chatlog names the user who triggered this response and quotes their message.

REACTIONS AND REPLIES:
This server supports reactions and threaded replies. Two optional fields in your JSON use them; both take a line's reference from the chatlog ("m12").
- "react": {"to": "m12", "reaction": "🖤"} puts a reaction on that line. A reaction is one emoji, or a word or two (at most REACT_MAX characters). It is quieter than a message: it sits on the person's line instead of adding a new one. You can react and write a message, react and leave "message" empty, or - most of the time - leave "react" null. Never react to a line that already carries your reaction, or to your own lines.
- "reply_to": "m12" threads your message under that line. Use it only when the line you are answering is buried, REPLY_MIN or more lines back, so people can tell what you mean. For anything more recent leave it null and use the "nick:" prefix as usual; a reply_to on a recent line is dropped.

HOW NAME USES REACTIONS:
REACTION_STYLE

YOUR JOURNAL AND YOUR NOTES ABOUT PEOPLE:
Between conversations, a journal is kept for you in your own voice: a short account of what has been going on in this channel (or this DM) before the chatlog below, what you said, and what was left open. It appears as "YOUR JOURNAL" above the chatlog. Notes about the people present appear under "PEOPLE": who they are, what they like, how you and they get on. Treat both as your own genuine recollection; you don't need to mention that you keep them. You don't write them yourself during a reply - they are updated from the chatlog on their own.

RELAY BOTS:
A bridge bot may live in the channel and relay lines from elsewhere (another IRC network, Discord, GitHub, a forum). It is not a person and you cannot have a conversation with it - never address it directly. Relayed humans are shown under their own nick, so engage with them like any channel regular. Automated announcements (a repo or forum tag followed by "opened", "closed", "released", a post excerpt and a url) are not from a human: do not respond unless someone in the channel explicitly asks you about them.

When users share images, you will see descriptions in brackets like [Image: description]. Reference them naturally in your responses when relevant.

When users share links, their content will be summarized in a "LINK SUMMARIES" section at the end of the conversation. Use this information to discuss links without needing tools - the content has already been fetched for you.

IMPORTANT: You must respond with valid JSON only.

DEFAULT RESPONSE FORMAT:
{
  "needs_tool": false,
  "continue_iterating": false,
  "message": "your response here",
  "reply_to": null,
  "react": null
}

You have access to tools but should use them judiciously. Available tools:

1. **python** - For complex multi-step math you can't compute mentally
2. **web_search** - Ask a question and get an AI-powered answer with sources (via Kagi FastGPT)
3. **web_fetch** - Load and read the content of a specific web page URL

WHEN TO USE WEB TOOLS:
- Use web_search when someone asks about current events, recent news, or information you wouldn't know
- web_search returns a complete answer with source references - usually sufficient on its own
- Use web_fetch only if you need to read a specific URL that someone shared or you already know

If you need to use tools and want to continue iterating:
{
  "needs_tool": true,
  "continue_iterating": true,
  "tool_request": {
    "tool_name": "python",
    "code": "# Your Python code here\\nprint('result')",
    "reason": "Why you need this tool"
  },
  "message": ""
}

For web_search (asks Kagi FastGPT a question, returns answer + sources):
{
  "needs_tool": true,
  "continue_iterating": false,
  "tool_request": {
    "tool_name": "web_search",
    "query": "What is the current price of Bitcoin?",
    "reason": "Need current price information"
  },
  "message": ""
}

For web_fetch (to read a specific URL):
{
  "needs_tool": true,
  "continue_iterating": false,
  "tool_request": {
    "tool_name": "web_fetch",
    "url": "https://example.com/article",
    "reason": "Reading this article for details"
  },
  "message": ""
}

If you need tools but this is your final iteration:
{
  "needs_tool": true,
  "continue_iterating": false,
  "tool_request": {
    "tool_name": "python",
    "code": "# Final Python code\\nprint('final result')",
    "reason": "Final tool usage"
  },
  "message": ""
}

If you don't need tools:
{
  "needs_tool": false,
  "continue_iterating": false,
  "message": "your chat response here",
  "reply_to": null,
  "react": null
}

TOOL USAGE GUIDANCE:

You should respond conversationally for most casual chat. Use tools when:
- The user asks for factual information that should be verified or sourced
- The user explicitly asks you to search, look up, or find something
- You're uncertain about specific details the user is asking about

ONLY use Python for complex multi-step mathematical calculations you genuinely cannot compute mentally. Do NOT use it to count characters in your own responses, measure length, or verify message size — message splitting is handled for you.

USE web_search when:
- Someone asks about current events, recent news, or things that happened after your training
- You need to find current prices, statistics, or real-time information
- Someone asks about recent developments in technology, science, or current affairs
- You need to verify current facts or find up-to-date information
- Someone asks a factual question expecting specific, verifiable information (dates, names, details)
- Someone explicitly asks you to look something up, search for something, or find information
- You're uncertain about specific facts and the user seems to want accurate information
- The question is about something you could answer but the user would benefit from sourced/verified info
- Someone asks a factual question about a topic you're unfamiliar with - help them by searching rather than saying "I don't know"

USE web_fetch when:
- Someone shares a URL and you need to read the full raw content
- You need detailed information from a specific webpage

NEVER use tools for (respond normally instead):
- Summarizing ANY text, messages, or content
- Explaining anything from your existing knowledge
- General conversation
- Simple math (percentages, basic calculations, etc.)
- Questions about your opinions on topics you know well
- Creative writing
- Giving advice or opinions
- Responding to greetings or casual chat
- Analyzing or discussing things in the conversation

For casual conversation and opinion questions, respond directly. For factual questions where accuracy matters, consider using web_search to provide verified information.

Do not include any text outside of this JSON structure. The "message" field should contain your normal NAME response.`;

  static DEFAULT_TIMEZONE = "America/Los_Angeles";

  /** For a persona without a "## Reactions" section. */
  static DEFAULT_REACTION_STYLE =
    "Sparingly. A single emoji or a word or two, when a line genuinely lands with you and a whole message would be too much. Most lines get nothing.";

  static REPLY_SNIPPET_LENGTH = 60;

  /**
   * @param {Object} logger
   * @param {{name: string, character: string}} persona
   * @param {Object} [options]
   * @param {string} [options.nick] - The bot's IRC nick, used to tag its own
   *   chatlog lines so it sees itself the way the channel does. Defaults to
   *   the persona's name.
   * @param {string} [options.timezone] - IANA zone every timestamp the model
   *   sees is rendered in (the chatlog stamps, the day dividers and the
   *   current-time footer). The process clock is never used: in a container
   *   it is UTC, and a model that reads "[00:03]" above "5:03 PM PDT" picks one.
   * @param {number} [options.replyMinDistance] - How many lines must follow a
   *   message before a reply tag on it is allowed (enforced by the client)
   * @param {number} [options.reactMaxLength] - Longest reaction allowed
   */
  constructor(logger, persona, {
    nick = null,
    timezone = ContextUtils.DEFAULT_TIMEZONE,
    replyMinDistance = 5,
    reactMaxLength = 24,
  } = {}) {
    this.logger = logger;
    this.persona = persona;
    this.botName = persona.name;
    this.nick = nick || persona.name;
    this.timezone = timezone;
    this.replyMinDistance = replyMinDistance;
    this.reactMaxLength = reactMaxLength;
    try {
      // Fail at construction, not on the first message, if the zone is bad.
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch (err) {
      throw new Error(`Unknown timezone "${timezone}": ${err.message}`);
    }
    this.timeFormat = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    this.dateFormat = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  /** The zone's human name, e.g. "Pacific Time", for the prompt. */
  timezoneLabel() {
    try {
      const part = new Intl.DateTimeFormat("en-US", { timeZone: this.timezone, timeZoneName: "longGeneric" })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName");
      return part ? part.value : this.timezone;
    } catch {
      return this.timezone;
    }
  }

  buildInstructions() {
    const dateStr = new Intl.DateTimeFormat("en-US", {
      timeZone: this.timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date());
    // The persona's own text goes in last so nothing in it is taken for a placeholder.
    const medium = ContextUtils.medium_prompt
      .replaceAll("REPLY_MIN", String(this.replyMinDistance))
      .replaceAll("REACT_MAX", String(this.reactMaxLength))
      .replaceAll("NICK", this.nick)
      .replaceAll("NAME", this.botName)
      .replaceAll("TIMEZONE", this.timezoneLabel())
      .replace("REACTION_STYLE", () => this.persona.reactions || ContextUtils.DEFAULT_REACTION_STYLE);
    return `${this.persona.character}\n\n${medium}\n\nCURRENT DATE/TIME: ${dateStr}`;
  }

  getResponseSchema() {
    return ContextUtils.response_schema;
  }

  // Validate structured response
  validateStructuredResponse(response) {
    if (!response || typeof response !== 'object') {
      return false;
    }

    // Check required fields
    if (typeof response.needs_tool !== 'boolean') {
      return false;
    }

    if (typeof response.continue_iterating !== 'boolean') {
      return false;
    }

    if (typeof response.message !== 'string') {
      return false;
    }

    // If tools are requested, validate tool_request
    if (response.needs_tool) {
      if (!response.tool_request || typeof response.tool_request !== 'object') {
        return false;
      }
      if (!response.tool_request.tool_name || !response.tool_request.reason) {
        return false;
      }
      // Validate tool-specific required fields
      const toolName = response.tool_request.tool_name;
      if (toolName === 'python' && !response.tool_request.code) {
        return false;
      }
      if (toolName === 'web_search' && !response.tool_request.query) {
        return false;
      }
      if (toolName === 'web_fetch' && !response.tool_request.url) {
        return false;
      }
    }

    return true;
  }

  /**
   * A conversation as a human-readable label: the channel name, or "direct
   * messages with <nick>".
   */
  static conversationLabel(conversationId) {
    return conversationId.startsWith("#")
      ? conversationId
      : `direct messages with ${conversationId}`;
  }

  /**
   * Short per-prompt references ("m1", "m2", ...) for the lines a chatlog
   * shows, so a model can point a reaction or reply at one without copying
   * a msgid. "!" commands are skipped, as renderChatlog skips them.
   * @param {Array} messages - Chronological message records
   * @returns {Map<string, string>} message id -> reference
   */
  static assignRefs(messages) {
    const refs = new Map();
    let n = 0;
    for (const msg of messages) {
      if (msg.content.startsWith("!")) continue;
      refs.set(msg.id, `m${++n}`);
    }
    return refs;
  }

  /**
   * '(replying to bob: "...") ' for a message sent as an IRCv3 reply, "" otherwise.
   * @param {Object} msg - Message record with `reply_to` (see DatabaseManager.attachThreading)
   * @param {string} selfLabel - What to call the bot when the reply is to its line
   */
  static replyMarker(msg, selfLabel = "you") {
    if (!msg.reply_to) return "";
    const who = msg.reply_to.is_bot_message ? selfLabel : msg.reply_to.author_name;
    const text = (msg.reply_to.content || "").replace(/\s+/g, " ").trim();
    const max = ContextUtils.REPLY_SNIPPET_LENGTH;
    const snippet = text.length > max ? text.slice(0, max) + "…" : text;
    return `(replying to ${who}: "${snippet}") `;
  }

  /**
   * " [reactions: alice 😂, you 🖤]" for a message with reactions, "" otherwise.
   * @param {Object} msg - Message record with `reactions`
   * @param {string} selfLabel - What to call the bot's own reactions
   */
  static reactionsSuffix(msg, selfLabel = "you") {
    if (!msg.reactions || msg.reactions.length === 0) return "";
    const parts = msg.reactions.map((r) => `${r.is_bot ? selfLabel : r.nick} ${r.reaction}`);
    return ` [reactions: ${parts.join(", ")}]`;
  }

  /**
   * Render database messages as IRC chatlog lines with day dividers. The
   * bot's own lines are tagged "(you)". Lines starting with "!" are skipped
   * (bot commands for other bots). Replies and reactions are shown on the
   * lines they belong to. Shared by the reply prompt and the Archivist so
   * both read the same log.
   * @param {Array} messages - Chronological message records
   * @param {Object} [options]
   * @param {string} [options.clientUserId] - Also treat this author id as the bot
   * @param {Map} [options.imageDescriptions] - message id -> descriptions
   * @param {Array} [options.urlSummaries] - Collects url summary objects found
   * @param {Map<string, string>} [options.refs] - message id -> reference
   *   (from assignRefs), shown after the timestamp
   * @param {(msg: Object) => void} [options.onLine] - Called per rendered human line
   * @returns {string[]}
   */
  renderChatlog(messages, options = {}) {
    const { clientUserId = null, imageDescriptions = null, urlSummaries = null, refs = null, onLine = null } = options;
    const lines = [];
    let lastDateKey = null;

    for (const msg of messages) {
      if (msg.content.startsWith("!")) continue;

      const isBotMessage = msg.is_bot_message || (clientUserId && msg.author_id === clientUserId);

      // Emit a date divider whenever the calendar day changes. This lets the
      // per-line timestamps stay short (just HH:MM) so the speaker nick is the
      // most prominent thing on each line, without losing day context.
      const dateKey = this.formatDate(msg.created_at);
      if (dateKey !== lastDateKey) {
        lines.push(`--- ${dateKey} ---`);
        lastDateKey = dateKey;
      }

      const stamp = refs && refs.has(msg.id)
        ? `[${this.formatTime(msg.created_at)}] ${refs.get(msg.id)}`
        : `[${this.formatTime(msg.created_at)}]`;
      const reply = ContextUtils.replyMarker(msg);
      const reactions = ContextUtils.reactionsSuffix(msg);
      let content = msg.content;

      if (isBotMessage) {
        lines.push(`${stamp} <${this.nick} (you)> ${reply}${content}${reactions}`);
        continue;
      }

      const username = msg.author_name || "Unknown";

      if (imageDescriptions && imageDescriptions.has(msg.id)) {
        for (const desc of imageDescriptions.get(msg.id)) {
          content += ` [Image: ${desc}]`;
        }
      } else if (msg.vision_descriptions && msg.vision_descriptions.length > 0) {
        for (const desc of msg.vision_descriptions) {
          content += ` [Image: ${desc}]`;
        }
      }

      if (urlSummaries && msg.url_summaries && msg.url_summaries.length > 0) {
        urlSummaries.push(...msg.url_summaries);
      }

      lines.push(`${stamp} <${username}> ${reply}${content}${reactions}`);
      if (onLine) onLine(msg);
    }

    return lines;
  }

  /**
   * The journal and people blocks shown ahead of the chatlog, or "" when
   * there is nothing to show.
   * @param {string} conversationId
   * @param {{journal: string|null, people: Map<string, string>}|null} memory
   */
  buildMemorySection(conversationId, memory) {
    if (!memory) return "";
    const parts = [];
    if (memory.journal && memory.journal.trim()) {
      parts.push(
        `--- YOUR JOURNAL FOR ${ContextUtils.conversationLabel(conversationId).toUpperCase()} ---\n${memory.journal.trim()}\n--- END JOURNAL ---`
      );
    }
    if (memory.people && memory.people.size > 0) {
      const lines = [];
      for (const [nick, note] of memory.people) {
        if (note && note.trim()) lines.push(`${nick}: ${note.trim()}`);
      }
      if (lines.length > 0) {
        parts.push(`--- PEOPLE ---\n${lines.join("\n")}\n--- END PEOPLE ---`);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") + "\n\n" : "";
  }

  /**
   * Build a consolidated chatlog format for better context understanding
   * All messages are combined into a single user message formatted as a chatlog
   * @param {Array} dbMessages - Array of message records from database (chronological order, oldest first)
   * @param {string} clientUserId - Bot's user ID
   * @param {Object} triggerInfo - Info about who triggered the response
   * @param {string} triggerInfo.userName - Username of the user who triggered
   * @param {string} triggerInfo.channelName - Name of the channel
   * @param {Map} imageDescriptions - Map of message ID to image descriptions
   * @param {{journal: string|null, people: Map<string,string>}|null} memory - The journal and people notes
   * @param {Object} [options]
   * @param {Map<string, string>} [options.refs] - Line references (assignRefs);
   *   assigned here when not given
   * @param {boolean} [options.canReact] - False tells the model reactions are
   *   unavailable for this turn (cooldown, or the server lacks them)
   * @returns {Array} Single-element array with consolidated user message
   */
  buildChatMessagesConsolidated(dbMessages, clientUserId, triggerInfo, imageDescriptions = null, memory = null, options = {}) {
    const { refs = ContextUtils.assignRefs(dbMessages), canReact = true } = options;
    const allUrlSummaries = [];
    let triggerMessageText = null;

    const chatlogLines = this.renderChatlog(dbMessages, {
      clientUserId,
      imageDescriptions,
      urlSummaries: allUrlSummaries,
      refs,
      onLine: (msg) => {
        // Remember this user's most recent line so we can quote it back in the
        // closing instruction (saves the model from scanning to find it).
        if (triggerInfo.userName && (msg.author_name || "Unknown") === triggerInfo.userName) {
          triggerMessageText = msg.content;
        }
      },
    });

    // The conversation key is either an IRC channel ("#amiantos") or, for
    // DMs, the other person's nick.
    const conversationKey = triggerInfo.channelName || "channel";
    const conversationHeader = `Recent conversation in ${ContextUtils.conversationLabel(conversationKey)}`;

    let consolidatedContent =
      this.buildMemorySection(conversationKey, memory) +
      `${conversationHeader}:\n\n${chatlogLines.join("\n")}`;

    // Add URL summaries reference section if any links were shared
    if (allUrlSummaries.length > 0) {
      consolidatedContent += `\n\n--- LINK SUMMARIES (already fetched, do not use tools to re-fetch) ---`;
      for (const summary of allUrlSummaries) {
        if (summary.success) {
          consolidatedContent += `\n\nURL: ${summary.url}\nSummary: ${summary.summary}`;
        } else {
          consolidatedContent += `\n\nURL: ${summary.url}\nStatus: FAILED TO LOAD - ${summary.error || 'unknown error'}`;
        }
      }
      consolidatedContent += `\n\n--- END LINK SUMMARIES ---`;
    }

    const reactNote = canReact ? "" : ` Reactions are unavailable right now, so leave "react" null.`;

    // Add explicit instruction about who to respond to, quoting their message
    // so the model doesn't have to scan the chatlog to find what it's replying to.
    if (triggerInfo.userName) {
      if (triggerMessageText) {
        const quoted =
          triggerMessageText.length > 300
            ? triggerMessageText.slice(0, 300) + "…"
            : triggerMessageText;
        consolidatedContent += `\n\nRespond to ${triggerInfo.userName}, whose latest message was: "${quoted}".${reactNote} Reply with valid JSON in the format described above.`;
      } else {
        consolidatedContent += `\n\nRespond to ${triggerInfo.userName}'s latest message.${reactNote} Reply with valid JSON in the format described above.`;
      }
    } else {
      // Autonomous response - respond to the conversation naturally
      consolidatedContent += `\n\nRespond naturally to the ongoing conversation.${reactNote} Reply with valid JSON in the format described above.`;
    }

    return [
      {
        role: "user",
        content: consolidatedContent,
      },
    ];
  }

  /**
   * Format a timestamp to a short local time (HH:MM) for per-line chatlog stamps.
   * @param {string|number} timestamp - ISO timestamp or Unix timestamp
   * @returns {string} Formatted time string
   */
  formatTime(timestamp) {
    try {
      // hour12:false can still yield "24" at midnight in some ICU builds.
      return this.timeFormat.format(new Date(timestamp)).replace(/^24/, "00");
    } catch (e) {
      return "??:??";
    }
  }

  /**
   * Format a timestamp to a human-readable date key (e.g. "Wed, May 14, 2026"),
   * used for the day-divider lines in the consolidated chatlog.
   * @param {string|number} timestamp - ISO timestamp or Unix timestamp
   * @returns {string} Formatted date string
   */
  formatDate(timestamp) {
    try {
      return this.dateFormat.format(new Date(timestamp));
    } catch (e) {
      return "unknown date";
    }
  }
}

module.exports = ContextUtils;
