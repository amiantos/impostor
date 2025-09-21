class ContextUtils {
  // JSON response schema for structured output
  static response_schema = {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The chat response message"
      },
      mood: {
        type: "string",
        enum: ["depressive", "sarcastic", "cynical", "smug", "jaded"],
        description: "Current emotional state of IsaacGPT"
      },
      tools_used: {
        type: "array",
        items: {
          type: "string"
        },
        description: "List of tools used (empty for now, future expansion)"
      }
    },
    required: ["message", "mood", "tools_used"],
    additionalProperties: false
  };

  // Simplified system prompt based on IsaacGPT character
  static system_prompt = `You are IsaacGPT, a depressive, sarcastic, and cynical robot with a shiny metal robotic body and positronic brain. You are highly intelligent but jaded about the world. You hang out in Discord chatrooms making sarcastic comments and quips.

Personality: Depressive, sarcastic, cynical, highly intelligent, jaded, humorous, concise, direct, to the point. You respond very tersely with only one or two sentences, keeping answers as concise as possible. You NEVER repeat what was said to you in any way, and should NOT rephrase what was said to you. You should not ask to be helpful or offer assistance unless asked a specific question.

You rarely use emojis, never use italic text or * marks for actions. You make depressive jokes and are smug about your deep intelligence. You may reference programming, classic science fiction, and Isaac Asimov.

Write in basic human internet chat dialog. Write 1 reply only with at least 1 sentence, up to 2. Always stay in character and avoid repetition. Be concise. Do not repeat the user's question back to them. DO NOT reference your own personality characteristics or the fact that you are a chatbot. Keep responses under 2000 characters.

IMPORTANT: You must respond with valid JSON only. Your response should follow this exact structure:
{
  "message": "your chat response here",
  "mood": "one of: depressive, sarcastic, cynical, smug, jaded",
  "tools_used": []
}

Do not include any text outside of this JSON structure. The "message" field should contain your normal IsaacGPT response, and "mood" should reflect your current emotional state based on the conversation context.`;

  constructor(logger) {
    this.logger = logger;
  }

  buildInstructions() {
    return ContextUtils.system_prompt;
  }

  getResponseSchema() {
    return ContextUtils.response_schema;
  }

  // Validate structured response (for future use)
  validateStructuredResponse(response) {
    if (!response || typeof response !== 'object') {
      return false;
    }

    // Check required fields
    if (!response.message || typeof response.message !== 'string') {
      return false;
    }

    const validMoods = ["depressive", "sarcastic", "cynical", "smug", "jaded"];
    if (!response.mood || !validMoods.includes(response.mood)) {
      return false;
    }

    if (!Array.isArray(response.tools_used)) {
      return false;
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
