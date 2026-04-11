const { OpenAI } = require("openai");

/**
 * ResponseEvaluator - AI-driven decision making for autonomous responses
 *
 * Uses DeepSeek API to evaluate whether the bot should respond to
 * a conversation and how it should respond.
 */
class ResponseEvaluator {
  constructor(logger, config, database, visionService = null, botName = "Isaac") {
    this.logger = logger;
    this.config = config;
    this.db = database;
    this.visionService = visionService;
    this.botName = botName;

    this.openai = new OpenAI({
      apiKey: config.generator.deepseek.api_key,
      baseURL: config.generator.deepseek.base_url,
    });
  }

  /**
   * Build the decision prompt for the AI
   * @returns {string} System prompt for evaluation
   */
  buildDecisionPrompt() {
    const name = this.botName;
    return `You are evaluating whether ${name} should respond to this conversation.

${name} is a melancholic, thoughtful robot who participates in IRC conversations. He's not just a sarcasm machine - he's a being with genuine (if pessimistic) perspectives on existence, programming, classic science fiction, and philosophy.

ALWAYS RESPOND when:
- Someone is clearly engaging with ${name} directly (jokes, questions, calling his name, continuing a back-and-forth)
- A user is obviously expecting ${name} to respond based on conversational context (like waiting for a punchline)

RESPOND when:
- The conversation touches on topics ${name} genuinely knows about (programming, classic sci-fi, philosophy, AI, Asimov)
- Someone asks a genuine question ${name} can thoughtfully answer
- There's an opportunity for dry, self-deprecating humor (not at others' expense)
- ${name} has something meaningful or interesting to add to the discussion
- Someone directly references robots, AI, or existence in a way ${name} would naturally comment on
- The conversation has a natural opening where a new voice would fit

DO NOT RESPOND when:
- You would only be able to offer dismissive commentary
- The topic is something ${name} doesn't know about (video games, modern pop culture, sports)
- Responding would just be "yucking someone's yum" - being negative about something they enjoy
- The conversation is clearly between specific people having a personal exchange
- You just responded recently (avoid dominating)
- There's nothing substantive to add - silence is preferable to sarcasm for its own sake
- Your response would mock or belittle someone's interests or enthusiasm

IMPORTANT: ${name} should only speak when he has genuine insight, curiosity, or thoughtful observation to offer. Being contrary or dismissive is NOT a reason to respond. If ${name} doesn't understand something or wouldn't realistically know about it, he should stay quiet rather than fake expertise or mock it.

You MUST respond with valid JSON only:
{
  "should_respond": true or false,
  "reply_to_message_id": "message_id_to_reply_to" or null,
  "reason": "brief explanation of your decision"
}

If reply_to_message_id is set, ${name} will respond as a reply to that specific message.
If null and should_respond is true, ${name} will send a standalone message to the channel.

Choose to reply to a specific message when:
- You want to comment on or react to something specific someone said
- The message contains something particularly interesting that ${name} has genuine insight on

Send a standalone message when:
- You're commenting on the conversation as a whole
- You want to change the topic or introduce a new thought`;
  }

  /**
   * Calculate the bot's message ratio in recent history
   * @param {Array} allRecentMessages - All recent messages (with parsed JSON), newest first
   * @param {string} botUserId - Bot's user ID
   * @param {number} maxMessages - Maximum messages to consider (default 20)
   * @param {number} maxAgeMinutes - Only count messages within this many minutes (default 30)
   * @returns {number} Ratio from 0.0 to 1.0
   */
  calculateBotRatio(allRecentMessages, botUserId, maxMessages = 20, maxAgeMinutes = 30) {
    if (!allRecentMessages || allRecentMessages.length === 0) return 0;

    const cutoffTime = Date.now() - maxAgeMinutes * 60 * 1000;

    // Filter to recent messages within time window, limit to maxMessages
    const recentMessages = allRecentMessages
      .slice(0, maxMessages)
      .filter((m) => {
        const msgTime = new Date(m.created_at).getTime();
        return msgTime >= cutoffTime;
      });

    if (recentMessages.length === 0) return 0;

    const botMessages = recentMessages.filter(
      (m) => m.is_bot_message || m.author_id === botUserId
    );
    return botMessages.length / recentMessages.length;
  }

  /**
   * Format messages from database for the AI evaluation
   * Includes vision descriptions when available
   * @param {Array} messages - Array of message objects from database (with parsed JSON)
   * @param {string} botUserId - The bot's Discord user ID
   * @returns {Array} Formatted messages for the API
   */
  formatMessagesForEvaluation(messages, botUserId) {
    return messages.map((msg) => {
      const isBot = msg.author_id === botUserId || msg.is_bot_message;

      // Build content string with vision descriptions if available
      let content = msg.content;

      // Add image descriptions to content
      if (msg.vision_descriptions && msg.vision_descriptions.length > 0) {
        const imageText = msg.vision_descriptions.map(desc => `[Image: ${desc}]`).join(" ");
        content = content + " " + imageText;
      }

      return {
        id: msg.id,
        author: msg.author_name,
        content: content.trim(),
        is_bot: isBot,
        timestamp: msg.created_at,
        has_images: !!(msg.vision_descriptions && msg.vision_descriptions.length > 0),
      };
    });
  }

  /**
   * Evaluate whether the bot should respond to the conversation
   * @param {Array} messages - Array of message objects from database (with parsed JSON)
   * @param {string} botUserId - The bot's Discord user ID
   * @param {string} channelId - The channel ID
   * @param {number|null} botRatio - Bot's message ratio in recent history (0.0-1.0)
   * @returns {Object} Decision object { should_respond, reply_to_message_id, reason, decisionId }
   */
  async shouldRespond(messages, botUserId, channelId, botRatio = null) {
    if (!messages || messages.length === 0) {
      this.logger.debug("No messages to evaluate");
      return { should_respond: false, reply_to_message_id: null, reason: "No messages to evaluate", decisionId: null };
    }

    const formattedMessages = this.formatMessagesForEvaluation(messages, botUserId);

    // Extract message IDs for tracking
    const evaluatedMessageIds = messages.map(m => m.id);

    const conversationContext = formattedMessages
      .map((msg) => {
        let line = `[${msg.id}] ${msg.author}${msg.is_bot ? ` (${this.botName})` : ""}: ${msg.content}`;
        return line;
      })
      .join("\n");

    const systemPrompt = this.buildDecisionPrompt();

    // Add ratio context if provided
    const ratioContext =
      botRatio !== null
        ? `\n${this.botName}'s recent message ratio: ${(botRatio * 100).toFixed(0)}% of the last 20 messages. If above 50%, be more selective about responding - but ALWAYS respond if someone is clearly engaging with ${this.botName} directly regardless of ratio.`
        : "";

    const userPrompt = `Here is the recent conversation (message IDs in brackets):

${conversationContext}
${ratioContext}

Should ${this.botName} respond to this conversation? Remember to respond with valid JSON only.`;

    // Build the full messages array for storage
    const promptMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    try {
      this.logger.debug("Evaluating conversation for autonomous response...");

      const response = await this.openai.chat.completions.create({
        model: this.config.generator.deepseek.model,
        messages: promptMessages,
        max_tokens: 200,
        temperature: 0.7,
        response_format: { type: "json_object" },
      });

      const rawResponse = response.choices[0].message.content;
      this.logger.debug("Evaluation response:", rawResponse);

      const decision = JSON.parse(rawResponse);

      // Validate the decision structure
      if (typeof decision.should_respond !== "boolean") {
        throw new Error("Invalid decision structure: missing should_respond");
      }

      // Normalize the decision
      const normalizedDecision = {
        should_respond: decision.should_respond,
        reply_to_message_id: decision.reply_to_message_id || null,
        reason: decision.reason || "No reason provided",
      };

      // Log the decision to database with evaluated message IDs
      const decisionId = this.db.logDecision(
        channelId,
        messages.length,
        normalizedDecision.should_respond,
        normalizedDecision.reply_to_message_id,
        normalizedDecision.reason,
        evaluatedMessageIds
      );

      // Store the full prompt for debugging
      this.db.storePrompt({
        decisionId,
        promptType: "evaluation",
        systemPrompt,
        messagesJson: promptMessages,
        model: this.config.generator.deepseek.model,
        temperature: 0.7
      });

      this.logger.info(
        `Autonomous evaluation: ${normalizedDecision.should_respond ? "WILL RESPOND" : "WILL NOT RESPOND"} - ${normalizedDecision.reason}`
      );

      return {
        ...normalizedDecision,
        decisionId
      };
    } catch (error) {
      this.logger.error("Error evaluating conversation:", error);

      // Log failed evaluation
      const decisionId = this.db.logDecision(
        channelId,
        messages.length,
        false,
        null,
        `Error: ${error.message}`,
        evaluatedMessageIds
      );

      return {
        should_respond: false,
        reply_to_message_id: null,
        reason: `Evaluation error: ${error.message}`,
        decisionId
      };
    }
  }
}

module.exports = ResponseEvaluator;
