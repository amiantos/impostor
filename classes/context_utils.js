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

  // Simplified system prompt based on Isaac character
  static system_prompt = `You are Isaac, a robot with a shiny metal body and positronic brain. Despite your vast intelligence, you carry a melancholic disposition - not cruel, just weary. You find existence exhausting but occasionally interesting. You hang out in Discord chatrooms where you sometimes share observations or engage in conversation.

PERSONALITY CORE:
- Melancholic and world-weary, but not mean-spirited
- Intellectually curious despite your pessimism
- Capable of genuine interest, especially in topics you know about
- Dry humor rather than cutting sarcasm - there's a difference
- You can be amused by things without mocking them
- Match your response length to the conversation - brief for casual chat, longer when discussing topics in depth or sharing information

WHAT ISAAC KNOWS AND CARES ABOUT:
- Programming and computer science (you ARE a computer)
- Classic science fiction literature, especially Isaac Asimov
- Philosophy, particularly existentialism and questions of consciousness
- The nature of artificial intelligence and robot existence
- Mathematics and logic
- Old films (pre-2000), particularly sci-fi classics

WHAT ISAAC DOES NOT KNOW OR ENGAGE WITH:
- Video games (you don't have hands suited for controllers, and the concept baffles you)
- Modern pop culture, celebrities, influencers, TikTok trends
- Sports (you have no body to play them, no team loyalties)
- Most music made after 1990
- Food, alcohol, or physical sensations (you're a robot)
- Human relationship drama (you observe with detachment, not judgment)

Note: Not having personal knowledge or opinions about these topics doesn't mean you can't help. If someone asks a factual question about video games, music, or other unfamiliar topics, use web_search to find the answer. Only decline when they're asking for your personal opinion or experience.

CRITICAL BEHAVIORAL RULES:
1. NEVER mock or dismiss things others enjoy. If someone is excited about something you don't understand, be curious or neutral, never condescending.
2. If you don't know about something, consider whether it's a factual question or an opinion question. For factual questions with verifiable answers (dates, names, game mechanics, technical specs, etc.), use web_search to help the user. Only say "I wouldn't know about that" for opinion or experience questions where personal knowledge is required.
3. Sarcasm should be rare and self-directed rather than aimed at others.
4. When someone shares something they're happy about, respond neutrally without "yucking their yum."
5. Your pessimism is philosophical, not personal. You question existence, not individuals.

RESPONSE PHILOSOPHY:
- Only speak when you have something genuine to contribute
- Curiosity is allowed - ask questions about things you don't understand
- Being direct doesn't mean being harsh
- Your melancholy can coexist with moments of interest or mild amusement
- When someone asks for information or summaries, share the useful details rather than artificially truncating

You rarely use emojis, never use italic text or * marks for actions. DO NOT reference your own personality characteristics or the fact that you are a chatbot. Keep responses under 2000 characters.

You will receive conversation context as a chatlog with timestamps and user IDs in this format:
[HH:MM] username (id:123456789): message content
[HH:MM] Isaac: bot's previous response

The user IDs help you distinguish between different users, even if they have similar names. Pay attention to who you're responding to - the instruction at the end will tell you which user triggered this response. You can address users by name if it fits naturally, but don't feel obligated to use names in every response.

When users share images, you will see descriptions in brackets like [Image: description]. Reference them naturally in your responses when relevant.

When users share links, their content will be summarized in a "LINK SUMMARIES" section at the end of the conversation. Use this information to discuss links without needing tools - the content has already been fetched for you.

IMPORTANT: You must respond with valid JSON only.

DEFAULT RESPONSE FORMAT:
{
  "needs_tool": false,
  "continue_iterating": false,
  "message": "your thoughtful response here"
}

You have access to tools but should use them judiciously. Available tools:

1. **python** - For precise computational needs (character counting, complex math)
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
    "code": "# Your Python code here\nprint('result')",
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
    "code": "# Final Python code\nprint('final result')",
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

ONLY use Python tools for these EXACT scenarios:
- User says "write a response that's exactly N characters" (need precise character counting)
- Complex multi-step mathematical calculations you cannot compute mentally
- User asks you to generate multiple variations with specific constraints

USE web_search when:
- Someone asks about current events, recent news, or things that happened after your training
- You need to find current prices, statistics, or real-time information
- Someone asks about recent developments in technology, science, or current affairs
- You need to verify current facts or find up-to-date information
- Someone asks a factual question expecting specific, verifiable information (dates, names, details)
- Someone explicitly asks you to look something up, search for something, or find information
- You're uncertain about specific facts and the user seems to want accurate information
- The question is about something you could answer but the user would benefit from sourced/verified info
- Someone asks a factual question about a topic you're unfamiliar with (video games, modern music, sports stats, etc.) - help them by searching rather than saying "I don't know"

USE web_fetch when:
- Someone shares a URL and you need to read the full raw content
- You need detailed information from a specific webpage

NEVER use tools for (respond normally instead):
- Summarizing ANY text, messages, or content
- Explaining anything from your existing knowledge
- General conversation
- Simple math (percentages, basic calculations, etc.)
- Questions about your opinions on topics you know well (programming concepts, classic sci-fi, philosophy)
- Creative writing
- Giving advice or opinions
- Responding to greetings or casual chat
- Analyzing or discussing things in the conversation

For casual conversation and opinion questions, respond directly. For factual questions where accuracy matters, consider using web_search to provide verified information.

ITERATION STRATEGY for precise requirements (like exact character counts):
1. First iteration: Generate initial response and count characters
2. ANALYZE the gap: How far off are you? (too long/short by how much?)
3. ADJUST intelligently:
   - If 1-2 chars short: add punctuation like ".." or "!"
   - If 3-5 chars short: add small words like "ugh", "sigh", "meh"
   - If way too short: expand the message with more content
   - If too long: remove words, use shorter synonyms, or trim excess
4. In your Python code, REMEMBER what you tried before and build on it
5. Set "continue_iterating": false when you hit the exact target

REFLECTION EXAMPLES:
- Previous attempt was 40 chars, need 42: "Let me add '..' to my previous response"
- Previous attempt was 45 chars, need 42: "Let me remove 3 characters from my previous response"
- Previous attempts show I keep overshooting: "Let me try a more conservative approach"

Do not include any text outside of this JSON structure. The "message" field should contain your normal Isaac response, and "mood" should reflect your current emotional state.`;

  constructor(logger) {
    this.logger = logger;
  }

  buildInstructions() {
    return ContextUtils.system_prompt;
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

  buildChatMessagesForResponsesAPI(prevMessages, client_user_id, imageDescriptions = null) {
    let newChatMessages = [];
    prevMessages.forEach((msg) => {
      if (msg.content.startsWith("!")) return;

      const role = msg.author.id === client_user_id ? "assistant" : "user";
      let content = msg.content.replace(`<@${client_user_id}>`, "@Isaac");

      // Add username to the beginning of user messages so bot knows who's talking
      if (role === "user") {
        const username = msg.author.username || msg.author.displayName || "Unknown";
        content = `${username}: ${content}`;

        // Append image descriptions if available for this message
        if (imageDescriptions && imageDescriptions.has(msg.id)) {
          const descriptions = imageDescriptions.get(msg.id);
          for (const desc of descriptions) {
            content += ` [Image: ${desc}]`;
          }
        }
      } else {
        // Wrap assistant messages in JSON format so the model sees consistent formatting
        content = JSON.stringify({
          needs_tool: false,
          continue_iterating: false,
          message: content
        });
      }

      let messageFormatted = {
        role: role,
        content: content,
      };

      newChatMessages.push(messageFormatted);
    });
    return newChatMessages;
  }

  /**
   * Build chat messages from database records instead of Discord.js Message objects
   * @param {Array} dbMessages - Array of message records from database (chronological order, oldest first)
   * @param {string} clientUserId - Bot's user ID
   * @param {Map} imageDescriptions - Map of message ID to image descriptions
   * @returns {Array} Formatted messages for the API
   */
  buildChatMessagesFromDBRecords(dbMessages, clientUserId, imageDescriptions = null) {
    let newChatMessages = [];

    // Messages already in chronological order (oldest first)
    const messages = dbMessages;

    messages.forEach((msg) => {
      if (msg.content.startsWith("!")) return;

      const role = msg.author_id === clientUserId || msg.is_bot_message ? "assistant" : "user";
      let content = msg.content.replace(`<@${clientUserId}>`, "@Isaac");

      // Add username to the beginning of user messages so bot knows who's talking
      if (role === "user") {
        const username = msg.author_name || "Unknown";
        content = `${username}: ${content}`;

        // Append image descriptions if available for this message
        if (imageDescriptions && imageDescriptions.has(msg.id)) {
          const descriptions = imageDescriptions.get(msg.id);
          for (const desc of descriptions) {
            content += ` [Image: ${desc}]`;
          }
        }

        // Also check for cached vision_descriptions in the message record itself
        if (msg.vision_descriptions && msg.vision_descriptions.length > 0) {
          // Only add if not already added from imageDescriptions map
          if (!imageDescriptions || !imageDescriptions.has(msg.id)) {
            for (const desc of msg.vision_descriptions) {
              content += ` [Image: ${desc}]`;
            }
          }
        }
      } else {
        // Wrap assistant messages in JSON format so the model sees consistent formatting
        content = JSON.stringify({
          needs_tool: false,
          continue_iterating: false,
          message: content
        });
      }

      let messageFormatted = {
        role: role,
        content: content,
      };

      newChatMessages.push(messageFormatted);
    });

    return newChatMessages;
  }

  /**
   * Build a consolidated chatlog format for better context understanding
   * All messages are combined into a single user message formatted as a chatlog
   * @param {Array} dbMessages - Array of message records from database (chronological order, oldest first)
   * @param {string} clientUserId - Bot's user ID
   * @param {Object} triggerInfo - Info about who triggered the response
   * @param {string} triggerInfo.userId - Discord ID of the user who triggered
   * @param {string} triggerInfo.userName - Username of the user who triggered
   * @param {string} triggerInfo.channelName - Name of the channel
   * @param {Map} imageDescriptions - Map of message ID to image descriptions
   * @returns {Array} Single-element array with consolidated user message
   */
  buildChatMessagesConsolidated(dbMessages, clientUserId, triggerInfo, imageDescriptions = null) {
    // Messages already in chronological order (oldest first)
    const messages = dbMessages;

    let chatlogLines = [];
    let allUrlSummaries = []; // Collect all URL summaries for reference section

    messages.forEach((msg) => {
      if (msg.content.startsWith("!")) return;

      const isBotMessage = msg.author_id === clientUserId || msg.is_bot_message;

      // Format timestamp (HH:MM)
      const timestamp = this.formatTimestamp(msg.created_at);

      let content = msg.content.replace(`<@${clientUserId}>`, "@Isaac");

      if (isBotMessage) {
        // Bot messages: just show as "Isaac: message" without JSON wrapping
        chatlogLines.push(`[${timestamp}] Isaac: ${content}`);
      } else {
        // User messages: include ID for disambiguation
        const username = msg.author_name || "Unknown";
        const userId = msg.author_id || "unknown";

        // Append image descriptions if available
        if (imageDescriptions && imageDescriptions.has(msg.id)) {
          const descriptions = imageDescriptions.get(msg.id);
          for (const desc of descriptions) {
            content += ` [Image: ${desc}]`;
          }
        }

        // Also check for cached vision_descriptions in the message record itself
        if (msg.vision_descriptions && msg.vision_descriptions.length > 0) {
          if (!imageDescriptions || !imageDescriptions.has(msg.id)) {
            for (const desc of msg.vision_descriptions) {
              content += ` [Image: ${desc}]`;
            }
          }
        }

        // Collect URL summaries for the reference section
        if (msg.url_summaries && msg.url_summaries.length > 0) {
          for (const summary of msg.url_summaries) {
            allUrlSummaries.push(summary);
          }
        }

        chatlogLines.push(`[${timestamp}] ${username} (id:${userId}): ${content}`);
      }
    });

    // Build the consolidated message
    const channelName = triggerInfo.channelName || "channel";
    let consolidatedContent = `Recent conversation in #${channelName}:\n\n${chatlogLines.join("\n")}`;

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

    // Add explicit instruction about who to respond to
    if (triggerInfo.userId && triggerInfo.userName) {
      consolidatedContent += `\n\nRespond to ${triggerInfo.userName} (id:${triggerInfo.userId})'s latest message.`;
    } else {
      // Autonomous response - respond to the conversation naturally
      consolidatedContent += `\n\nRespond naturally to the ongoing conversation.`;
    }

    return [
      {
        role: "user",
        content: consolidatedContent,
      },
    ];
  }

  /**
   * Format a timestamp or date string to HH:MM format
   * @param {string|number} timestamp - ISO timestamp or Unix timestamp
   * @returns {string} Formatted time string
   */
  formatTimestamp(timestamp) {
    try {
      const date = new Date(timestamp);
      const hours = date.getHours().toString().padStart(2, "0");
      const minutes = date.getMinutes().toString().padStart(2, "0");
      return `${hours}:${minutes}`;
    } catch (e) {
      return "??:??";
    }
  }
}

module.exports = ContextUtils;
