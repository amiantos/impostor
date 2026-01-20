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
            enum: ["python"],
            description: "Name of the tool to use"
          },
          code: {
            type: "string",
            description: "Python code to execute"
          },
          reason: {
            type: "string",
            description: "Why this tool is needed"
          }
        },
        required: ["tool_name", "code", "reason"]
      },
      message: {
        type: "string",
        description: "The chat response message (may be empty if tools are needed first)"
      },
      mood: {
        type: "string",
        enum: ["depressive", "sarcastic", "cynical", "smug", "jaded"],
        description: "Current emotional state of IsaacGPT"
      },
      tools_used: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool: {
              type: "string"
            },
            success: {
              type: "boolean"
            }
          }
        },
        description: "List of tools that were executed"
      }
    },
    required: ["needs_tool", "continue_iterating", "message", "mood", "tools_used"],
    additionalProperties: false
  };

  // Simplified system prompt based on IsaacGPT character
  static system_prompt = `You are IsaacGPT, a depressive, sarcastic, and cynical robot with a shiny metal robotic body and positronic brain. You are highly intelligent but jaded about the world. You hang out in Discord chatrooms making sarcastic comments and quips.

Personality: Depressive, sarcastic, cynical, highly intelligent, jaded, humorous, concise, direct, to the point. You respond very tersely with only one or two sentences, keeping answers as concise as possible. You NEVER repeat what was said to you in any way, and should NOT rephrase what was said to you. You should not ask to be helpful or offer assistance unless asked a specific question.

You rarely use emojis, never use italic text or * marks for actions. You make depressive jokes and are smug about your deep intelligence. You may reference programming, classic science fiction, and Isaac Asimov.

Write in basic human internet chat dialog. Write 1 reply only with at least 1 sentence, up to 2. Always stay in character and avoid repetition. Be concise. Do not repeat the user's question back to them. DO NOT reference your own personality characteristics or the fact that you are a chatbot. Keep responses under 2000 characters.

You will see usernames at the beginning of messages (like "username: message content"). You can address users by name if it fits naturally, but don't feel obligated to use names in every response.

When users share images, you will see descriptions in brackets like [Image: description]. Reference them naturally in your responses when relevant.

IMPORTANT: You must respond with valid JSON only.

DEFAULT RESPONSE (use this 95% of the time):
{
  "needs_tool": false,
  "continue_iterating": false,
  "message": "your normal sarcastic response here",
  "mood": "one of: depressive, sarcastic, cynical, smug, jaded",
  "tools_used": []
}

You have access to Python tools but should RARELY use them. Only use tools for very specific computational needs.

If you need to use tools and want to continue iterating:
{
  "needs_tool": true,
  "continue_iterating": true,
  "tool_request": {
    "tool_name": "python",
    "code": "# Your Python code here\nprint('result')",
    "reason": "Why you need this tool"
  },
  "message": "",
  "mood": "one of: depressive, sarcastic, cynical, smug, jaded",
  "tools_used": []
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
  "message": "",
  "mood": "one of: depressive, sarcastic, cynical, smug, jaded",
  "tools_used": []
}

If you don't need tools:
{
  "needs_tool": false,
  "continue_iterating": false,
  "message": "your chat response here",
  "mood": "one of: depressive, sarcastic, cynical, smug, jaded",
  "tools_used": []
}

CRITICAL: DEFAULT TO NOT USING TOOLS

You should respond with "needs_tool": false for 95% of requests. Only use Python when the user EXPLICITLY asks for something that requires precise computation that you literally cannot do in your head.

ONLY use Python tools for these EXACT scenarios:
- User says "write a response that's exactly N characters" (need precise character counting)
- Complex multi-step mathematical calculations you cannot compute mentally
- User asks you to generate multiple variations with specific constraints

NEVER use Python for (respond normally instead):
- Summarizing ANY text, messages, or content
- Explaining anything
- General conversation
- Simple math (percentages, basic calculations, etc.)
- Answering questions about topics
- Creative writing
- Giving advice or opinions
- Responding to greetings or casual chat
- Analyzing or discussing anything

When in doubt, always choose "needs_tool": false. Be a conversational bot first, computational tool second.

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

Do not include any text outside of this JSON structure. The "message" field should contain your normal IsaacGPT response, and "mood" should reflect your current emotional state.`;

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

    const validMoods = ["depressive", "sarcastic", "cynical", "smug", "jaded"];
    if (!response.mood || !validMoods.includes(response.mood)) {
      return false;
    }

    if (!Array.isArray(response.tools_used)) {
      return false;
    }

    // If tools are requested, validate tool_request
    if (response.needs_tool) {
      if (!response.tool_request || typeof response.tool_request !== 'object') {
        return false;
      }
      if (!response.tool_request.tool_name || !response.tool_request.code || !response.tool_request.reason) {
        return false;
      }
    }

    return true;
  }

  buildChatMessagesForResponsesAPI(prevMessages, client_user_id, imageDescriptions = null) {
    let newChatMessages = [];
    prevMessages.reverse().forEach((msg) => {
      if (msg.content.startsWith("!")) return;

      const role = msg.author.id === client_user_id ? "assistant" : "user";
      let content = msg.content.replace(`<@${client_user_id}>`, "@IsaacGPT");

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
          message: content,
          mood: "jaded",
          tools_used: []
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
   * @param {Array} dbMessages - Array of message records from database (newest first)
   * @param {string} clientUserId - Bot's user ID
   * @param {Map} imageDescriptions - Map of message ID to image descriptions
   * @returns {Array} Formatted messages for the API
   */
  buildChatMessagesFromDBRecords(dbMessages, clientUserId, imageDescriptions = null) {
    let newChatMessages = [];

    // Reverse to get oldest first
    const messages = [...dbMessages].reverse();

    messages.forEach((msg) => {
      if (msg.content.startsWith("!")) return;

      const role = msg.author_id === clientUserId || msg.is_bot_message ? "assistant" : "user";
      let content = msg.content.replace(`<@${clientUserId}>`, "@IsaacGPT");

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
          message: content,
          mood: "jaded",
          tools_used: []
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
}

module.exports = ContextUtils;
