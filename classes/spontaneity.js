/**
 * Unprompted lines into a quiet channel.
 *
 * Two parts. `Spontaneity` is per bot: its own daily cap, the minimum gap
 * between its unprompted lines, its weight in the draw, and the nudge it
 * gets when it comes back from an away block. `SilenceDirector` is shared
 * by every bot in the process: it watches each channel, and when one has
 * been quiet past the channel's drawn threshold (between `quiet_min_minutes`
 * and `quiet_max_minutes`) it picks ONE bot to offer the floor to, weighted
 * by the bots' `weight`, against whoever filled the last silence there, and
 * against whoever has spoken unprompted most today. After any bot speaks
 * unprompted the channel is closed to all of them for `channel_gap_minutes`.
 *
 * The director decides *who* and *when*; the chosen client does the asking
 * (the reply model, told it has the floor; see processSpontaneousMessage).
 * A nudge is a one-off look with a short quiet threshold for the bot that
 * just got back: the natural moment for "morning" or "ugh, class".
 *
 * `NewsDesk` is the small shared cache in front of web search for the
 * "something you saw today" material, so three bots don't run the same
 * query three times.
 *
 * Clocks are injected; tests drive `tick(now)`.
 */

const { hash01 } = require("./schedule");

class Spontaneity {
  /**
   * @param {Object} options
   * @param {Object} options.logger
   * @param {string} options.botId
   * @param {Object} [options.config] - This bot's `spontaneous` section
   * @param {() => Date} [options.clock]
   * @param {() => number} [options.random] - [0, 1); injectable for tests
   */
  constructor({ logger, botId, config = {}, clock = () => new Date(), random = Math.random }) {
    this.logger = logger;
    this.botId = botId;
    this.clock = clock;
    this.random = random;
    this.enabled = config.enabled !== false;
    this.maxPerDay = config.max_per_day ?? 5;
    this.minGapMinutes = config.min_gap_minutes ?? 60;
    this.weight = Math.max(0, Number(config.weight ?? 1)) || 0;
    this.returnDelayMin = config.return_delay_min_minutes ?? 1;
    this.returnDelayMax = Math.max(this.returnDelayMin, config.return_delay_max_minutes ?? 5);
    this.returnQuietMinutes = config.return_quiet_minutes ?? 5;
    this.news = config.news !== false;
    this.newsChance = Math.min(1, Math.max(0, Number(config.news_chance ?? 0.35)));
    this.seedsPerDay = Math.max(0, config.seeds_per_day ?? 3);
    this.nudges = new Map(); // channel (lower) -> { at: Date, quietMinutes }
    this.spoken = []; // Dates the bot spoke unprompted (any channel)
  }

  drawMinutes(min, max) {
    return min + this.random() * (max - min);
  }

  /** The bot just came back; one look, soon, if the channel is quiet. */
  nudge(channel, now = this.clock()) {
    const delay = this.drawMinutes(this.returnDelayMin, this.returnDelayMax);
    this.nudges.set(channel.toLowerCase(), { at: new Date(now.getTime() + delay * 60000), quietMinutes: this.returnQuietMinutes });
  }

  /** The nudge for this channel, if any: `{due, quietMinutes}`. */
  nudgeFor(channel, now = this.clock()) {
    const n = this.nudges.get(channel.toLowerCase());
    if (!n) return null;
    return { due: n.at <= now, quietMinutes: n.quietMinutes };
  }

  /** The nudge got its look, whatever it found. */
  spendNudge(channel) {
    this.nudges.delete(channel.toLowerCase());
  }

  spokenInLastDay(now = this.clock()) {
    const cutoff = now.getTime() - 24 * 60 * 60000;
    this.spoken = this.spoken.filter((d) => d.getTime() > cutoff);
    return this.spoken.length;
  }

  /**
   * Whether this bot may take an unprompted turn right now, by its own
   * limits (the channel's state is the director's business).
   * @param {{gone: boolean}} facts
   * @param {Date} [now]
   * @returns {{ok: boolean, reason: string}}
   */
  allowed(facts, now = this.clock()) {
    if (!this.enabled) return { ok: false, reason: "disabled" };
    if (facts.gone) return { ok: false, reason: "away" };
    if (this.spokenInLastDay(now) >= this.maxPerDay) return { ok: false, reason: `${this.maxPerDay} already today` };
    const last = this.spoken[this.spoken.length - 1];
    if (last && now - last < this.minGapMinutes * 60000) {
      return { ok: false, reason: `spoke unprompted ${Math.round((now - last) / 60000)} min ago` };
    }
    return { ok: true, reason: "free" };
  }

  /** The bot said something unprompted. */
  spoke(now = this.clock()) {
    this.spoken.push(now);
  }

  /** For the dashboard. */
  snapshot(now = this.clock()) {
    const last = this.spoken[this.spoken.length - 1] || null;
    return {
      enabled: this.enabled,
      weight: this.weight,
      spoken_today: this.spokenInLastDay(now),
      max_per_day: this.maxPerDay,
      last_spoke_at: last ? last.toISOString() : null,
    };
  }
}

/**
 * What a bot tells the director about a channel.
 * @typedef {Object} SilenceFacts
 * @property {boolean} inChannel - The bot is in this channel
 * @property {Date|null} lastLineAt - Newest line in the channel, anyone's
 * @property {number} present - People in the channel who could read a line now (bot excluded)
 * @property {string|null} typing - Who is typing, if anyone
 * @property {boolean} gone - The bot is away itself
 * @property {boolean} busy - The bot is already evaluating or answering there
 */

class SilenceDirector {
  /**
   * @param {Object} options
   * @param {Object} options.logger
   * @param {Object} [options.config] - The shared `spontaneous` section
   * @param {() => Date} [options.clock]
   * @param {() => number} [options.random]
   */
  constructor({ logger, config = {}, clock = () => new Date(), random = Math.random }) {
    this.logger = logger;
    this.clock = clock;
    this.random = random;
    this.quietMin = config.quiet_min_minutes ?? 15;
    this.quietMax = Math.max(this.quietMin, config.quiet_max_minutes ?? 45);
    this.channelGapMinutes = config.channel_gap_minutes ?? 30;
    this.typingWaitSeconds = config.typing_wait_seconds ?? 30;
    this.startedAt = clock();
    this.bots = new Map(); // id -> participant
    this.channels = new Map(); // channel (lower) -> { name, threshold, lastAttemptAt, lastFill: {botId, at}|null, claim: string|null }
    this.interval = null;
  }

  /**
   * A participant has `id`, `channels`, `spontaneity`, `silenceFacts(channel, now)`
   * returning SilenceFacts, and `takeSpontaneousTurn(channel, offer, now)`.
   */
  register(participant) {
    this.bots.set(participant.id, participant);
  }

  unregister(participant) {
    this.bots.delete(participant.id);
    for (const s of this.channels.values()) if (s.claim === participant.id) s.claim = null;
  }

  start(everyMs = 60 * 1000) {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), everyMs);
    if (this.interval.unref) this.interval.unref();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  drawMinutes(min, max) {
    return min + this.random() * (max - min);
  }

  state(channel) {
    const key = channel.toLowerCase();
    if (!this.channels.has(key)) {
      this.channels.set(key, { name: channel, threshold: this.drawMinutes(this.quietMin, this.quietMax), lastAttemptAt: null, lastFill: null, claim: null });
    }
    return this.channels.get(key);
  }

  /** Every channel any registered bot reports being in. */
  tick(now = this.clock()) {
    const seen = new Set();
    const results = new Map();
    for (const bot of this.bots.values()) {
      for (const channel of bot.channels || []) {
        const key = channel.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        results.set(channel, this.consider(channel, now));
      }
    }
    return results;
  }

  /**
   * One channel: is it quiet enough, and who, if anyone, gets the floor.
   * @returns {{picked: string|null, reason: string}}
   */
  consider(channel, now = this.clock()) {
    const s = this.state(channel);
    if (s.claim) return this.quiet(channel, { picked: null, reason: `${s.claim} is on it` });
    if (s.lastFill && now - s.lastFill.at < this.channelGapMinutes * 60000) {
      const minutes = Math.round((now - s.lastFill.at) / 60000);
      return this.quiet(channel, { picked: null, reason: `${s.lastFill.botId} spoke unprompted ${minutes} min ago` });
    }

    // What the bots in the channel see; the newest line any of them has.
    const here = [];
    let lastLineAt = 0;
    let present = 0;
    let typing = null;
    for (const bot of this.bots.values()) {
      const facts = bot.silenceFacts(channel, now);
      if (!facts || !facts.inChannel) continue;
      here.push({ bot, facts });
      if (facts.lastLineAt) lastLineAt = Math.max(lastLineAt, facts.lastLineAt.getTime());
      present = Math.max(present, facts.present);
      typing = typing || facts.typing || null;
    }
    if (here.length === 0) return this.quiet(channel, { picked: null, reason: "no bot here" });

    const since = Math.max(lastLineAt, s.lastAttemptAt ? s.lastAttemptAt.getTime() : 0, this.startedAt.getTime());
    const quietMinutes = (now.getTime() - since) / 60000;

    // A bot that just got back gets its own, shorter, look; the look is spent
    // whatever it finds (a busy channel is the catch-up evaluation's business).
    const nudged = [];
    for (const entry of here) {
      const n = entry.bot.spontaneity.nudgeFor(channel, now);
      if (n && n.due) {
        entry.bot.spontaneity.spendNudge(channel);
        if (quietMinutes >= n.quietMinutes) nudged.push(entry);
      }
    }

    if (nudged.length === 0 && quietMinutes < s.threshold) {
      return this.quiet(channel, { picked: null, reason: `quiet ${quietMinutes.toFixed(0)} of ${s.threshold.toFixed(0)} min` });
    }
    if (present < 1) return this.quiet(channel, { picked: null, reason: "nobody here" });
    if (typing) return this.quiet(channel, { picked: null, reason: `${typing} is typing` });

    const pool = nudged.length > 0 ? nudged : here;
    const candidates = [];
    const declined = [];
    for (const { bot, facts } of pool) {
      if (facts.busy) {
        declined.push(`${bot.id}: busy`);
        continue;
      }
      const n = bot.spontaneity.nudgeFor(channel, now);
      if (n && !n.due && nudged.length === 0) {
        declined.push(`${bot.id}: nudge pending`);
        continue;
      }
      const ok = bot.spontaneity.allowed(facts, now);
      if (!ok.ok) {
        declined.push(`${bot.id}: ${ok.reason}`);
        continue;
      }
      let weight = bot.spontaneity.weight;
      if (s.lastFill && s.lastFill.botId === bot.id) weight *= 0.3;
      weight /= 1 + bot.spontaneity.spokenInLastDay(now);
      if (weight > 0) candidates.push({ bot, weight });
    }
    if (candidates.length === 0) {
      return this.quiet(channel, { picked: null, reason: `nobody free (${declined.join("; ") || "no weight"})` });
    }

    const picked = this.draw(candidates);
    s.claim = picked.id;
    const offer = { quietMinutes: Math.round(quietMinutes), nudged: nudged.length > 0 };
    this.logger.info(`${channel} has been quiet ${offer.quietMinutes} min; offering the floor to ${picked.id}`);
    picked.takeSpontaneousTurn(channel, offer, now);
    return { picked: picked.id, reason: `quiet ${offer.quietMinutes} min` };
  }

  quiet(channel, result) {
    this.logger.debug(`No spontaneous line for ${channel}: ${result.reason}`);
    return result;
  }

  draw(candidates) {
    const total = candidates.reduce((sum, c) => sum + c.weight, 0);
    let r = this.random() * total;
    for (const c of candidates) {
      r -= c.weight;
      if (r < 0) return c.bot;
    }
    return candidates[candidates.length - 1].bot;
  }

  /** The turn is over: redraw the threshold; `spoke` closes the channel to everyone for a while. */
  release(channel, botId, spoke, now = this.clock()) {
    const s = this.state(channel);
    if (s.claim === botId) s.claim = null;
    s.lastAttemptAt = now;
    s.threshold = this.drawMinutes(this.quietMin, this.quietMax);
    if (spoke) s.lastFill = { botId, at: now };
  }

  /** The offer was never used (the queue dropped it): just let go of the channel. */
  abandon(channel, botId) {
    const s = this.state(channel);
    if (s.claim === botId) s.claim = null;
  }

  /** For the dashboard. */
  snapshot(now = this.clock()) {
    const out = {};
    for (const s of this.channels.values()) {
      out[s.name] = {
        threshold_minutes: Math.round(s.threshold),
        last_attempt_at: s.lastAttemptAt ? s.lastAttemptAt.toISOString() : null,
        last_fill: s.lastFill ? { bot: s.lastFill.botId, at: s.lastFill.at.toISOString() } : null,
        claimed_by: s.claim,
        closed_for_minutes: s.lastFill ? Math.max(0, Math.round(this.channelGapMinutes - (now - s.lastFill.at) / 60000)) : 0,
      };
    }
    return out;
  }
}

/**
 * A few of the bot's seeds for today: the same few all day (seeded by bot
 * and date), different tomorrow.
 * @param {string[]} seeds
 * @param {string} key - e.g. "layla|2026-10-28"
 * @param {number} n
 */
function seedsForDay(seeds, key, n) {
  if (!seeds || seeds.length === 0 || n <= 0) return [];
  const ranked = seeds
    .map((seed, i) => ({ seed, u: hash01(`${key}|${i}|${seed}`) }))
    .sort((a, b) => a.u - b.u);
  return ranked.slice(0, n).map((r) => r.seed);
}

class NewsDesk {
  /**
   * @param {Object} options
   * @param {{searchWeb: (q: string) => Promise<{success: boolean, output: string, error: string|null}>}} options.search
   * @param {number} [options.ttlMinutes]
   * @param {number} [options.maxChars] - The answer is cut to this
   * @param {() => Date} [options.clock]
   */
  constructor({ search, ttlMinutes = 360, maxChars = 700, clock = () => new Date() }) {
    this.search = search;
    this.ttlMs = ttlMinutes * 60000;
    this.maxChars = maxChars;
    this.clock = clock;
    this.cache = new Map(); // query (lower) -> { at: number, answer: string|null, promise }
  }

  /**
   * The answer to a query, from cache when fresh.
   * @returns {Promise<{query: string, answer: string}|null>} null when the search failed
   */
  async lookup(query) {
    const key = query.trim().toLowerCase();
    const now = this.clock().getTime();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.ttlMs) {
      const answer = await hit.promise;
      return answer ? { query, answer } : null;
    }
    const promise = this.fetch(query);
    this.cache.set(key, { at: now, promise });
    const answer = await promise;
    if (!answer) this.cache.delete(key);
    return answer ? { query, answer } : null;
  }

  async fetch(query) {
    if (!this.search || typeof this.search.searchWeb !== "function") return null;
    try {
      const result = await this.search.searchWeb(query);
      if (!result || !result.success) return null;
      let answer = result.output;
      try {
        const parsed = JSON.parse(result.output);
        if (parsed && typeof parsed.answer === "string") answer = parsed.answer;
      } catch {
        // Plain text is fine too.
      }
      answer = String(answer || "").replace(/\s+/g, " ").trim();
      if (!answer) return null;
      return answer.length > this.maxChars ? answer.slice(0, this.maxChars - 1).trimEnd() + "…" : answer;
    } catch {
      return null;
    }
  }
}

module.exports = { Spontaneity, SilenceDirector, NewsDesk, seedsForDay };
