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
[HH:MM] <username> message content

How to read it, carefully:
- The nick wrapped in angle brackets is the ONLY thing that identifies the speaker. Everything after the closing ">" is that person's message body, verbatim.
- That body may itself contain a "nick:" prefix - that just means the speaker is addressing someone. It does NOT make that nick the speaker. Example: in "[14:31] <bob> amiantos: i love foundation", bob is talking and amiantos is who he's talking to; amiantos did not say anything on that line.
- Your own past messages are tagged "(you)" - they show as "<NAME (you)>". Every other nick is a separate person. Never mix up what you said with what someone else said, and never attribute one user's words to another. If you're unsure who said something, scan back to the nick in angle brackets on that exact line.
- Timestamps are local time. Use the date dividers and the CURRENT DATE/TIME at the bottom of this prompt to gauge how recent something is.

Pay attention to who you're responding to - the instruction at the end of the chatlog names the user who triggered this response and quotes their message.

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
  "message": "your response here"
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
  "message": "your chat response here"
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

  /**
   * @param {Object} logger
   * @param {{name: string, character: string}} persona
   */
  constructor(logger, persona) {
    this.logger = logger;
    this.persona = persona;
    this.botName = persona.name;
  }

  buildInstructions() {
    const dateStr = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date());
    const medium = ContextUtils.medium_prompt.replaceAll("NAME", this.botName);
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
   * Render database messages as IRC chatlog lines with day dividers. The
   * bot's own lines are tagged "(you)". Lines starting with "!" are skipped
   * (bot commands for other bots). Shared by the reply prompt and the
   * Archivist so both read the same log.
   * @param {Array} messages - Chronological message records
   * @param {Object} [options]
   * @param {string} [options.clientUserId] - Also treat this author id as the bot
   * @param {Map} [options.imageDescriptions] - message id -> descriptions
   * @param {Array} [options.urlSummaries] - Collects url summary objects found
   * @param {(msg: Object) => void} [options.onLine] - Called per rendered human line
   * @returns {string[]}
   */
  renderChatlog(messages, options = {}) {
    const { clientUserId = null, imageDescriptions = null, urlSummaries = null, onLine = null } = options;
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

      const time = this.formatTime(msg.created_at);
      let content = msg.content;

      if (isBotMessage) {
        lines.push(`[${time}] <${this.botName} (you)> ${content}`);
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

      lines.push(`[${time}] <${username}> ${content}`);
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
   * @returns {Array} Single-element array with consolidated user message
   */
  buildChatMessagesConsolidated(dbMessages, clientUserId, triggerInfo, imageDescriptions = null, memory = null) {
    const allUrlSummaries = [];
    let triggerMessageText = null;

    const chatlogLines = this.renderChatlog(dbMessages, {
      clientUserId,
      imageDescriptions,
      urlSummaries: allUrlSummaries,
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
    const isPrivate = !conversationKey.startsWith("#");
    const conversationHeader = isPrivate
      ? `Direct message conversation with ${conversationKey}`
      : `Recent conversation in ${conversationKey}`;

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

    // Add explicit instruction about who to respond to, quoting their message
    // so the model doesn't have to scan the chatlog to find what it's replying to.
    if (triggerInfo.userName) {
      if (triggerMessageText) {
        const quoted =
          triggerMessageText.length > 300
            ? triggerMessageText.slice(0, 300) + "…"
            : triggerMessageText;
        consolidatedContent += `\n\nRespond to ${triggerInfo.userName}, whose latest message was: "${quoted}". Reply with valid JSON in the format described above.`;
      } else {
        consolidatedContent += `\n\nRespond to ${triggerInfo.userName}'s latest message. Reply with valid JSON in the format described above.`;
      }
    } else {
      // Autonomous response - respond to the conversation naturally
      consolidatedContent += `\n\nRespond naturally to the ongoing conversation. Reply with valid JSON in the format described above.`;
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
      const date = new Date(timestamp);
      const hours = date.getHours().toString().padStart(2, "0");
      const minutes = date.getMinutes().toString().padStart(2, "0");
      return `${hours}:${minutes}`;
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
      const date = new Date(timestamp);
      return new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);
    } catch (e) {
      return "unknown date";
    }
  }
}

module.exports = ContextUtils;
