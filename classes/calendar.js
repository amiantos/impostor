/**
 * What the date means to a bot: a persona's "## Calendar" section lists
 * dates it would know about (a holiday it cares about, an anniversary, a
 * week that matters to it), and the prompts get a line about the ones that
 * are today, just past, or coming up, so a horse knows Halloween is on
 * Saturday without anyone telling it. Pure: dates in, lines out.
 *
 * Section format, one item per line:
 *   - 10-31: halloween; the one night the living dress like you
 *   - 12-24..01-01: the dead week between christmas and new year
 *   - 11-04 2026: the midterm (a date with a year happens once)
 * A range may cross the year end. Blank lines and "#" comments are skipped.
 */

const { localParts } = require("./schedule");

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * @param {string[]} lines - The section's lines
 * @returns {Array<{from: {month: number, day: number}, to: {month: number, day: number}|null, year: number|null, text: string}>}
 */
function parseCalendar(lines) {
  const entries = [];
  for (const raw of lines || []) {
    const line = raw.trim().replace(/^[-*]\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\d{1,2})-(\d{1,2})(?:\.\.(\d{1,2})-(\d{1,2}))?(?:\s+(\d{4}))?\s*:\s*(.+)$/);
    if (!m) throw new Error(`Calendar line "${line}" is not "MM-DD: text", "MM-DD..MM-DD: text" or "MM-DD YYYY: text"`);
    const from = { month: Number(m[1]), day: Number(m[2]) };
    const to = m[3] ? { month: Number(m[3]), day: Number(m[4]) } : null;
    for (const d of [from, to]) {
      if (d && (d.month < 1 || d.month > 12 || d.day < 1 || d.day > 31)) {
        throw new Error(`Calendar line "${line}" has an impossible date`);
      }
    }
    entries.push({ from, to, year: m[5] ? Number(m[5]) : null, text: m[6].trim() });
  }
  return entries;
}

/** Days from the civil date (y, m, d) to another, ignoring time of day. */
function dayNumber(year, month, day) {
  return Math.round(Date.UTC(year, month - 1, day) / 86400000);
}

/**
 * What the calendar says around `now`: entries that are today or ongoing,
 * ended within `pastDays`, or starting within `horizonDays`, nearest first.
 * @param {Array} entries - From parseCalendar
 * @param {Date} now
 * @param {string} timezone
 * @param {{horizonDays?: number, pastDays?: number}} [options]
 * @returns {Array<{text: string, when: string, daysUntil: number}>}
 */
function calendarNotes(entries, now, timezone, { horizonDays = 7, pastDays = 1 } = {}) {
  if (!entries || entries.length === 0) return [];
  const today = localParts(now, timezone);
  const todayNumber = dayNumber(today.year, today.month, today.day);
  const notes = [];

  for (const entry of entries) {
    // The occurrence that matters: this year's, unless it ended more than
    // pastDays ago, in which case next year's. A dated entry happens once.
    const years = entry.year !== null ? [entry.year] : [today.year - 1, today.year, today.year + 1];
    let best = null;
    for (const year of years) {
      const start = dayNumber(year, entry.from.month, entry.from.day);
      let end = start;
      if (entry.to) {
        end = dayNumber(year, entry.to.month, entry.to.day);
        if (end < start) end = dayNumber(year + 1, entry.to.month, entry.to.day);
      }
      const daysUntil = start - todayNumber;
      const daysSinceEnd = todayNumber - end;
      if (daysSinceEnd > pastDays) continue;
      if (daysUntil > horizonDays) continue;
      if (!best || Math.abs(daysUntil) < Math.abs(best.daysUntil)) best = { start, end, daysUntil, daysSinceEnd };
    }
    if (!best) continue;

    const startDate = new Date(best.start * 86400000);
    const endDate = new Date(best.end * 86400000);
    const label = (d) => `${DAY_NAMES[d.getUTCDay()]} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
    let when;
    if (best.daysUntil <= 0 && best.daysSinceEnd <= 0) {
      when = best.end === best.start ? "today" : best.daysUntil === 0 ? `starts today, until ${label(endDate)}` : `now, until ${label(endDate)}`;
    } else if (best.daysSinceEnd > 0) {
      when = best.daysSinceEnd === 1 ? "yesterday" : `${best.daysSinceEnd} days ago`;
    } else if (best.daysUntil === 1) {
      when = "tomorrow";
    } else {
      when = `in ${best.daysUntil} days, ${label(startDate)}`;
    }
    notes.push({ text: entry.text, when, daysUntil: best.daysUntil });
  }

  notes.sort((a, b) => Math.abs(a.daysUntil) - Math.abs(b.daysUntil));
  return notes;
}

/**
 * The prompt line, or null: "halloween; the one night ... (in 3 days, Sat
 * Oct 31); the dead week ... (now, until Thu Jan 1)".
 */
function calendarLine(entries, now, timezone, options) {
  const notes = calendarNotes(entries, now, timezone, options);
  if (notes.length === 0) return null;
  return notes.map((n) => `${n.text} (${n.when})`).join("; ");
}

module.exports = { parseCalendar, calendarNotes, calendarLine };
