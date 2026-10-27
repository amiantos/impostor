const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Presence } = require("../classes/presence");
const { parseSchedule, zonedDate } = require("../classes/schedule");

const TZ = "America/Chicago";
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const at = (h, m, day = 28) => zonedDate(TZ, 2026, 10, day, h, m); // Wed 2026-10-28

function build({ schedule = null, config = {}, start = at(9, 0), hooks = {} } = {}) {
  let now = start;
  const calls = { away: [], left: [], returned: [] };
  const presence = new Presence({
    logger: silent,
    schedule: schedule ? parseSchedule(schedule) : null,
    timezone: TZ,
    seed: "test",
    config: { afk_minutes: 15, linger_minutes: 15, ...config },
    clock: () => now,
    hooks: {
      setAway: (m) => calls.away.push(m),
      onLeave: async (occ) => { calls.left.push(occ.block.activity); if (hooks.onLeave) await hooks.onLeave(occ); },
      onReturn: (occ, pending) => calls.returned.push([occ.block.activity, [...pending.keys()]]),
      ...(hooks.setAway ? { setAway: hooks.setAway } : {}),
    },
  });
  const advanceTo = async (d) => { now = d; await presence.tick(); };
  return { presence, calls, advanceTo, clock: () => now };
}

test("afk after fifteen quiet minutes, cleared the moment the bot speaks", async () => {
  const { presence, calls, advanceTo } = build();
  await advanceTo(at(9, 0));
  assert.deepEqual(calls.away, []);
  await advanceTo(at(9, 14));
  assert.deepEqual(calls.away, []);
  await advanceTo(at(9, 15));
  assert.deepEqual(calls.away, ["afk since 2026-10-28 09:00:00-0500"]);
  assert.equal(presence.snapshot().state, "afk");
  assert.match(presence.describe(), /haven't typed anything for 15 minutes/);
  presence.noteSent();
  assert.deepEqual(calls.away, ["afk since 2026-10-28 09:00:00-0500", null]);
  assert.equal(presence.snapshot().state, "here");
  await advanceTo(at(9, 20));
  assert.equal(calls.away.length, 2, "the clock restarted from the message");
});

test("afk can be turned off", async () => {
  const { calls, advanceTo } = build({ config: { afk_minutes: 0 } });
  await advanceTo(at(12, 0));
  assert.deepEqual(calls.away, []);
});

test("an away block: goodbye hook, away status, nothing until it ends, then the return hook", async () => {
  const schedule = "away 10:00-11:00: in class | in class, back at 11";
  const { presence, calls, advanceTo } = build({ schedule, start: at(9, 50) });
  await advanceTo(at(9, 50));
  assert.equal(presence.gone, false);
  assert.match(presence.describe(), /Next up: in class, from about 10:00 AM/);

  await advanceTo(at(10, 0));
  assert.deepEqual(calls.left, ["in class"]);
  assert.equal(presence.gone, true);
  assert.deepEqual(calls.away, ["in class, back at 11"]);
  assert.deepEqual(presence.snapshot(), {
    state: "away",
    activity: "in class",
    away_message: "in class, back at 11",
    until: at(11, 0).toISOString(),
    next: { activity: "in class", at: at(10, 0, 29).toISOString() },
  });

  presence.notePending("#c", { addressed: true });
  presence.notePending("#c");
  presence.notePending("bob", { dm: true, addressed: true });
  await advanceTo(at(10, 30));
  assert.equal(presence.gone, true);
  assert.equal(calls.away.length, 1, "no afk while gone");

  await advanceTo(at(11, 0));
  assert.equal(presence.gone, false);
  assert.deepEqual(calls.away, ["in class, back at 11", null]);
  assert.deepEqual(calls.returned, [["in class", ["#c", "bob"]]]);
  assert.match(presence.describe(), /You just got back \(just now\): you were in class until 11:00 AM/);
  assert.equal(presence.pending.size, 0);

  await advanceTo(at(11, 14));
  assert.equal(calls.away.length, 2, "the afk clock restarted on return");
  await advanceTo(at(11, 15));
  assert.equal(calls.away.length, 3);
});

test("starting up inside a block means being gone without goodbyes", async () => {
  const { presence, calls, advanceTo } = build({ schedule: "away 10:00-11:00: in class", start: at(10, 30) });
  await advanceTo(at(10, 30));
  assert.equal(presence.gone, true);
  assert.deepEqual(calls.left, []);
  assert.deepEqual(calls.away, ["in class"]);
});

test("mid-conversation at the start of a block the bot lingers, but not past linger_minutes", async () => {
  const { presence, calls, advanceTo } = build({ schedule: "away 10:00-11:00: in class", start: at(9, 50) });
  await advanceTo(at(9, 50));
  presence.noteAddressed(at(9, 59));
  await advanceTo(at(10, 0));
  assert.equal(presence.gone, false, "someone was just talking to them");
  assert.match(presence.describe(), /meant to be in class already/);
  presence.noteSent(at(10, 5));
  await advanceTo(at(10, 6));
  assert.equal(presence.gone, false);
  await advanceTo(at(10, 10));
  assert.equal(presence.gone, true, "three quiet minutes and they go");
  assert.deepEqual(calls.left, ["in class"]);

  // A conversation that never pauses: linger_minutes caps the delay.
  const late = build({ schedule: "away 10:00-11:00: in class", start: at(9, 50) });
  await late.advanceTo(at(9, 50));
  for (let m = 0; m < 16; m++) {
    late.presence.noteAddressed(at(10, m));
    await late.advanceTo(at(10, m));
  }
  assert.equal(late.presence.gone, true);
});

test("the goodbye pass can take a while; ticks meanwhile do nothing", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { presence, calls, advanceTo, clock } = build({
    schedule: "away 10:00-11:00: in class",
    start: at(9, 50),
    hooks: { onLeave: () => gate },
  });
  await advanceTo(at(9, 50));
  const leaving = advanceTo(at(10, 0));
  await Promise.resolve();
  assert.equal(presence.leaving, true);
  await presence.tick(clock());
  assert.equal(calls.left.length, 1);
  release();
  await leaving;
  assert.equal(presence.gone, true);
});

test("a here block only changes the narrative", async () => {
  const { presence, calls, advanceTo } = build({ schedule: "here 03:00-04:00: mid-backup, sluggish", start: at(3, 30) });
  await advanceTo(at(3, 30));
  assert.equal(presence.gone, false);
  assert.deepEqual(calls.away, []);
  assert.equal(presence.snapshot().state, "here");
  assert.equal(presence.snapshot().activity, "mid-backup, sluggish");
  assert.match(presence.describe(), /You're mid-backup, sluggish \(since 3:00 AM, until about 4:00 AM\)/);
  await advanceTo(at(4, 30));
  assert.match(presence.describe(), /Earlier: you were mid-backup, sluggish until 4:00 AM \(30 minutes ago\)/);
  assert.doesNotMatch(presence.describe(), /Next up/);
});

test("describe is null with nothing to say, and the leaving note replaces the current block", async () => {
  const { presence, advanceTo, clock } = build({ schedule: "away 10:00-11:00: in class", start: at(15, 0) });
  await advanceTo(at(15, 0));
  assert.equal(presence.describe(), null, "class ended four hours ago, nothing tonight");
  const occurrence = presence.scheduled(at(10, 30)).current;
  assert.match(presence.describe(clock(), { leaving: occurrence }), /^You're about to go: in class, until about 11:00 AM\.$/);
});

test("reconnecting puts the current status back", async () => {
  const { presence, calls, advanceTo } = build({ schedule: "away 10:00-11:00: in class", start: at(10, 30) });
  await advanceTo(at(10, 30));
  assert.deepEqual(calls.away, ["in class"]);
  presence.reconnected();
  assert.deepEqual(calls.away, ["in class", "in class"]);
});

test("disabled presence never touches the away status", async () => {
  const { presence, calls, advanceTo } = build({ schedule: "away 10:00-11:00: in class", start: at(10, 30), config: { enabled: false } });
  await advanceTo(at(10, 30));
  assert.equal(presence.gone, false);
  assert.deepEqual(calls.away, []);
  presence.start();
  assert.equal(presence.interval, null);
});
