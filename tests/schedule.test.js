const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseSchedule, parseDays, presenceAt, zonedDate, formatStamp, formatClock, hash01 } = require("../classes/schedule");

const TZ = "America/Chicago";
const opts = { timezone: TZ, seed: "layla" };

test("parses a block per line: kind, days, times, jitter, activity, away message", () => {
  const schedule = parseSchedule(`
    # sleep
    away 00:30-08:30 ~45m: asleep | zzz
    away mon wed fri 10:00-11:20 ~10m: in class | in class, back after
    here weekends 11:00-13:00: in bed on your phone
    away tue-thu 13:00-14:30 ~1h: in a seminar
  `);
  assert.equal(schedule.blocks.length, 4);
  const [sleep, cls, bed, seminar] = schedule.blocks;
  assert.deepEqual([sleep.kind, sleep.days, sleep.start, sleep.end, sleep.jitter], ["away", [0, 1, 2, 3, 4, 5, 6], 30, 510, 45]);
  assert.equal(sleep.activity, "asleep");
  assert.equal(sleep.awayMessage, "zzz");
  assert.deepEqual(cls.days, [1, 3, 5]);
  assert.equal(cls.awayMessage, "in class, back after");
  assert.deepEqual([bed.kind, bed.days, bed.jitter], ["here", [0, 6], 0]);
  assert.equal(bed.awayMessage, "in bed on your phone", "the activity doubles as the away message");
  assert.deepEqual(seminar.days, [2, 3, 4]);
  assert.equal(seminar.jitter, 60);
});

test("an empty section is no schedule; a bad line names itself", () => {
  assert.equal(parseSchedule(""), null);
  assert.equal(parseSchedule("\n# nothing\n"), null);
  assert.throws(() => parseSchedule("away 25:00-08:00: asleep"), /line 1.*bad time/);
  assert.throws(() => parseSchedule("away 08:00-08:00: asleep"), /same time/);
  assert.throws(() => parseSchedule("gone 01:00-02:00: asleep"), /line 1 is not/);
  assert.throws(() => parseSchedule("away funday 01:00-02:00: asleep"), /unknown day "funday"/);
});

test("day words", () => {
  assert.deepEqual(parseDays(""), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseDays("daily"), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseDays("weekdays"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays("weekends"), [0, 6]);
  assert.deepEqual(parseDays("Monday, Wednesday"), [1, 3]);
  assert.deepEqual(parseDays("fri-mon"), [0, 1, 5, 6]);
});

test("zonedDate finds the instant for a wall-clock time, across DST", () => {
  // CDT (-5) in October, CST (-6) in December.
  assert.equal(zonedDate(TZ, 2026, 10, 28, 1, 0).toISOString(), "2026-10-28T06:00:00.000Z");
  assert.equal(zonedDate(TZ, 2026, 12, 1, 1, 0).toISOString(), "2026-12-01T07:00:00.000Z");
  assert.equal(formatStamp(new Date("2026-10-28T06:00:00Z"), TZ), "2026-10-28 01:00:00-0500");
  assert.equal(formatStamp(new Date("2026-12-01T07:00:00Z"), TZ), "2026-12-01 01:00:00-0600");
  assert.equal(formatClock(new Date("2026-10-28T06:00:00Z"), TZ), "1:00 AM");
});

test("the schedule says what is happening now, what just ended and what is next", () => {
  const schedule = parseSchedule(`
    away 00:30-08:30: asleep | zzz
    away mon wed fri 10:00-11:20: in class
    here daily 18:00-19:00: eating dinner
  `);
  // Wednesday 2026-10-28, 09:00 Chicago: up, class ahead.
  let p = presenceAt(schedule, zonedDate(TZ, 2026, 10, 28, 9, 0), opts);
  assert.equal(p.state, "here");
  assert.equal(p.current, null);
  assert.equal(p.previous.block.activity, "asleep");
  assert.equal(formatClock(p.previous.end, TZ), "8:30 AM");
  assert.equal(p.next.block.activity, "in class");

  // 10:30: in class.
  p = presenceAt(schedule, zonedDate(TZ, 2026, 10, 28, 10, 30), opts);
  assert.equal(p.state, "away");
  assert.equal(p.current.block.activity, "in class");
  assert.equal(p.next.block.activity, "eating dinner");

  // 18:30: dinner, still here.
  p = presenceAt(schedule, zonedDate(TZ, 2026, 10, 28, 18, 30), opts);
  assert.equal(p.state, "here");
  assert.equal(p.current.block.activity, "eating dinner");
  assert.equal(p.next.block.activity, "asleep", "tonight's sleep is next");
  assert.equal(formatClock(p.next.start, TZ), "12:30 AM");

  // Tuesday 10:30: no class.
  p = presenceAt(schedule, zonedDate(TZ, 2026, 10, 27, 10, 30), opts);
  assert.equal(p.state, "here");
  assert.equal(p.current, null);
});

test("a block that crosses midnight belongs to the day it starts on", () => {
  const schedule = parseSchedule("away weekdays 23:30-07:30: asleep");
  // Friday 23:45: asleep (Friday's block).
  assert.equal(presenceAt(schedule, zonedDate(TZ, 2026, 10, 30, 23, 45), opts).state, "away");
  // Saturday 03:00: still Friday's block.
  assert.equal(presenceAt(schedule, zonedDate(TZ, 2026, 10, 31, 3, 0), opts).state, "away");
  // Saturday 23:45: no block starts on Saturday.
  assert.equal(presenceAt(schedule, zonedDate(TZ, 2026, 10, 31, 23, 45), opts).state, "here");
  // Monday 03:00: Sunday night, no block.
  assert.equal(presenceAt(schedule, zonedDate(TZ, 2026, 11, 2, 3, 0), opts).state, "here");
  // Monday 23:45: back on.
  assert.equal(presenceAt(schedule, zonedDate(TZ, 2026, 11, 2, 23, 45), opts).state, "away");
});

test("jitter is bounded, stable for a day and seed, and differs between days", () => {
  const schedule = parseSchedule("away 00:30-08:30 ~45m: asleep");
  const starts = new Set();
  for (let day = 1; day <= 20; day++) {
    const now = zonedDate(TZ, 2026, 11, day, 3, 0);
    const a = presenceAt(schedule, now, opts);
    const b = presenceAt(schedule, new Date(now.getTime() + 60 * 60000), opts);
    assert.equal(a.current.start.getTime(), b.current.start.getTime(), "same all day");
    const nominal = zonedDate(TZ, 2026, 11, day, 0, 30).getTime();
    const shift = Math.abs(a.current.start.getTime() - nominal) / 60000;
    assert.ok(shift <= 45, `shift ${shift} within the jitter`);
    starts.add(shift * Math.sign(a.current.start.getTime() - nominal));
  }
  assert.ok(starts.size > 5, "bedtime moves from night to night");
  const other = presenceAt(schedule, zonedDate(TZ, 2026, 11, 1, 3, 0), { timezone: TZ, seed: "isaac" });
  const mine = presenceAt(schedule, zonedDate(TZ, 2026, 11, 1, 3, 0), opts);
  assert.notEqual(other.current.start.getTime(), mine.current.start.getTime(), "two bots don't share a bedtime");
});

test("away wins over here when blocks overlap; no schedule means always here", () => {
  const schedule = parseSchedule("here 00:00-23:59: around\naway 10:00-11:00: out");
  assert.equal(presenceAt(schedule, zonedDate(TZ, 2026, 10, 28, 10, 30), opts).state, "away");
  assert.equal(presenceAt(schedule, zonedDate(TZ, 2026, 10, 28, 12, 0), opts).current.block.activity, "around");
  assert.deepEqual(presenceAt(null, new Date(), opts), { state: "here", current: null, previous: null, next: null });
});

test("hash01 is stable and in [0, 1)", () => {
  assert.equal(hash01("abc"), hash01("abc"));
  assert.notEqual(hash01("abc"), hash01("abd"));
  for (const s of ["", "a", "layla|2026-11-01|0|start"]) {
    const h = hash01(s);
    assert.ok(h >= 0 && h < 1);
  }
});
