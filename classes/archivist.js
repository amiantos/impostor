/**
 * The Archivist keeps a bot's memory off the reply path.
 *
 * Per conversation (a channel or a DM partner) it keeps a journal: a short
 * first-person account, in the bot's voice, of what has been going on there,
 * what the bot said, and what was left open. Per nick it keeps a note: who
 * that person is and how they and the bot get on. Both are rewritten whole by
 * one model call that reads the stretch of chatlog since the last pass, the
 * way writers-guild's Continuity Archivist rewrites a Continuity.
 *
 * A pass runs when a conversation has `messages_per_pass` new lines, or when
 * it has gone quiet for `quiet_minutes` with at least `min_messages` new
 * lines. The watermark is the messages rowid last read, stored with the
 * journal, so a restart or a long backlog picks up where it left off; a
 * backlog is read in passes of `max_messages_per_pass`.
 */

const ContextUtils = require("./context_utils");
const DatabaseManager = require("./database");

const DEFAULTS = {
  enabled: true,
  messages_per_pass: 40,
  quiet_minutes: 20,
  min_messages: 5,
  max_messages_per_pass: 200,
  journal_max_chars: 1500,
  note_max_chars: 600,
  max_tokens: 3000,
  temperature: 0.5,
  model: null,
};

// A journal or note the model returns over this many times its budget is a
// runaway and is dropped rather than stored.
const OVERRUN_FACTOR = 3;
const MAX_RATIONALE_CHARS = 500;

function journalConfig(config) {
  return { ...DEFAULTS, ...(config?.journal || {}) };
}

/**
 * Whether a conversation with `newCount` unread lines should be read now,
 * read once it has been quiet for a while, or left alone.
 * @returns {"now"|"when-quiet"|"no"}
 */
function decidePass(newCount, cfg) {
  if (newCount >= cfg.messages_per_pass) return "now";
  if (newCount >= cfg.min_messages) return "when-quiet";
  return "no";
}

/**
 * The system and user prompts for one pass.
 * @param {Object} params
 * @param {{name: string, character: string}} params.persona
 * @param {string} params.conversationId
 * @param {string} params.journal - As it stands
 * @param {Map<string, string>} params.people - Notes for the nicks in the stretch
 * @param {string[]} params.nicks - Every human nick in the stretch
 * @param {string[]} params.lines - The chatlog lines
 * @param {{index: number, count: number}} [params.part]
 * @param {Object} params.cfg
 */
function buildArchivistPrompt({ persona, conversationId, journal, people, nicks, lines, part, cfg }) {
  const name = persona.name;
  const where = ContextUtils.conversationLabel(conversationId);
  const isDm = !conversationId.startsWith("#");

  const system = [
    `You are the memory of ${name}, an IRC chatbot. Between conversations you keep two things for ${name}:`,
    [
      `1. A JOURNAL for ${where}: a short account, in ${name}'s own voice and in the first person, of what has been going on there lately - what people talked about, what ${name} said or promised, what is unresolved. ${name} reads it ahead of the recent chatlog, so it picks up where things left off.`,
      `2. NOTES ABOUT PEOPLE: one short note per nick about who they are, what they do, what they like and dislike, and how they and ${name} get on. A note holds what would be true of that person in any conversation, not what happened in this one; that goes in the journal.`,
    ].join("\n"),
    `Here is who ${name} is, so the journal sounds like ${name}:\n\n${persona.character}`,
    `Read the newest stretch of the chatlog below and:`,
    [
      `- Rewrite the journal with what happened worked in. Add the lasting developments as the next part of the account, in a few sentences, not line by line. Change anything the chatlog made untrue, and adjust words like "earlier today" if time has clearly passed. Keep the rest as it is, in the same voice. Leave out passing chatter that will not matter next time${isDm ? "" : ", and anything that belongs in a person's note rather than the channel's story"}.`,
      `- Keep the journal under about ${cfg.journal_max_chars} characters. When it grows past that, condense the older part into a sentence or two and keep the newest part close to as it is.`,
      `- For each person who said or showed something lasting about themselves, rewrite their whole note with it worked in, under about ${cfg.note_max_chars} characters, in ${name}'s voice. Leave out people whose note does not change. Never note passwords, addresses, or other private details, and never note a judgment of someone's character.`,
      `- Voice means attitude, not vocabulary: paraphrase. Never quote ${name}'s own lines, and never carry ${name}'s catchphrases, pet names, sign-offs or running jokes into the journal or a note. ${name} rereads these before every reply and would end up repeating them; say what happened and what was meant, in plain words.`,
      `- Lines tagged "(you)" are ${name}'s own. Everyone else is a separate person; the nick in angle brackets is the only thing that identifies the speaker.`,
      `- Write plain text only: no markdown, no headings, no lists.`,
    ].join("\n"),
    `Answer with JSON only, no other text, in this shape:`,
    `{"journal": "the whole journal, rewritten", "people": {"nick": "the whole note, rewritten"}, "rationale": "what you added or changed, in one sentence"}`,
    `Set "journal" to null when nothing in the stretch is worth carrying forward, and leave "people" empty when no note changes.`,
  ].join("\n\n");

  const noteLines = nicks.map((nick) => `${nick}: ${people.get(nick) ? people.get(nick) : "(no note yet)"}`);
  // "Under about N characters" alone did not hold: journals and notes
  // settled at two to three times their budget, and every reply prompt
  // carried the excess. Over budget, the pass is told so, with the numbers.
  const overBudget = [];
  if (journal.trim().length > cfg.journal_max_chars) {
    overBudget.push(
      `The journal above is ${journal.trim().length} characters against a budget of ${cfg.journal_max_chars}. This pass, condense: fold the older part into a sentence or two of what still matters, keep the newest part, and come in under ${cfg.journal_max_chars}.`
    );
  }
  const longNotes = nicks.filter((nick) => (people.get(nick) || "").length > cfg.note_max_chars);
  if (longNotes.length > 0) {
    overBudget.push(
      `These notes are over their budget of ${cfg.note_max_chars} characters: ${longNotes.map((n) => `${n} (${people.get(n).length})`).join(", ")}. Rewrite each shorter this pass even if nothing new was learned: keep what would be true of the person in any conversation, drop what was one evening's bit.`
    );
  }
  const heading =
    part && part.count > 1
      ? `# The chatlog, part ${part.index + 1} of ${part.count}`
      : `# The chatlog`;
  const user = [
    `# The journal for ${where}`,
    journal.trim() || "(empty so far)",
    ...(part && part.index > 0
      ? ["The journal above already includes what the earlier parts of this stretch added."]
      : []),
    `# Notes about the people in this stretch`,
    noteLines.length > 0 ? noteLines.join("\n") : "(nobody but you spoke)",
    ...overBudget,
    heading,
    lines.join("\n"),
    `# Your answer`,
    `Rewrite the journal and any changed notes, as JSON.`,
  ].join("\n\n");

  return { system, user };
}

/**
 * The model's answer as {journal, people, rationale}, or null when it holds
 * no JSON of that shape. Think blocks and code fences are skipped. `journal`
 * is null when the model found nothing to carry forward; `people` is a Map
 * of nick -> note for notes that changed.
 */
function parseArchivistAnswer(answer) {
  const text = String(answer ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("journal" in parsed)) return null;
  if (parsed.journal !== null && typeof parsed.journal !== "string") return null;

  const people = new Map();
  if (parsed.people && typeof parsed.people === "object" && !Array.isArray(parsed.people)) {
    for (const [nick, note] of Object.entries(parsed.people)) {
      if (typeof note === "string" && note.trim() && nick.trim()) {
        people.set(nick.trim(), note.trim());
      }
    }
  }

  return {
    journal: parsed.journal?.trim() || null,
    people,
    rationale:
      typeof parsed.rationale === "string" ? parsed.rationale.trim().slice(0, MAX_RATIONALE_CHARS) : "",
  };
}

class Archivist {
  /**
   * @param {Object} logger
   * @param {Object} config - This bot's resolved config
   * @param {Object} db - This bot's DatabaseManager
   * @param {Object} openai - Chat completions client
   * @param {ContextUtils} contextUtils - Renders the chatlog; carries the persona
   */
  constructor(logger, config, db, openai, contextUtils) {
    this.logger = logger;
    this.cfg = journalConfig(config);
    this.generator = config.generator?.deepseek || {};
    this.db = db;
    this.openai = openai;
    this.contextUtils = contextUtils;
    this.persona = contextUtils.persona;

    this.quietTimers = new Map(); // conversationId -> timeout
    this.running = new Set();
    this.pending = new Set();
    // conversationId -> when a pass last failed; until quiet_minutes have
    // passed since, the message threshold does not trigger another one.
    this.failedAt = new Map();
    this.shuttingDown = false;
  }

  get enabled() {
    return this.cfg.enabled !== false;
  }

  /**
   * Called after every stored message. Runs a pass when the conversation has
   * enough unread lines, otherwise (re)arms the quiet timer.
   */
  noteActivity(conversationId) {
    if (!this.enabled || this.shuttingDown) return;
    const unread = this.unreadCount(conversationId);
    const decision = decidePass(unread, this.cfg);

    const timer = this.quietTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    this.quietTimers.delete(conversationId);

    // After a failed pass (the model down, a bad model name, non-JSON
    // answers) every new line would otherwise retry at full cost. Fall back
    // to the quiet timer until the backoff has elapsed.
    const quietMs = this.cfg.quiet_minutes * 60 * 1000;
    const failedAt = this.failedAt.get(conversationId);
    const backingOff = failedAt !== undefined && Date.now() - failedAt < quietMs;

    if (decision === "now" && !backingOff) {
      this.logger.debug(`Archivist: ${unread} unread lines in ${conversationId}, running a pass`);
      this.runPass(conversationId).catch((err) =>
        this.logger.error(`Archivist pass failed for ${conversationId}: ${err.message}`)
      );
      return;
    }

    // Arm the quiet timer even below min_messages: more lines may come, and a
    // timer that fires early just finds too few and does nothing.
    const id = setTimeout(() => {
      this.quietTimers.delete(conversationId);
      if (this.shuttingDown) return;
      const count = this.unreadCount(conversationId);
      if (decidePass(count, this.cfg) === "no") {
        this.logger.debug(`Archivist: ${conversationId} went quiet with ${count} unread lines, not enough for a pass`);
        return;
      }
      this.logger.debug(`Archivist: ${conversationId} went quiet with ${count} unread lines, running a pass`);
      this.runPass(conversationId).catch((err) =>
        this.logger.error(`Archivist pass failed for ${conversationId}: ${err.message}`)
      );
    }, quietMs);
    // The IRC connection is what keeps the process alive; a pending pass
    // never should (tests and shutdown would otherwise hang on it).
    id.unref?.();
    this.quietTimers.set(conversationId, id);
  }

  /**
   * After a restart, conversations that have unread lines but no pending
   * message to wake them get the same scheduling they would have had: a
   * pass now, or the quiet timer. Call once the database is open.
   */
  resume() {
    if (!this.enabled) return;
    for (const { channel_id } of this.db.getActiveChannels()) {
      if (this.unreadCount(channel_id) > 0) this.noteActivity(channel_id);
    }
  }

  unreadCount(conversationId) {
    const watermark = this.db.getJournal(conversationId)?.watermark_rowid ?? 0;
    return this.db.countMessagesAfterRowid(conversationId, watermark);
  }

  /**
   * What the reply model should see for a conversation: its journal and the
   * notes for the given nicks.
   * @param {string} conversationId
   * @param {string[]} nicks
   * @returns {{journal: string|null, people: Map<string, string>}}
   */
  memoryFor(conversationId, nicks) {
    return {
      journal: this.db.getJournalText(conversationId) || null,
      people: this.db.getPeople(nicks),
    };
  }

  /**
   * Read everything after the watermark, in batches, rewriting the journal
   * and notes after each. One pass per conversation at a time; a trigger
   * that lands mid-pass runs another pass afterwards.
   * @returns {Promise<{passes: number, changed: boolean}>}
   */
  async runPass(conversationId) {
    if (this.running.has(conversationId)) {
      this.pending.add(conversationId);
      return { passes: 0, changed: false };
    }
    this.running.add(conversationId);
    let passes = 0;
    let changed = false;
    try {
      while (!this.shuttingDown) {
        const watermark = this.db.getJournal(conversationId)?.watermark_rowid ?? 0;
        const batch = this.db.getMessagesAfterRowid(conversationId, watermark, this.cfg.max_messages_per_pass);
        if (batch.length === 0) break;
        const remaining = this.db.countMessagesAfterRowid(conversationId, watermark);
        // Parts done so far plus what the remaining lines need.
        const count = passes + Math.max(1, Math.ceil(remaining / this.cfg.max_messages_per_pass));
        const result = await this.readBatch(conversationId, batch, { index: passes, count });
        passes++;
        if (!result.ok) break;
        changed = changed || result.changed;
        if (batch.length < this.cfg.max_messages_per_pass) break;
      }
    } finally {
      this.running.delete(conversationId);
    }
    this.pending.delete(conversationId);
    // Whatever is still unread (lines that arrived during the pass, or the
    // stretch a failed pass left behind) gets the same treatment as any new
    // line: a pass now, or the quiet timer. Nothing is stranded until
    // someone happens to speak again.
    if (!this.shuttingDown && this.unreadCount(conversationId) > 0) {
      this.noteActivity(conversationId);
    }
    return { passes, changed };
  }

  /**
   * One model call over one batch. Moves the watermark only on a usable
   * answer, so a failed call rereads the same stretch next time.
   * @returns {Promise<{ok: boolean, changed: boolean}>}
   */
  async readBatch(conversationId, batch, part) {
    const journal = this.db.getJournalText(conversationId);
    // rowid is the watermark, but not quite arrival order: a message whose
    // link took seconds to summarize is inserted after lines that followed
    // it. Read the stretch in the order it happened.
    const inOrder = [...batch].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at) || a.rowid - b.rowid
    );
    // Only people with a rendered line can get a note from this stretch;
    // renderChatlog skips "!" commands, so take the nicks from what it kept.
    const seen = new Set();
    const lines = this.contextUtils.renderChatlog(inOrder, {
      onLine: (msg) => seen.add(msg.author_name || "Unknown"),
    });
    const nicks = [...seen];
    const people = this.db.getPeople(nicks);
    const { system, user } = buildArchivistPrompt({
      persona: this.persona,
      conversationId,
      journal,
      people,
      nicks,
      lines,
      part,
      cfg: this.cfg,
    });

    const answer = await this.ask(system, user, conversationId);
    if (!answer) {
      this.failedAt.set(conversationId, Date.now());
      this.logger.warn(`Archivist: no usable answer for ${conversationId} (part ${part.index + 1}/${part.count}); will reread after ${this.cfg.quiet_minutes} quiet minutes`);
      return { ok: false, changed: false };
    }
    this.failedAt.delete(conversationId);

    // The journal was edited or forgotten from the dashboard while the model
    // was reading. Its answer rewrote text that no longer stands, so drop it
    // and leave the watermark where the operator's action left it.
    if (this.db.getJournalText(conversationId) !== journal) {
      this.logger.info(`Archivist: journal for ${conversationId} changed during the pass; discarding this answer`);
      return { ok: false, changed: false };
    }

    const lastRowid = Math.max(...batch.map((m) => m.rowid));
    let changed = false;

    if (answer.journal && answer.journal !== journal.trim()) {
      if (answer.journal.length > this.cfg.journal_max_chars * OVERRUN_FACTOR) {
        this.logger.warn(`Archivist: journal for ${conversationId} came back ${answer.journal.length} chars, far over budget; keeping the old one`);
        this.db.setJournalWatermark(conversationId, lastRowid);
      } else {
        this.db.setJournal(conversationId, answer.journal, {
          source: "archivist",
          rationale: answer.rationale || null,
          watermarkRowid: lastRowid,
        });
        changed = true;
        this.logger.info(`Archivist: journal for ${conversationId} updated (${answer.journal.length} chars): ${answer.rationale || "no rationale"}`);
      }
    } else {
      this.db.setJournalWatermark(conversationId, lastRowid);
      this.logger.debug(`Archivist: nothing new for the ${conversationId} journal`);
    }

    // Only people who actually spoke in the stretch can get a note from it.
    const present = new Map(nicks.map((n) => [n.toLowerCase(), n]));
    for (const [nick, note] of answer.people) {
      const displayNick = present.get(nick.toLowerCase());
      if (!displayNick) {
        this.logger.debug(`Archivist: ignoring a note for ${nick}, who is not in this stretch`);
        continue;
      }
      if (note.length > this.cfg.note_max_chars * OVERRUN_FACTOR) {
        this.logger.warn(`Archivist: note for ${displayNick} came back ${note.length} chars, far over budget; dropped`);
        continue;
      }
      const shown = (people.get(displayNick) || "").trim();
      if (note === shown) continue;
      // Another conversation's pass, or a dashboard edit, rewrote this note
      // while the model was reading the old one. Keep the newer note rather
      // than overwrite it with one built on stale text.
      if ((this.db.getPerson(displayNick)?.content || "").trim() !== shown) {
        this.logger.info(`Archivist: note for ${displayNick} changed during the pass; keeping the newer one`);
        continue;
      }
      this.db.setPerson(displayNick, note, { source: "archivist", rationale: answer.rationale || null });
      changed = true;
      this.logger.info(`Archivist: note for ${displayNick} updated (${note.length} chars)`);
    }

    return { ok: true, changed };
  }

  /**
   * Ask the model, once more if the answer isn't the JSON asked for. The
   * prompt and what it cost go in the prompts table like any other call.
   */
  async ask(system, user, conversationId = null) {
    const messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const model = this.cfg.model || this.generator.model;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let response;
      const startedAt = Date.now();
      try {
        response = await this.openai.chat.completions.create({
          model,
          messages,
          max_tokens: this.cfg.max_tokens,
          temperature: this.cfg.temperature,
          response_format: { type: "json_object" },
          // Reading a chatlog is not where reasoning earns its tokens.
          thinking: { type: "disabled" },
        });
      } catch (err) {
        this.logger.error(`Archivist call failed (attempt ${attempt}): ${err.message}`);
        if (attempt === 2) return null;
        continue;
      }
      const content = response?.choices?.[0]?.message?.content;
      if (typeof this.db.storePrompt === "function") {
        this.db.storePrompt({
          conversationId,
          promptType: "archivist",
          systemPrompt: system,
          messagesJson: [messages[1], { role: "assistant", content: content || "" }],
          model,
          temperature: this.cfg.temperature,
          usage: DatabaseManager.usageOf(response, Date.now() - startedAt),
        });
      }
      const parsed = parseArchivistAnswer(content);
      if (parsed) return parsed;
      this.logger.warn(`Archivist answer wasn't the JSON asked for (attempt ${attempt}): ${String(content || "").slice(0, 200)}`);
    }
    return null;
  }

  shutdown() {
    this.shuttingDown = true;
    for (const id of this.quietTimers.values()) clearTimeout(id);
    this.quietTimers.clear();
  }
}

module.exports = { Archivist, DEFAULTS, journalConfig, decidePass, buildArchivistPrompt, parseArchivistAnswer };
