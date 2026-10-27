const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SilenceBroker, Spontaneity } = require("../classes/spontaneity");

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const T0 = new Date("2026-10-28T15:00:00Z");
const min = (n) => new Date(T0.getTime() + n * 60000);

function build({ config = {}, random = () => 0, broker = new SilenceBroker({ clock: () => T0 }), botId = "layla" } = {}) {
  // random 0 => every draw is the minimum: thresholds of quiet_min_minutes.
  return new Spontaneity({ logger: silent, botId, broker, config: { quiet_min_minutes: 20, quiet_max_minutes: 40, ...config }, clock: () => T0, random });
}
const quiet = (overrides = {}) => ({ lastLineAt: T0, present: 2, typing: null, gone: false, ...overrides });

test("waits out the drawn quiet threshold, measured from the last line or the last attempt", () => {
  const s = build();
  assert.equal(s.decide("#c", quiet(), min(10)).go, false);
  assert.match(s.decide("#c", quiet(), min(10)).reason, /quiet 10 of 20 min/);
  const go = s.decide("#c", quiet(), min(20));
  assert.deepEqual(go, { go: true, reason: "quiet 20 min", quietMinutes: 20 });
  s.finish("#c", false, min(20));
  assert.equal(s.decide("#c", quiet(), min(30)).go, false, "a silent attempt restarts the clock");
  assert.equal(s.decide("#c", quiet(), min(40)).go, true);
});

test("the threshold is drawn between min and max, fresh after each attempt", () => {
  let r = 0.5;
  const s = build({ random: () => r });
  assert.equal(s.state("#c").threshold, 30);
  r = 1;
  s.finish("#c", false, T0);
  assert.equal(s.state("#c").threshold, 40);
});

test("nobody here, someone typing, the bot away: no", () => {
  const s = build();
  assert.equal(s.decide("#c", quiet({ present: 0 }), min(25)).reason, "nobody here");
  assert.equal(s.decide("#c", quiet({ typing: "amiantos" }), min(25)).reason, "amiantos is typing");
  assert.equal(s.decide("#c", quiet({ gone: true }), min(25)).reason, "away");
  assert.equal(s.decide("#c", quiet({ lastLineAt: null }), min(25)).go, true, "no lines ever: quiet since start");
});

test("rate limits: a minimum gap between unprompted lines and a daily cap", () => {
  const s = build({ config: { max_per_day: 2, min_gap_minutes: 60 } });
  assert.equal(s.decide("#c", quiet(), min(20)).go, true);
  s.finish("#c", true, min(20));
  assert.match(s.decide("#d", quiet({ lastLineAt: null }), min(50)).reason, /spoke unprompted 30 min ago/);
  assert.equal(s.decide("#d", quiet({ lastLineAt: null }), min(90)).go, true);
  s.finish("#d", true, min(90));
  assert.equal(s.decide("#c", quiet({ lastLineAt: null }), min(400)).reason, "2 already today");
  assert.equal(s.decide("#c", quiet({ lastLineAt: null }), min(24 * 60 + 25)).go, true, "the day rolls");
});

test("the broker lets one bot at a time fill a channel and closes it afterwards", () => {
  const broker = new SilenceBroker({ channelGapMinutes: 30, clock: () => T0 });
  const layla = build({ broker, botId: "layla", config: { min_gap_minutes: 10 } });
  const isaac = build({ broker, botId: "isaac", config: { min_gap_minutes: 10 } });
  assert.equal(layla.decide("#c", quiet(), min(20)).go, true);
  assert.equal(isaac.decide("#c", quiet(), min(20)).reason, "layla is already on it");
  assert.equal(isaac.decide("#d", quiet(), min(20)).go, true, "another channel is fine");
  layla.finish("#c", true, min(21));
  assert.match(isaac.decide("#c", quiet(), min(45)).reason, /layla spoke unprompted 24 min ago/);
  assert.equal(isaac.decide("#c", quiet(), min(52)).go, true);
  // A claim that is never used is released without closing the channel.
  isaac.abandon("#c");
  assert.equal(layla.decide("#c", quiet(), min(60)).go, true);
});

test("a nudge after coming back tries once, soon, with a short quiet threshold", () => {
  const s = build({ config: { return_delay_min_minutes: 2, return_delay_max_minutes: 5, return_quiet_minutes: 5 } });
  s.nudge("#c", T0);
  assert.equal(s.decide("#c", quiet(), min(1)).reason, "nudge pending");
  assert.equal(s.decide("#c", quiet({ lastLineAt: min(0) }), min(2)).reason, "quiet 2 of 5 min");
  assert.equal(s.state("#c").nudge, null, "the nudge is spent once it's due and checked");
  const t = build({ config: { return_delay_min_minutes: 2, return_delay_max_minutes: 5, return_quiet_minutes: 5 } });
  t.nudge("#c", T0);
  assert.equal(t.decide("#c", quiet({ lastLineAt: null }), min(6)).go, true, "six quiet minutes since start, nudge due");
  t.finish("#c", false, min(6));
  assert.equal(t.decide("#c", quiet({ lastLineAt: null }), min(10)).go, false, "back to the normal threshold");
});

test("disabled never goes", () => {
  const s = build({ config: { enabled: false } });
  assert.equal(s.decide("#c", quiet({ lastLineAt: null }), min(500)).reason, "disabled");
});
