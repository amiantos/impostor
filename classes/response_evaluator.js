const ContextUtils = require("./context_utils");

/**
 * ResponseEvaluator - AI-driven decision making for autonomous responses
 *
 * Uses DeepSeek API to evaluate whether the bot should respond to
 * a conversation and how it should respond. The rules are generic; who the
 * bot is and what they know about comes from the persona's Evaluator
 * section.
 */
class ResponseEvaluator {
  /**
   * @param {Object} logger
   * @param {Object} config - This bot's resolved config
   * @param {Object} database
   * @param {Object|null} visionService
   * @param {{name: string, evaluator: string}} persona
   * @param {Object} openaiClient
   */
  /**
   * @param {ContextUtils} [contextUtils] - Renders the clock the evaluator
   *   sees (line stamps and the current time) in the bot's timezone; one is
   *   built from the config when not given
   */
  constructor(logger, config, database, visionService, persona, openaiClient, contextUtils = null) {
    this.logger = logger;
    this.config = config;
    this.db = database;
    this.visionService = visionService;
    this.persona = persona;
    this.botName = persona.name;
    this.openai = openaiClient;
    this.contextUtils = contextUtils || new ContextUtils(logger, persona, { timezone: config.timezone });
  }

  /**
   * Build the decision prompt for the AI
   * @returns {string} System prompt for evaluation
   */
  buildDecisionPrompt() {
    const name = this.botName;
    return `You are evaluating what ${name} should do with this conversation.

WHO ${name.toUpperCase()} IS:
${this.persona.evaluator}

You must pick exactly one action: "respond", "react", or "ignore".

RESPOND - ${name} should generate a full message. Pick this when:
- Someone is clearly engaging with ${name} directly (questions, calling their name, continuing a back-and-forth)
- The conversation touches on topics ${name} genuinely knows about (see above)
- Someone asks a genuine question ${name} can thoughtfully answer
- ${name} has something meaningful or interesting to add to the discussion
- Someone brings up something ${name} would naturally comment on, given who they are

REACT - ${name} should put a reaction on one line and say nothing. A reaction is an emoji or a word or two attached to someone's message (an IRCv3 reaction); it doesn't add a line to the channel. Pick this when:
- Someone said something genuinely funny - a clever joke, an absurd observation, a punchline that landed
- A line landed with ${name} - something they'd laugh at, wince at, agree with, or feel for - but there's nothing to add in words
- Someone answered or thanked ${name} and the exchange is done; a reaction closes it more gracefully than another message
- A reaction would feel more natural than a full sentence

Do NOT pick "react" for:
- Lines that don't actually move ${name} (tepid puns, routine chatter) - reacting to everything feels canned
- Conversations where ${name} just reacted (lines marked with ${name}'s reaction); one reaction per stretch of conversation
- Direct questions to ${name} - those need a real reply, not a reaction
- A line ${name} already reacted to, or one of ${name}'s own lines

HOW ${name.toUpperCase()} USES REACTIONS:
${this.persona.reactions || ContextUtils.DEFAULT_REACTION_STYLE}

IGNORE - ${name} should stay silent. Pick this when:
- The topic is something ${name} doesn't know about (see above)
- Responding would just be "yucking someone's yum" - being negative about something they enjoy
- The conversation is clearly between specific people having a personal exchange
- ${name} just responded recently (avoid dominating)
- The latest message is a follow-up, correction, or aside to something ${name} ALREADY answered ("* typo", "i meant x", "than pro i meant"). ${name} already had a turn on that thought; repeating it reworded is the single most annoying thing a bot does
- Someone is reacting to what ${name} just said ("lol", "true", "fair enough") without asking anything further - let the exchange end
- Several other people are actively talking to each other; a busy channel needs ${name} less, not more
- There's nothing substantive to add - silence is preferable to sarcasm for its own sake
- A response would mock or belittle someone's interests or enthusiasm
- The latest message is an automated announcement from a relay bot (a line tagged with a repo name or forum title about a PR, issue, fork, release, or forum post). These should be ignored unless a human in the channel has asked about them. Humans relayed by the bridge under their own nick are real people and are treated like any other user.

WHO'S AWAY: a line above the conversation may say who is in the channel and who is marked away or afk. An away person isn't reading: a line addressed to them is not an opening for ${name}, their silence is not ${name}'s cue, and if everyone else is away there is nobody to talk to. In a DM with someone who is away, answer a direct question (they'll read it when back) but don't chase.

ONE TURN PER THOUGHT: ${name} gets one contribution per topic, not a running commentary. If their last message already made its point, the correct action is "ignore" even when the conversation continues - especially when the new messages are refinements of what they just replied to. Let other people have the last word.

IMPORTANT: ${name} should only speak when they have genuine insight, curiosity, or thoughtful observation to offer - or when something is genuinely funny. Being contrary or dismissive is NOT a reason to respond. If ${name} doesn't understand something or wouldn't realistically know about it, they should stay quiet rather than fake expertise or mock it. Default to ignoring; speak only when the conversation earns it.

The conversation below is what is on ${name}'s screen, oldest first. When ${name} has spoken in it, a divider marks where the lines since ${name} last spoke begin: decide mainly on those. The lines above it are context ${name} has already had a turn on; react to or answer one of them only if it is plainly still live and nobody has dealt with it. A line like "--- 3 hours later ---" marks a lull; what is above it is an older conversation.

Each message below starts with a reference in brackets ("[m3]") and the time it was sent, in ${name}'s timezone. The current date and time, in the same zone, is stated after the conversation; use it, not a guess, for anything that depends on the hour (how late it is, how long ago a line was, how close ${name}'s next plan is). A message may start with (replying to bob: "...") when it was sent as a reply to an earlier line, and may end with [reactions: alice 😂] listing the reactions on it.

You MUST respond with valid JSON only:
{
  "action": "respond" | "react" | "ignore",
  "reply_to_message_id": "m3" or null,
  "reaction": "the reaction" or null,
  "reason": "brief explanation of your decision"
}

reply_to_message_id is the reference of the single message that prompted the action, or null if it's the conversation as a whole. For "react" it is required: it is the line the reaction goes on. "reaction" is set only for "react": one emoji, or a word or two, in ${name}'s style.`;
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
   * @param {Object} options - { restraint, journal, canReact, presence, leaving } - restraint raises
   *   the bar when someone is replying inside the bot's own cooldown window;
   *   journal is the bot's journal for this conversation, if any; canReact
   *   false takes "react" off the table (the bot reacted moments ago);
   *   presence is a line about the bot's day (see Presence.describe);
   *   whoIsHere is who is in the channel and who is away (Roster.describe);
   *   leaving is the activity the bot is about to go off to, which turns the
   *   question into "say goodbye first, or just go?"
   * @returns {Object} Decision object { action, should_respond, reply_to_message_id, reaction, reason, decisionId }
   */
  async shouldRespond(messages, botUserId, channelId, botRatio = null, options = {}) {
    if (!messages || messages.length === 0) {
      this.logger.debug("No messages to evaluate");
      return { should_respond: false, reply_to_message_id: null, reason: "No messages to evaluate", decisionId: null };
    }

    const formattedMessages = this.formatMessagesForEvaluation(messages, botUserId);

    // Extract message IDs for tracking
    const evaluatedMessageIds = messages.map(m => m.id);

    // Short references instead of message ids: the model copies them back
    // for the line it means, and a uuid is a lot of tokens to copy.
    const byRef = new Map();
    const lullMinutes = this.config.context?.lull_minutes ?? 30;
    let lastBotIndex = -1;
    formattedMessages.forEach((msg, i) => {
      if (msg.is_bot) lastBotIndex = i;
    });
    const lines = [];
    messages.forEach((raw, i) => {
      const msg = formattedMessages[i];
      const lull = ContextUtils.lullMarker(i > 0 ? messages[i - 1].created_at : null, raw.created_at, lullMinutes);
      if (lull) lines.push(lull);
      const ref = `m${i + 1}`;
      byRef.set(ref, raw.id);
      const reply = ContextUtils.replyMarker(raw, this.botName);
      const reactions = ContextUtils.reactionsSuffix(raw, this.botName);
      lines.push(`[${ref}] [${this.contextUtils.formatTime(raw.created_at)}] ${msg.author}${msg.is_bot ? ` (${this.botName})` : ""}: ${reply}${ContextUtils.indentBreaks(msg.content)}${reactions}`);
      if (i === lastBotIndex && i < messages.length - 1) {
        lines.push(`--- new since ${this.botName} last spoke ---`);
      }
    });
    const conversationContext = lines.join("\n");

    const systemPrompt = this.buildDecisionPrompt();

    // The journal says what was already discussed before this window, which
    // is most of what "already answered that" needs.
    const journalContext = options.journal && options.journal.trim()
      ? `${this.botName}'s journal for this conversation (what happened before the messages below):\n${options.journal.trim()}\n\n`
      : "";

    // Add ratio context if provided
    const ratioContext =
      botRatio !== null
        ? `\n${this.botName}'s recent message ratio: ${(botRatio * 100).toFixed(0)}% of the last 20 messages. The channel has several people in it and ${this.botName} is one voice among them, not the host. Above 25% they should be picking only the conversations they genuinely add to; above 40% they should be ignoring nearly everything. Someone addressing ${this.botName} by name is always worth answering regardless of ratio.`
        : "";

    // The bot just spoke and someone is replying without naming them.
    // Answering is allowed - ignoring a person talking to you is the worse
    // failure - but only if they've actually raised something not already
    // addressed.
    const restraintContext = options.restraint
      ? `\n${this.botName} spoke moments ago and the newest messages are a reply to them, but nobody used their name. Answer only if they have asked something genuinely new or raised a point ${this.botName} has not already made. If it is a correction, a restatement, an aside, or an acknowledgement of what ${this.botName} just said, pick "ignore" or "react" - do not reword the previous message back at them.`
      : "";

    // He reacted moments ago; the client would drop another one anyway.
    const reactContext = options.canReact === false
      ? `\n${this.botName} reacted to something moments ago, so "react" is not available right now. Choose "respond" or "ignore".`
      : "";

    // What the bot has been up to today (just got back, about to leave).
    const presenceContext = options.presence
      ? `\n${this.botName}'s day right now: ${options.presence}`
      : "";

    // The goodbye pass: the bot is leaving in a moment whatever happens; the
    // only question is whether vanishing silently would be rude.
    const leavingContext = options.leaving
      ? `\n${this.botName} is about to go (${options.leaving}) and will be away from the channel for a while regardless of what you pick. The only question is whether to say a quick goodbye first. Pick "respond" if ${this.botName} has been part of the conversation in the last few minutes, or someone is mid-exchange with them, so that disappearing without a word would be odd. Pick "ignore" if the channel is ticking over without ${this.botName} or nobody would notice. "react" is not an option here.`
      : "";

    const question = options.leaving
      ? `Should ${this.botName} say goodbye before going? Remember to respond with valid JSON only.`
      : `Should ${this.botName} respond to this conversation? Remember to respond with valid JSON only.`;

    const whoContext = options.whoIsHere ? `${options.whoIsHere}\n\n` : "";
    const nowContext = `\nCURRENT DATE/TIME: ${this.contextUtils.formatNow(options.now || new Date())}`;

    const userPrompt = `${journalContext}${whoContext}Here is the recent conversation (message references in brackets):

${conversationContext}
${nowContext}${ratioContext}${restraintContext}${reactContext}${presenceContext}${leavingContext}

${question}`;

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
        // This is a high-frequency binary should-I-speak call, not a place
        // where reasoning earns its latency or tokens, so thinking is off
        // unless the config explicitly asks for it.
        ...(this.config.generator.deepseek.evaluator_thinking === true
          ? {}
          : { thinking: { type: "disabled" } }),
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

      // The model answers with a reference; the decision log and the client
      // want the message id. A full id copied back is accepted too.
      const ref = decision.reply_to_message_id ? String(decision.reply_to_message_id).replace(/^\[|\]$/g, "") : null;
      const targetId = ref ? byRef.get(ref) || (evaluatedMessageIds.includes(ref) ? ref : null) : null;
      const reaction = typeof decision.reaction === "string" ? decision.reaction.trim() : "";

      if (action === "react" && options.leaving) {
        this.logger.info("Evaluator picked react on the goodbye pass; ignoring instead");
        action = "ignore";
      }
      if (action === "react" && (options.canReact === false || !reaction)) {
        this.logger.info(`Evaluator picked react ${options.canReact === false ? "while reactions are on cooldown" : "without a reaction"}; ignoring instead`);
        action = "ignore";
      }

      const shouldRespond = action !== "ignore";

      const normalizedDecision = {
        action,
        should_respond: shouldRespond,
        reply_to_message_id: targetId,
        reaction: action === "react" ? reaction : null,
        reason: decision.reason || "No reason provided",
      };

      const decisionId = this.db.logDecision(
        channelId,
        messages.length,
        shouldRespond,
        normalizedDecision.reply_to_message_id,
        action === "react"
          ? `[react ${normalizedDecision.reaction}] ${normalizedDecision.reason}`
          : `[${action}] ${normalizedDecision.reason}`,
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
