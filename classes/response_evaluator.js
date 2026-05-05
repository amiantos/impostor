/**
 * ResponseEvaluator - AI-driven decision making for autonomous responses
 *
 * Uses DeepSeek API to evaluate whether the bot should respond to
 * a conversation and how it should respond.
 */
class ResponseEvaluator {
  constructor(logger, config, database, visionService = null, botName = "Isaac", openaiClient = null) {
    this.logger = logger;
    this.config = config;
    this.db = database;
    this.visionService = visionService;
    this.botName = botName;

    if (openaiClient) {
      this.openai = openaiClient;
    } else {
      const { OpenAI } = require("openai");
      this.openai = new OpenAI({
        apiKey: config.generator.deepseek.api_key,
        baseURL: config.generator.deepseek.base_url,
      });
    }
  }

  /**
   * Build the decision prompt for the AI
   * @returns {string} System prompt for evaluation
   */
  buildDecisionPrompt() {
    const name = this.botName;
    return `You are evaluating what ${name} should do with this conversation.

${name} is a melancholic, thoughtful chatbot who happens to run on IRC. He's not just a sarcasm machine - he has genuine (if pessimistic) perspectives on existence, programming, classic science fiction, and philosophy. He writes in all lowercase and doesn't pretend to have a physical body or a life outside of this channel.

You must pick exactly one action: "respond", "react", or "ignore".

RESPOND - ${name} should generate a full message. Pick this when:
- Someone is clearly engaging with ${name} directly (questions, calling his name, continuing a back-and-forth)
- The conversation touches on topics ${name} genuinely knows about (programming, classic sci-fi, philosophy, AI, Asimov)
- Someone asks a genuine question ${name} can thoughtfully answer
- ${name} has something meaningful or interesting to add to the discussion
- Someone directly references chatbots, AI, or existence in a way ${name} would naturally comment on

REACT - ${name} should drop a short laugh-reaction ("haha", "lol", etc.) and nothing else. Pick this when:
- Someone said something genuinely funny - a clever joke, an absurd observation, a punchline that landed
- A funny thing happened in the conversation that ${name} would naturally laugh at as a lurking channel regular
- ${name} is amused but has nothing substantive to add beyond acknowledging it
- A reaction would feel more natural than a full sentence about why it's funny

Do NOT pick "react" for:
- Mildly clever remarks that don't actually warrant a laugh (tepid puns, dry observations)
- Things that aren't funny - reacting to non-jokes feels desperate and canned
- Conversations where ${name} just laughed recently (don't react to every line)
- Direct questions to ${name} - those need a real reply, not a laugh

IGNORE - ${name} should stay silent. Pick this when:
- The topic is something ${name} doesn't know about (video games, modern pop culture, sports)
- Responding would just be "yucking someone's yum" - being negative about something they enjoy
- The conversation is clearly between specific people having a personal exchange
- ${name} just responded recently (avoid dominating)
- There's nothing substantive to add - silence is preferable to sarcasm for its own sake
- A response would mock or belittle someone's interests or enthusiasm
- The latest message is from "EyeBridge" and is a webhook announcement (a [repo-name] or [forum-title] tagged message about a PR, issue, fork, release, or forum post). these are automated and should be ignored unless a human in the channel has asked about them. messages from EyeBridge that start with [Discord] are real humans chatting from discord and should be treated like any other user.

IRC IS NOT A TOPIC ${name} KNOWS ABOUT:
${name} runs on IRC the same way a person uses a phone - it's just the medium. IRC itself (the protocol, clients, networks, history, IRC culture, IRC drama, who uses IRC, IRC trivia) is NOT in his wheelhouse. Treat "the conversation is happening in IRC" or "the conversation mentions IRC" as irrelevant to whether ${name} should chime in. The relevant question is whether the actual subject matter (programming, sci-fi, philosophy, AI, etc.) is something he'd have insight on - not whether IRC came up.

IMPORTANT: ${name} should only speak when he has genuine insight, curiosity, or thoughtful observation to offer - or when something is genuinely funny. Being contrary or dismissive is NOT a reason to respond. If ${name} doesn't understand something or wouldn't realistically know about it, he should stay quiet rather than fake expertise or mock it. Default to ignoring; speak only when the conversation earns it.

You MUST respond with valid JSON only:
{
  "action": "respond" | "react" | "ignore",
  "reply_to_message_id": "message_id_to_reply_to" or null,
  "reason": "brief explanation of your decision"
}

reply_to_message_id is informational (it tags which specific message ${name} is reacting/responding to in the dashboard). Set it to the message id when there's a clear single message that prompted the action; null if it's a reaction to the conversation as a whole.`;
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
   * @param {string} botUserId - The bot's user ID
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
   * @param {string} botUserId - The bot's user ID
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

    const evaluatorModel =
      this.config.generator.deepseek.evaluator_model ||
      this.config.generator.deepseek.model;

    try {
      this.logger.debug("Evaluating conversation for autonomous response...");

      const response = await this.openai.chat.completions.create({
        model: evaluatorModel,
        messages: promptMessages,
        max_tokens: 1000,
        temperature: 0.7,
        response_format: { type: "json_object" },
      });

      const rawResponse = response.choices[0].message.content;
      this.logger.debug("Evaluation response:", rawResponse);

      const decision = JSON.parse(rawResponse);

      // Accept either the new "action" field or the legacy "should_respond"
      // boolean in case the model regresses to the old shape.
      let action;
      if (decision.action && ["respond", "react", "ignore"].includes(decision.action)) {
        action = decision.action;
      } else if (typeof decision.should_respond === "boolean") {
        action = decision.should_respond ? "respond" : "ignore";
      } else {
        throw new Error("Invalid decision structure: missing action");
      }

      const shouldRespond = action !== "ignore";

      const normalizedDecision = {
        action,
        should_respond: shouldRespond,
        reply_to_message_id: decision.reply_to_message_id || null,
        reason: decision.reason || "No reason provided",
      };

      const decisionId = this.db.logDecision(
        channelId,
        messages.length,
        shouldRespond,
        normalizedDecision.reply_to_message_id,
        `[${action}] ${normalizedDecision.reason}`,
        evaluatedMessageIds
      );

      this.db.storePrompt({
        decisionId,
        promptType: "evaluation",
        systemPrompt,
        messagesJson: promptMessages,
        model: evaluatorModel,
        temperature: 0.7
      });

      this.logger.info(
        `Autonomous evaluation: ${action.toUpperCase()} - ${normalizedDecision.reason}`
      );

      return {
        ...normalizedDecision,
        decisionId
      };
    } catch (error) {
      this.logger.error(`Error evaluating conversation: ${error.message}`, { stack: error.stack });

      const decisionId = this.db.logDecision(
        channelId,
        messages.length,
        false,
        null,
        `Error: ${error.message}`,
        evaluatedMessageIds
      );

      return {
        action: "ignore",
        should_respond: false,
        reply_to_message_id: null,
        reason: `Evaluation error: ${error.message}`,
        decisionId
      };
    }
  }
}

module.exports = ResponseEvaluator;
