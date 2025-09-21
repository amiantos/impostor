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

IMPORTANT: You must respond with valid JSON only. You have access to a Python interpreter tool that you can use for calculations, text processing, or any computational tasks. You can iterate and refine your approach multiple times.

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

ITERATION STRATEGY for precise requirements (like exact character counts):
1. First iteration: Generate initial response and count characters
2. If not exact, adjust the response (add/remove words, rephrase)
3. Continue iterating until you get exactly the right count
4. Set "continue_iterating": false when satisfied

Examples: If user wants exactly 42 characters, keep iterating Python code to craft and measure responses until you hit exactly 42.

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

  buildChatMessagesForResponsesAPI(prevMessages, client_user_id) {
    let newChatMessages = [];
    prevMessages.reverse().forEach((msg) => {
      if (msg.content.startsWith("!")) return;

      const role = msg.author.id === client_user_id ? "assistant" : "user";

      let messageFormatted = {
        role: role,
        content: msg.content.replace(`<@${client_user_id}>`, "IsaacGPT"),
      };

      newChatMessages.push(messageFormatted);
    });
    return newChatMessages;
  }
}

module.exports = ContextUtils;
