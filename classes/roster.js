/**
 * Who is in each channel and whether they're away, kept from IRC events:
 * NAMES on join, join/part/kick/quit/nick after that, away-notify for away
 * and back (with the message), and a WHO on join for the away flag of
 * people who were already there (WHO carries no message). Also the last
 * +typing seen per channel, so a bot can hold off while someone is mid-line.
 *
 * Pure bookkeeping: no IRC client in here, the ImpostorClient feeds it.
 */
class Roster {
  /**
   * @param {Object} options
   * @param {string} options.selfNick - Left out of descriptions
   * @param {string|null} [options.bridgeNick] - The relay bot, also left out
   * @param {() => Date} [options.clock]
   */
  constructor({ selfNick, bridgeNick = null, clock = () => new Date() }) {
    this.selfNick = selfNick;
    this.bridgeNick = bridgeNick;
    this.clock = clock;
    this.members = new Map(); // channel (lower) -> Map(nick lower -> nick as spelled)
    this.away = new Map(); // nick lower -> { message: string|null, since: Date }
    this.typing = new Map(); // channel (lower) -> { nick, at: Date }
  }

  static key(s) {
    return String(s).toLowerCase();
  }

  channel(channel) {
    const key = Roster.key(channel);
    if (!this.members.has(key)) this.members.set(key, new Map());
    return this.members.get(key);
  }

  /** NAMES: the whole list at once. */
  setUserlist(channel, users) {
    const list = new Map();
    for (const u of users || []) {
      const nick = typeof u === "string" ? u : u.nick;
      if (nick) list.set(Roster.key(nick), nick);
    }
    this.members.set(Roster.key(channel), list);
  }

  join(nick, channel) {
    this.channel(channel).set(Roster.key(nick), nick);
  }

  leave(nick, channel) {
    const list = this.members.get(Roster.key(channel));
    if (list) list.delete(Roster.key(nick));
    if (!this.isAnywhere(nick)) this.away.delete(Roster.key(nick));
  }

  quit(nick) {
    for (const list of this.members.values()) list.delete(Roster.key(nick));
    this.away.delete(Roster.key(nick));
  }

  /** The bot itself left or was kicked: forget the channel. */
  forget(channel) {
    this.members.delete(Roster.key(channel));
    this.typing.delete(Roster.key(channel));
  }

  rename(oldNick, newNick) {
    const from = Roster.key(oldNick);
    const to = Roster.key(newNick);
    for (const list of this.members.values()) {
      if (list.has(from)) {
        list.delete(from);
        list.set(to, newNick);
      }
    }
    if (this.away.has(from)) {
      this.away.set(to, this.away.get(from));
      this.away.delete(from);
    }
    if (Roster.key(this.selfNick) === from) this.selfNick = newNick;
  }

  isAnywhere(nick) {
    const key = Roster.key(nick);
    for (const list of this.members.values()) if (list.has(key)) return true;
    return false;
  }

  /** away-notify or RPL_AWAY: the person is away with this message. */
  setAway(nick, message, at = this.clock()) {
    const key = Roster.key(nick);
    const known = this.away.get(key);
    const text = message && String(message).trim() ? String(message).trim() : null;
    // A repeated AWAY with the same text is a refresh, not a new departure.
    if (known && known.message === text) return;
    this.away.set(key, { message: text, since: at });
  }

  setBack(nick) {
    this.away.delete(Roster.key(nick));
  }

  /**
   * A WHO reply: the away flag for everyone listed. Only sets or clears;
   * a message learned from away-notify is kept.
   */
  setWho(users, at = this.clock()) {
    for (const u of users || []) {
      if (!u?.nick) continue;
      const key = Roster.key(u.nick);
      if (u.away) {
        if (!this.away.has(key)) this.away.set(key, { message: null, since: at });
      } else {
        this.away.delete(key);
      }
    }
  }

  isAway(nick) {
    return this.away.has(Roster.key(nick));
  }

  awayOf(nick) {
    return this.away.get(Roster.key(nick)) || null;
  }

  noteTyping(channel, nick, status, at = this.clock()) {
    const key = Roster.key(channel);
    if (status === "active") this.typing.set(key, { nick, at });
    else if (this.typing.get(key)?.nick === nick) this.typing.delete(key);
  }

  /** Who was typing within the last `withinSeconds`, or null. */
  someoneTyping(channel, withinSeconds = 10, now = this.clock()) {
    const t = this.typing.get(Roster.key(channel));
    if (!t) return null;
    return now - t.at <= withinSeconds * 1000 ? t.nick : null;
  }

  /** Everyone in the channel except the bot and the relay. */
  others(channel) {
    const list = this.members.get(Roster.key(channel));
    if (!list) return [];
    const skip = new Set([Roster.key(this.selfNick), this.bridgeNick ? Roster.key(this.bridgeNick) : null]);
    return [...list.entries()].filter(([key]) => !skip.has(key)).map(([, nick]) => nick);
  }

  /** People in the channel who are not away (the bot and the relay excluded). */
  present(channel) {
    return this.others(channel).filter((nick) => !this.isAway(nick));
  }

  /**
   * "afk for 23 minutes" for lurker's "afk since YYYY-MM-DD HH:MM:SS±ZZZZ",
   * otherwise the message itself, or "away" with none.
   */
  static awayLabel(entry, now) {
    if (!entry) return null;
    const m = entry.message && entry.message.match(/^afk since (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})([+-])(\d{2})(\d{2})$/);
    if (m) {
      const [, y, mo, d, h, mi, s, sign, oh, om] = m;
      const offset = (Number(oh) * 60 + Number(om)) * (sign === "-" ? -1 : 1);
      const since = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offset * 60000;
      const minutes = Math.max(0, Math.round((now.getTime() - since) / 60000));
      if (minutes < 60) return `afk for ${minutes} minute${minutes === 1 ? "" : "s"}`;
      const hours = Math.round(minutes / 60);
      return `afk for ${hours} hour${hours === 1 ? "" : "s"}`;
    }
    return entry.message ? `away: ${entry.message}` : "away";
  }

  /**
   * One line for the prompts, or null when nothing is known. For a channel:
   * "amiantos, isaac (afk for 23 minutes), nightmare (away: grazing)". For a
   * DM: the other person's away status, when they are away.
   * @param {string} conversationId - "#channel" or a nick
   * @param {Date} [now]
   */
  describe(conversationId, now = this.clock()) {
    if (!conversationId.startsWith("#")) {
      const label = Roster.awayLabel(this.awayOf(conversationId), now);
      return label ? `${conversationId} is ${label}, so they may not see this until they're back.` : null;
    }
    const others = this.others(conversationId);
    if (others.length === 0) return null;
    const parts = others.map((nick) => {
      const label = Roster.awayLabel(this.awayOf(nick), now);
      return label ? `${nick} (${label})` : nick;
    });
    const away = others.filter((nick) => this.isAway(nick)).length;
    const note = away === others.length ? " Everyone else is away right now." : "";
    return `In ${conversationId} right now: ${parts.join(", ")}.${note}`;
  }
}

module.exports = { Roster };
