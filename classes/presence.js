const { presenceAt, formatStamp, formatClock } = require("./schedule");

/**
 * Where the bot is right now, kept up to date from its persona's schedule
 * and its own activity:
 *
 * - An "away" block in the schedule makes the bot gone: it sets its IRC
 *   away status to the block's message, stops reading the channel (nothing
 *   is evaluated or answered; messages are still stored and the Archivist
 *   still runs) and, when the block ends, clears the status and catches up
 *   on the conversations that moved while it was out. Before going it may
 *   say goodbye (the client's onLeave hook), and if it was mid-conversation
 *   when the block started it lingers a little first.
 * - Between blocks, lurker-style afk: `afk_minutes` after its own last line
 *   the away status becomes "afk since <stamp>", cleared the moment it
 *   speaks. Afk changes nothing else; a pinged bot answers from afk.
 * - A "here" block changes nothing mechanically; it only shows up in the
 *   narrative the prompts get (describe()).
 *
 * The clock is injected so the whole thing can be driven by tests.
 */
class Presence {
  /**
   * @param {Object} options
   * @param {Object} options.logger
   * @param {{blocks: Array}|null} options.schedule - Parsed persona schedule
   * @param {string} options.timezone - IANA zone the schedule is written in
   * @param {string} options.seed - Stable per-bot string for the jitter
   * @param {Object} [options.config] - The `presence` config section
   * @param {() => Date} [options.clock]
   * @param {Object} options.hooks
   * @param {(message: string|null) => void} options.hooks.setAway - Send AWAY (null clears)
   * @param {(occurrence: Object) => Promise<void>} [options.hooks.onLeave] - Runs before the bot goes
   * @param {(occurrence: Object) => void} [options.hooks.onReturn] - Runs after it's back
   */
  constructor({ logger, schedule = null, timezone, seed, config = {}, clock = () => new Date(), hooks }) {
    this.logger = logger;
    this.schedule = schedule;
    this.timezone = timezone;
    this.seed = seed;
    this.clock = clock;
    this.hooks = hooks;
    this.enabled = config.enabled !== false;
    this.afkMinutes = config.afk_minutes ?? 15;
    this.afkMessage = config.afk_message || "afk since {time}";
    this.lingerMinutes = config.linger_minutes ?? 15;
    this.conversationMinutes = config.conversation_minutes ?? 3;
    this.tickSeconds = config.tick_seconds ?? 30;

    const now = clock();
    this.lastSentAt = now;
    this.lastAddressedAt = null;
    this.gone = false;
    this.current = null; // the away occurrence the bot is in
    this.afk = false;
    this.applied = null; // the AWAY message the server currently has
    this.leaving = false; // onLeave in flight
    this.lingerLoggedFor = null;
    this.returnedAt = null;
    this.returnedFrom = null;
    this.pending = new Map(); // conversation id -> { addressed, dm } (arrived while gone)
    this.initial = true;
    this.interval = null;
  }

  start() {
    if (!this.enabled) return;
    this.tick();
    this.interval = setInterval(() => this.tick(), this.tickSeconds * 1000);
    if (this.interval.unref) this.interval.unref();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** The connection was (re)made: the server has no away status for us. */
  reconnected() {
    this.applied = null;
    if (this.enabled) this.apply(this.desired());
  }

  /** The bot sent a line: afk is over. */
  noteSent(now = this.clock()) {
    this.lastSentAt = now;
    if (this.afk) {
      this.afk = false;
      this.apply(null);
    }
  }

  /** Someone named the bot or DMed it: it's in a conversation. */
  noteAddressed(now = this.clock()) {
    this.lastAddressedAt = now;
  }

  /** A line arrived while the bot was gone; it'll be looked at on return. */
  notePending(conversationId, { addressed = false, dm = false } = {}) {
    const entry = this.pending.get(conversationId) || { addressed: false, dm };
    entry.addressed = entry.addressed || addressed;
    this.pending.set(conversationId, entry);
  }

  /** The schedule's view of now, with no state of ours applied. */
  scheduled(now = this.clock()) {
    return presenceAt(this.schedule, now, { timezone: this.timezone, seed: this.seed });
  }

  desired() {
    if (this.gone && this.current) return this.current.block.awayMessage;
    if (this.afk) return this.afkMessage.replace("{time}", formatStamp(this.lastSentAt, this.timezone));
    return null;
  }

  apply(message) {
    if (message === this.applied) return;
    this.applied = message;
    try {
      this.hooks.setAway(message);
    } catch (err) {
      this.logger.error(`Setting away status failed: ${err.message}`);
    }
  }

  inConversation(now) {
    const recent = Math.max(this.lastSentAt?.getTime() ?? 0, this.lastAddressedAt?.getTime() ?? 0);
    return now.getTime() - recent < this.conversationMinutes * 60000;
  }

  async tick(now = this.clock()) {
    if (!this.enabled || this.leaving) return;
    const { current } = this.scheduled(now);
    const target = current && current.block.kind === "away" ? current : null;

    if (target && !this.gone) {
      if (this.initial) {
        // Started up in the middle of a block: just be gone, no goodbyes.
        this.gone = true;
        this.current = target;
        this.afk = false;
      } else if (this.inConversation(now) && now - target.start < this.lingerMinutes * 60000) {
        if (this.lingerLoggedFor !== target.start.getTime()) {
          this.lingerLoggedFor = target.start.getTime();
          this.logger.info(`Lingering before going (${target.block.activity}): mid-conversation`);
        }
      } else {
        await this.leave(target, now);
      }
    } else if (!target && this.gone) {
      this.comeBack(now);
    } else if (target && this.gone && target !== this.current) {
      this.current = target;
    }

    if (!this.gone) {
      this.afk = this.afkMinutes > 0 && now.getTime() - this.lastSentAt.getTime() >= this.afkMinutes * 60000;
    }
    this.apply(this.desired());
    this.initial = false;
  }

  async leave(occurrence, now) {
    this.leaving = true;
    try {
      if (this.hooks.onLeave) await this.hooks.onLeave(occurrence);
    } catch (err) {
      this.logger.error(`Goodbye pass failed: ${err.message}`);
    } finally {
      this.leaving = false;
    }
    this.gone = true;
    this.current = occurrence;
    this.afk = false;
    this.logger.info(`Away: ${occurrence.block.activity} until about ${formatClock(occurrence.end, this.timezone)}`);
  }

  comeBack(now) {
    const left = this.current;
    this.gone = false;
    this.current = null;
    this.afk = false;
    this.lastSentAt = now; // the afk clock restarts on return
    this.returnedAt = now;
    this.returnedFrom = left;
    this.apply(null);
    const pending = this.pending;
    this.pending = new Map();
    this.logger.info(`Back (was ${left?.block.activity ?? "away"}); ${pending.size} conversation(s) moved meanwhile`);
    try {
      if (this.hooks.onReturn) this.hooks.onReturn(left, pending);
    } catch (err) {
      this.logger.error(`Return pass failed: ${err.message}`);
    }
  }

  /** For the dashboard. */
  snapshot(now = this.clock()) {
    const { current, next } = this.scheduled(now);
    const state = this.gone ? "away" : this.afk ? "afk" : "here";
    return {
      state,
      activity: this.gone ? this.current?.block.activity ?? null : current?.block.activity ?? null,
      away_message: this.applied,
      until: this.gone ? this.current?.end?.toISOString() ?? null : current?.end?.toISOString() ?? null,
      next: next ? { activity: next.block.activity, at: next.start.toISOString() } : null,
    };
  }

  /**
   * A few sentences about the bot's day for the prompts, or null when there
   * is nothing to say (no schedule, nothing recent, not afk).
   * @param {Date} [now]
   * @param {Object} [options]
   * @param {Object} [options.leaving] - The occurrence the bot is about to
   *   go into (the goodbye pass)
   */
  describe(now = this.clock(), { leaving = null } = {}) {
    const tz = this.timezone;
    const clock = (d) => formatClock(d, tz);
    const minutes = (ms) => Math.round(ms / 60000);
    const ago = (d) => {
      const m = minutes(now - d);
      if (m < 1) return "just now";
      if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
      const h = Math.round(m / 60);
      return `${h} hour${h === 1 ? "" : "s"} ago`;
    };
    const parts = [];
    const { current, previous, next } = this.scheduled(now);

    if (leaving) {
      parts.push(`You're about to go: ${leaving.block.activity}, until about ${clock(leaving.end)}.`);
    } else if (current && current.block.kind === "here") {
      parts.push(`You're ${current.block.activity} (since ${clock(current.start)}, until about ${clock(current.end)}).`);
    } else if (current && current.block.kind === "away" && !this.gone) {
      // Lingering past the start of an away block.
      parts.push(`You're meant to be ${current.block.activity} already; you'll head off shortly.`);
    }

    const back = this.returnedFrom && this.returnedAt && now - this.returnedAt < 30 * 60000 ? this.returnedFrom : null;
    if (back) {
      parts.push(
        `You just got back (${ago(this.returnedAt)}): you were ${back.block.activity} until ${clock(back.end)}, so anything after your last line happened while you were away.`
      );
    } else if (previous && now - previous.end < 4 * 60 * 60000 && previous !== current) {
      parts.push(`Earlier: you were ${previous.block.activity} until ${clock(previous.end)} (${ago(previous.end)}).`);
    }

    if (!leaving && next && next.start - now < 6 * 60 * 60000) {
      parts.push(`Next up: ${next.block.activity}, from about ${clock(next.start)}.`);
    }

    if (this.afk && !this.gone) {
      const idle = minutes(now - this.lastSentAt);
      parts.push(`You haven't typed anything for ${idle} minutes, so your client shows you as afk; saying something now is you coming back to the keyboard.`);
    }

    return parts.length > 0 ? parts.join(" ") : null;
  }
}

module.exports = { Presence };
