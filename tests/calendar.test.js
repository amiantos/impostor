const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseCalendar, calendarNotes, calendarLine } = require("../classes/calendar");
const { parsePersona } = require("../classes/persona");

const TZ = "America/Los_Angeles";
// 2026-10-28 at noon Pacific.
const now = new Date("2026-10-28T19:00:00Z");

test("a calendar section parses dates, ranges and one-off dated entries", () => {
  const entries = parseCalendar([
    "# a comment",
    "",
    "- 10-31: halloween; the one night the living dress like you",
    "* 12-24..01-01: the dead week",
    "11-04 2026: the midterm",
  ]);
  assert.deepEqual(entries, [
    { from: { month: 10, day: 31 }, to: null, year: null, text: "halloween; the one night the living dress like you" },
    { from: { month: 12, day: 24 }, to: { month: 1, day: 1 }, year: null, text: "the dead week" },
    { from: { month: 11, day: 4 }, to: null, year: 2026, text: "the midterm" },
  ]);
  assert.throws(() => parseCalendar(["halloween: 10-31"]), /is not "MM-DD: text"/);
  assert.throws(() => parseCalendar(["13-01: never"]), /impossible date/);
});

test("the notes are what is today, just past, or within the horizon, nearest first", () => {
  const entries = parseCalendar([
    "10-31: halloween",
    "10-28: a tuesday that matters",
    "10-27: yesterday's thing",
    "10-25: too long ago",
    "11-01..11-02: all saints and all souls",
    "11-05: too far",
    "12-24..01-01: the dead week",
    "11-04 2025: last year's midterm",
    "11-04 2026: this year's midterm",
  ]);
  const notes = calendarNotes(entries, now, TZ, { horizonDays: 7 });
  assert.deepEqual(
    notes.map((n) => [n.text, n.when]),
    [
      ["a tuesday that matters", "today"],
      ["yesterday's thing", "yesterday"],
      ["halloween", "in 3 days, Sat Oct 31"],
      ["all saints and all souls", "in 4 days, Sun Nov 1"],
      ["this year's midterm", "in 7 days, Wed Nov 4"],
    ]
  );
  assert.equal(calendarLine(entries, now, TZ), "a tuesday that matters (today); yesterday's thing (yesterday); halloween (in 3 days, Sat Oct 31); all saints and all souls (in 4 days, Sun Nov 1); this year's midterm (in 7 days, Wed Nov 4)");
  assert.equal(calendarLine([], now, TZ), null);
});

test("ranges read as ongoing, and cross the year end", () => {
  const entries = parseCalendar(["12-24..01-01: the dead week", "10-31: halloween"]);
  assert.equal(calendarLine(entries, new Date("2026-12-28T12:00:00Z"), TZ), "the dead week (now, until Fri Jan 1)");
  assert.equal(calendarLine(entries, new Date("2026-12-24T12:00:00Z"), TZ), "the dead week (starts today, until Fri Jan 1)");
  assert.equal(calendarLine(entries, new Date("2027-01-02T12:00:00Z"), TZ), "the dead week (yesterday)");
  assert.equal(calendarLine(entries, new Date("2026-11-01T12:00:00Z"), TZ), "halloween (yesterday)");
  assert.equal(calendarLine(entries, new Date("2026-11-03T12:00:00Z"), TZ), null);
  // tomorrow, in the bot's zone: 10-30 at 11 PM Pacific is still the 30th.
  assert.equal(calendarLine(entries, new Date("2026-10-31T06:00:00Z"), TZ), "halloween (tomorrow)");
});

test("a persona carries its calendar", () => {
  const persona = parsePersona("# Mabel\n\nYou are Mabel.\n\n## Calendar\n\n- 10-31: halloween\n");
  assert.equal(persona.calendar.length, 1);
  assert.equal(parsePersona("# Mabel\n\nYou are Mabel.\n").calendar.length, 0);
  assert.throws(() => parsePersona("# Mabel\n\nYou are Mabel.\n\n## Calendar\n\n- soon: a thing\n"), /Persona "Mabel": Calendar line/);
});
