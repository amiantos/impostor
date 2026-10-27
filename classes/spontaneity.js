/**
 * Unprompted lines into a quiet channel.
 *
 * Every bot in the process shares one SilenceBroker, so two of them never
 * fill the same silence: a bot claims a channel before it asks the model,
 * and after any bot has spoken unprompted there the channel is closed to
 * all of them for `channel_gap_minutes`. On top of that each bot draws its
 * own quiet threshold per attempt (between `quiet_min_minutes` and
 * `quiet_max_minutes`), holds off while someone is typing, and is capped
 * by `max_per_day` and `min_gap_minutes`.
 *
 * Spontaneity decides *whether* to try; the client does the asking (the
 * reply model, told the channel has been quiet, with "say nothing" as the
 * expected answer most of the time). A `nudge` is a one-off attempt with a
 * shorter quiet threshold, used when the bot comes back from an away block
 * and the channel is quiet: the natural moment for "morning" or "ugh,
 * class".
 *
 * Clock injected; `tick(now)` is driven by tests.
 */

class SilenceBroker {
  constructor({ channelGapMinutes = 30, clock = () => new Date() } = {}) {
    this.channelGapMinutes = channelGapMinutes;
    this.clock = clock;
    this.claims = new Map(); // channel (lower) -> botId holding it
    this.lastFill = new Map(); // channel (lower) -> { botId, at }
  }

  /** @returns {{ok: boolean, reason?: string}} */
  claim(channel, botId, now = this.clock()) {
    const key = channel.toLowerCase();
    const holder = this.claims.get(key);
    if (holder && holder !== botId) return { ok: false, reason: `${holder} is already on it` };
    const last = this.lastFill.get(key);
    if (last && now - last.at < this.channelGapMinutes * 60000) {
      const minutes = Math.round((now - last.at) / 60000);
      return { ok: false, reason: `${last.botId} spoke unprompted ${minutes} min ago` };
    }
    this.claims.set(key, botId);
    return { ok: true };
  }

  /** The claim is over; `spoke` closes the channel to everyone for a while. */
  release(channel, botId, spoke, now = this.clock()) {
    const key = channel.toLowerCase();
    if (this.claims.get(key) === botId) this.claims.delete(key);
    if (spoke) this.lastFill.set(key, { botId, at: now });
  }
}

class Spontaneity {
  /**
   * @param {Object} options
   * @param {Object} options.logger
   * @param {string} options.botId
   * @param {SilenceBroker} options.broker
   * @param {Object} [options.config] - The `spontaneous` config section
   * @param {() => Date} [options.clock]
   * @param {() => number} [options.random] - [0, 1); injectable for tests
   */
  constructor({ logger, botId, broker, config = {}, clock = () => new Date(), random = Math.random }) {
    this.logger = logger;
    this.botId = botId;
    this.broker = broker;
    this.clock = clock;
    this.random = random;
    this.enabled = config.enabled !== false;
    this.quietMin = config.quiet_min_minutes ?? 15;
    this.quietMax = Math.max(this.quietMin, config.quiet_max_minutes ?? 45);
    this.maxPerDay = config.max_per_day ?? 3;
    this.minGapMinutes = config.min_gap_minutes ?? 120;
    this.typingWaitSeconds = config.typing_wait_seconds ?? 30;
    this.returnDelayMin = config.return_delay_min_minutes ?? 1;
    this.returnDelayMax = Math.max(this.returnDelayMin, config.return_delay_max_minutes ?? 5);
    this.returnQuietMinutes = config.return_quiet_minutes ?? 5;
    this.news = config.news !== false;
    this.startedAt = clock();
    this.channels = new Map(); // channel -> { threshold, lastAttemptAt, nudge }
    this.spoken = []; // Dates the bot spoke unprompted (any channel)
  }

  drawMinutes(min, max) {
    return min + this.random() * (max - min);
  }

  state(channel) {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, { threshold: this.drawMinutes(this.quietMin, this.quietMax), lastAttemptAt: null, nudge: null });
    }
    return this.channels.get(channel);
  }

  /** The bot just came back; try once, soon, if the channel is quiet. */
  nudge(channel, now = this.clock()) {
    const delay = this.drawMinutes(this.returnDelayMin, this.returnDelayMax);
    this.state(channel).nudge = { at: new Date(now.getTime() + delay * 60000), quietMinutes: this.returnQuietMinutes };
  }

  spokenInLastDay(now) {
    const cutoff = now.getTime() - 24 * 60 * 60000;
    this.spoken = this.spoken.filter((d) => d.getTime() > cutoff);
    return this.spoken.length;
  }

  /**
   * Whether to try filling this silence now.
   * @param {string} channel
   * @param {Object} facts - From the client
   * @param {Date|null} facts.lastLineAt - Newest line in the channel, anyone's
   * @param {number} facts.present - People in the channel who are not away (bot excluded)
   * @param {string|null} facts.typing - Who is typing, if anyone
   * @param {boolean} facts.gone - The bot is away itself
   * @param {Date} [now]
   * @returns {{go: boolean, reason: string, quietMinutes?: number}}
   */
  decide(channel, facts, now = this.clock()) {
    if (!this.enabled) return { go: false, reason: "disabled" };
    const s = this.state(channel);
    const nudge = s.nudge && s.nudge.at <= now ? s.nudge : null;
    if (s.nudge && !nudge) return { go: false, reason: "nudge pending" };
    // A nudge is one look, whatever it finds: a channel that is busy when
    // the bot gets back is the catch-up evaluation's business, not this one's.
    if (nudge) s.nudge = null;
    if (facts.gone) return { go: false, reason: "away" };

    const since = Math.max(
      facts.lastLineAt ? facts.lastLineAt.getTime() : 0,
      s.lastAttemptAt ? s.lastAttemptAt.getTime() : 0,
      this.startedAt.getTime()
    );
    const quietMinutes = (now.getTime() - since) / 60000;
    const threshold = nudge ? nudge.quietMinutes : s.threshold;
    if (quietMinutes < threshold) {
      return { go: false, reason: `quiet ${quietMinutes.toFixed(0)} of ${threshold.toFixed(0)} min` };
    }
    if (facts.present < 1) return { go: false, reason: "nobody here" };
    if (facts.typing) return { go: false, reason: `${facts.typing} is typing` };
    if (this.spokenInLastDay(now) >= this.maxPerDay) return { go: false, reason: `${this.maxPerDay} already today` };
    const last = this.spoken[this.spoken.length - 1];
    if (last && now - last < this.minGapMinutes * 60000) {
      return { go: false, reason: `spoke unprompted ${Math.round((now - last) / 60000)} min ago` };
    }
    const claim = this.broker.claim(channel, this.botId, now);
    if (!claim.ok) return { go: false, reason: claim.reason };
    return { go: true, reason: `quiet ${quietMinutes.toFixed(0)} min`, quietMinutes: Math.round(quietMinutes) };
  }

  /** The attempt is over: redraw the threshold and release the channel. */
  finish(channel, spoke, now = this.clock()) {
    const s = this.state(channel);
    s.lastAttemptAt = now;
    s.threshold = this.drawMinutes(this.quietMin, this.quietMax);
    s.nudge = null;
    if (spoke) this.spoken.push(now);
    this.broker.release(channel, this.botId, spoke, now);
  }

  /** The claim was never used (the queue dropped it). */
  abandon(channel) {
    this.broker.release(channel, this.botId, false);
  }
}

module.exports = { SilenceBroker, Spontaneity };
