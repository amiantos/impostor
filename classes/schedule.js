/**
 * A persona's routine: when they sleep, when they're out, when they're
 * around but doing something. Parsed from the "## Schedule" section of the
 * persona file, one block per line:
 *
 *   away 00:30-08:30 ~45m: asleep | zzz
 *   away mon wed fri 10:00-11:20 ~10m: in class | in class, back after
 *   here daily 03:30-04:30 ~20m: mid-backup, sluggish
 *
 *   <kind> [days] <start>-<end> [~jitter]: <activity> [| <away message>]
 *
 * - kind: "away" (gone: the bot sets itself away, doesn't read or answer
 *   anything, and catches up when it comes back) or "here" (still around and
 *   answering; the activity only colours what it knows about its day).
 * - days: "daily" (the default), "weekdays", "weekends", day names ("mon",
 *   "tuesday"), or a range ("mon-fri"), any mix, separated by spaces or
 *   commas. A block belongs to the day it starts on: "weekdays 23:30-07:30"
 *   starts Monday to Friday night and ends the next morning.
 * - jitter: "~45m" or "~1h" moves each edge by up to that much, differently
 *   every day but the same all day (seeded by the bot id and the date), so
 *   bedtime is "around half past midnight", not on the dot, and a restart
 *   doesn't move it.
 * - activity: how the bot would describe what it's doing, as a phrase that
 *   follows "you're" / "you were": "asleep", "in class", "out grazing".
 * - away message: what the IRC away status says; the activity when absent.
 *   Only "away" blocks use it.
 *
 * Everything here is a pure function of the time passed in, so it can be
 * tested with any clock.
 */

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDays(text) {
  const days = new Set();
  const tokens = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return [0, 1, 2, 3, 4, 5, 6];
  const dayIndex = (word) => {
    const i = DAY_NAMES.indexOf(word.slice(0, 3));
    if (i < 0 || !/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/.test(word)) {
      throw new Error(`unknown day "${word}"`);
    }
    return i;
  };
  for (const token of tokens) {
    if (token === "daily" || token === "everyday" || token === "every") {
      for (let i = 0; i < 7; i++) days.add(i);
    } else if (token === "day") {
      // "every day"
    } else if (token === "weekdays") {
      for (let i = 1; i <= 5; i++) days.add(i);
    } else if (token === "weekends") {
      days.add(0);
      days.add(6);
    } else if (token.includes("-")) {
      const [from, to] = token.split("-");
      let i = dayIndex(from);
      const end = dayIndex(to);
      days.add(i);
      while (i !== end) {
        i = (i + 1) % 7;
        days.add(i);
      }
    } else {
      days.add(dayIndex(token));
    }
  }
  return [...days].sort((a, b) => a - b);
}

const LINE = /^(away|here)\b\s*([a-z ,-]*?)\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*(?:~\s*(\d+)\s*(m|min|mins|h|hr|hrs)?)?\s*:\s*(.+)$/i;

/**
 * @param {string} text - The Schedule section
 * @returns {{blocks: Array}|null} null when the section is empty
 */
function parseSchedule(text) {
  const blocks = [];
  const lines = String(text ?? "").split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = line.match(LINE);
    if (!m) {
      throw new Error(`Schedule line ${i + 1} is not "<away|here> [days] HH:MM-HH:MM [~Nm]: activity [| away message]": ${line}`);
    }
    const [, kind, dayText, sh, sm, eh, em, jitterNum, jitterUnit, rest] = m;
    const start = Number(sh) * 60 + Number(sm);
    const end = Number(eh) * 60 + Number(em);
    for (const [h, mm] of [[sh, sm], [eh, em]]) {
      if (Number(h) > 23 || Number(mm) > 59) throw new Error(`Schedule line ${i + 1}: bad time ${h}:${mm}`);
    }
    if (start === end) throw new Error(`Schedule line ${i + 1}: a block can't start and end at the same time`);
    let jitter = jitterNum ? Number(jitterNum) : 0;
    if (jitterUnit && /^h/.test(jitterUnit.toLowerCase())) jitter *= 60;
    let days;
    try {
      days = parseDays(dayText);
    } catch (err) {
      throw new Error(`Schedule line ${i + 1}: ${err.message}`);
    }
    const [activityText, awayText] = rest.split("|").map((s) => s.trim());
    if (!activityText) throw new Error(`Schedule line ${i + 1}: missing activity`);
    blocks.push({
      kind: kind.toLowerCase(),
      days,
      start,
      end,
      jitter,
      activity: activityText,
      awayMessage: awayText || activityText,
    });
  });
  return blocks.length > 0 ? { blocks } : null;
}

// --- time zone helpers -----------------------------------------------------

const partsCache = new Map();
function partsFormatter(timezone) {
  if (!partsCache.has(timezone)) {
    partsCache.set(
      timezone,
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        weekday: "short",
      })
    );
  }
  return partsCache.get(timezone);
}

/** The wall clock in `timezone` at `date`. */
function localParts(date, timezone) {
  const parts = {};
  for (const p of partsFormatter(timezone).formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: DAY_NAMES.indexOf(parts.weekday.toLowerCase().slice(0, 3)),
  };
}

/** Minutes the zone is ahead of UTC at `date` (negative behind). */
function offsetMinutes(date, timezone) {
  const p = localParts(date, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** The instant at which the wall clock in `timezone` reads the given date and time. */
function zonedDate(timezone, year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const candidate = wall - offsetMinutes(new Date(guess), timezone) * 60000;
    if (candidate === guess) break;
    guess = candidate;
  }
  return new Date(guess);
}

/** `YYYY-MM-DD HH:MM:SS±ZZZZ` in `timezone` (lurker's afk stamp). */
function formatStamp(date, timezone) {
  const p = localParts(date, timezone);
  const off = offsetMinutes(date, timezone);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

const clockCache = new Map();
/** "8:50 AM" in `timezone`. */
function formatClock(date, timezone) {
  if (!clockCache.has(timezone)) {
    clockCache.set(timezone, new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }));
  }
  return clockCache.get(timezone).format(date);
}

// --- jitter ----------------------------------------------------------------

/** A stable number in [0, 1) for a string (FNV-1a). */
function hash01(str) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h / 4294967296;
}

function jitterMinutes(seed, dateKey, blockIndex, edge, jitter) {
  if (!jitter) return 0;
  const u = hash01(`${seed}|${dateKey}|${blockIndex}|${edge}`);
  return Math.round((u * 2 - 1) * jitter);
}

// --- occurrences -----------------------------------------------------------

function dateKeyOf(year, month, day) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Every block occurrence that starts on the local day `dayOffset` days from
 * `now`'s local date, with that day's jitter applied.
 */
function occurrencesOnDay(schedule, now, { timezone, seed }, dayOffset) {
  const today = localParts(now, timezone);
  const d = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const weekday = d.getUTCDay();
  const dateKey = dateKeyOf(year, month, day);
  const result = [];
  schedule.blocks.forEach((block, index) => {
    if (!block.days.includes(weekday)) return;
    const startShift = jitterMinutes(seed, dateKey, index, "start", block.jitter);
    const endShift = jitterMinutes(seed, dateKey, index, "end", block.jitter);
    const start = new Date(zonedDate(timezone, year, month, day, 0, 0).getTime() + (block.start + startShift) * 60000);
    const endBase = block.end > block.start ? 0 : DAY_MS;
    let end = new Date(zonedDate(timezone, year, month, day, 0, 0).getTime() + endBase + (block.end + endShift) * 60000);
    if (end <= start) end = new Date(start.getTime() + 60000);
    result.push({ block, index, start, end, dateKey });
  });
  return result;
}

/**
 * Occurrences from yesterday to tomorrow (local days), oldest start first.
 * Enough to find the current one, the last one over, and the next.
 */
function occurrencesAround(schedule, now, options) {
  const all = [];
  for (const offset of [-1, 0, 1]) all.push(...occurrencesOnDay(schedule, now, options, offset));
  return all.sort((a, b) => a.start - b.start);
}

/**
 * What the schedule says the bot is doing at `now`.
 * @param {{blocks: Array}|null} schedule
 * @param {Date} now
 * @param {{timezone: string, seed: string}} options
 * @returns {{state: "away"|"here", current: Object|null, previous: Object|null, next: Object|null}}
 *   current/previous/next are occurrences ({block, start, end}); previous is
 *   the most recently ended, next the soonest to start.
 */
function presenceAt(schedule, now, options) {
  if (!schedule || schedule.blocks.length === 0) {
    return { state: "here", current: null, previous: null, next: null };
  }
  const occurrences = occurrencesAround(schedule, now, options);
  const live = occurrences.filter((o) => o.start <= now && now < o.end);
  // Away wins over here when blocks overlap; among equals, the later start.
  live.sort((a, b) => {
    if (a.block.kind !== b.block.kind) return a.block.kind === "away" ? -1 : 1;
    return b.start - a.start;
  });
  const current = live[0] || null;
  const over = occurrences.filter((o) => o.end <= now).sort((a, b) => b.end - a.end);
  const ahead = occurrences.filter((o) => o.start > now);
  return {
    state: current ? current.block.kind : "here",
    current,
    previous: over[0] || null,
    next: ahead[0] || null,
  };
}

module.exports = {
  parseSchedule,
  parseDays,
  presenceAt,
  occurrencesAround,
  localParts,
  offsetMinutes,
  zonedDate,
  formatStamp,
  formatClock,
  hash01,
};
