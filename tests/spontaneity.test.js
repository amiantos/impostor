const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Spontaneity, SilenceDirector, NewsDesk, seedsForDay } = require("../classes/spontaneity");

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const T0 = new Date("2026-10-28T15:00:00Z");
const min = (n) => new Date(T0.getTime() + n * 60000);

/** A stand-in for an ImpostorClient as the director sees it. */
function participant(id, { config = {}, channels = ["#c"], facts = {}, random = () => 0 } = {}) {
  const bot = {
    id,
    channels,
    facts: { inChannel: true, lastLineAt: T0, present: 2, typing: null, gone: false, busy: false, ...facts },
    offers: [],
    spontaneity: new Spontaneity({ logger: silent, botId: id, config, clock: () => T0, random }),
    silenceFacts(channel) {
      return channels.some((c) => c.toLowerCase() === channel.toLowerCase()) ? this.facts : { inChannel: false };
    },
    takeSpontaneousTurn(channel, offer) {
      this.offers.push({ channel, ...offer });
    },
  };
  return bot;
}

function director({ config = {}, random = () => 0, bots = [] } = {}) {
  // random 0 => every draw is the minimum: thresholds of quiet_min_minutes, the first candidate wins.
  const d = new SilenceDirector({ logger: silent, config: { quiet_min_minutes: 20, quiet_max_minutes: 40, channel_gap_minutes: 30, ...config }, clock: () => T0, random });
  for (const b of bots) d.register(b);
  return d;
}

test("waits out the drawn quiet threshold, measured from the last line or the last attempt", () => {
  const layla = participant("layla");
  const d = director({ bots: [layla] });
  assert.equal(d.consider("#c", min(10)).picked, null);
  assert.match(d.consider("#c", min(10)).reason, /quiet 10 of 20 min/);
  assert.deepEqual(d.consider("#c", min(20)), { picked: "layla", reason: "quiet 20 min" });
  assert.deepEqual(layla.offers, [{ channel: "#c", quietMinutes: 20, nudged: false }]);
  assert.match(d.consider("#c", min(21)).reason, /layla is on it/);
  d.release("#c", "layla", false, min(21));
  assert.equal(d.consider("#c", min(30)).picked, null, "a silent attempt restarts the clock");
  assert.equal(d.consider("#c", min(41)).picked, "layla");
});

test("the channel's threshold is drawn between min and max, fresh after each attempt", () => {
  let r = 0.5;
  const d = director({ random: () => r });
  assert.equal(d.state("#c").threshold, 30);
  r = 1;
  d.release("#c", "x", false, T0);
  assert.equal(d.state("#c").threshold, 40);
});

test("nobody here, someone typing, the bot away or busy: no", () => {
  const bot = participant("layla");
  const d = director({ bots: [bot] });
  bot.facts.present = 0;
  assert.equal(d.consider("#c", min(25)).reason, "nobody here");
  bot.facts.present = 1;
  bot.facts.typing = "amiantos";
  assert.equal(d.consider("#c", min(25)).reason, "amiantos is typing");
  bot.facts.typing = null;
  bot.facts.gone = true;
  assert.equal(d.consider("#c", min(25)).reason, "nobody free (layla: away)");
  bot.facts.gone = false;
  bot.facts.busy = true;
  assert.equal(d.consider("#c", min(25)).reason, "nobody free (layla: busy)");
  bot.facts.busy = false;
  bot.facts.lastLineAt = null;
  assert.equal(d.consider("#c", min(25)).picked, "layla", "no lines ever: quiet since start");
  assert.equal(director().consider("#c", min(25)).reason, "no bot here");
});

test("each bot has its own daily cap and minimum gap", () => {
  const bot = participant("layla", { config: { max_per_day: 2, min_gap_minutes: 60 }, channels: ["#c", "#d"] });
  const d = director({ bots: [bot], config: { channel_gap_minutes: 1 } });
  assert.equal(d.consider("#c", min(20)).picked, "layla");
  bot.spontaneity.spoke(min(20));
  d.release("#c", "layla", true, min(20));
  assert.match(d.consider("#d", min(50)).reason, /layla: spoke unprompted 30 min ago/);
  assert.equal(d.consider("#d", min(90)).picked, "layla");
  bot.spontaneity.spoke(min(90));
  d.release("#d", "layla", true, min(90));
  assert.match(d.consider("#c", min(400)).reason, /layla: 2 already today/);
  assert.deepEqual(bot.spontaneity.snapshot(min(400)), { enabled: true, weight: 1, spoken_today: 2, max_per_day: 2, last_spoke_at: min(90).toISOString() });
  assert.equal(d.consider("#c", min(24 * 60 + 25)).picked, "layla", "the day rolls");
});

test("one bot at a time gets a channel, and after it speaks the channel is closed to all of them", () => {
  let r = 0;
  const layla = participant("layla", { config: { min_gap_minutes: 10 } });
  const isaac = participant("isaac", { config: { min_gap_minutes: 10 }, channels: ["#c", "#d"] });
  const d = director({ bots: [layla, isaac], random: () => r });
  assert.equal(d.consider("#c", min(20)).picked, "layla");
  assert.match(d.consider("#c", min(20)).reason, /layla is on it/);
  assert.equal(d.consider("#d", min(20)).picked, "isaac", "another channel is fine");
  layla.spontaneity.spoke(min(21));
  d.release("#c", "layla", true, min(21));
  assert.match(d.consider("#c", min(45)).reason, /layla spoke unprompted 24 min ago/);
  // After the gap the other bot is favoured: the last filler's weight is cut
  // (to 0.3, then halved for having spoken today) so a middling draw goes to isaac.
  d.release("#d", "isaac", false, min(21));
  r = 0.5;
  const pick = d.consider("#c", min(52));
  assert.equal(pick.picked, "isaac");
  // An offer that is never used releases the channel without closing it.
  d.abandon("#c", "isaac");
  assert.equal(d.consider("#c", min(53)).picked, "isaac");
});

test("the draw is weighted: a heavier bot wins more often, and a bot that spoke today less", () => {
  const counts = { layla: 0, isaac: 0 };
  let r = 0;
  const layla = participant("layla", { config: { weight: 3, min_gap_minutes: 0 } });
  const isaac = participant("isaac", { config: { weight: 1, min_gap_minutes: 0 } });
  const d = director({ bots: [layla, isaac], random: () => r });
  for (let i = 0; i < 100; i++) {
    r = (i + 0.5) / 100;
    d.state("#c").threshold = 0;
    const pick = d.consider("#c", min(30)).picked;
    counts[pick]++;
    d.abandon("#c", pick);
  }
  assert.deepEqual(counts, { layla: 75, isaac: 25 });
  // Layla has spoken three times today: her weight is quartered, so now it's even.
  for (let i = 0; i < 3; i++) layla.spontaneity.spoke(min(29));
  counts.layla = counts.isaac = 0;
  for (let i = 0; i < 100; i++) {
    r = (i + 0.5) / 100;
    d.state("#c").threshold = 0;
    const pick = d.consider("#c", min(30)).picked;
    counts[pick]++;
    d.abandon("#c", pick);
  }
  assert.deepEqual(counts, { layla: 43, isaac: 57 });
  const zero = participant("mute", { config: { weight: 0 } });
  assert.match(director({ bots: [zero] }).consider("#c", min(30)).reason, /no weight/);
});

test("tick looks at every channel any bot is in, once", () => {
  const layla = participant("layla", { channels: ["#c"] });
  const isaac = participant("isaac", { channels: ["#C", "#d"] });
  const d = director({ bots: [layla, isaac] });
  const results = d.tick(min(25));
  assert.deepEqual([...results.keys()], ["#c", "#d"]);
  assert.equal(results.get("#c").picked, "layla");
  assert.equal(results.get("#d").picked, "isaac");
  assert.equal(d.snapshot(min(25))["#c"].claimed_by, "layla");
  d.unregister(layla);
  assert.equal(d.snapshot(min(25))["#c"].claimed_by, null);
});

test("a nudge after coming back is one look, soon, with a short quiet threshold, for that bot only", () => {
  const cfg = { return_delay_min_minutes: 2, return_delay_max_minutes: 5, return_quiet_minutes: 5 };
  const layla = participant("layla", { config: cfg });
  const isaac = participant("isaac");
  const d = director({ bots: [layla, isaac] });
  layla.spontaneity.nudge("#c", T0);
  assert.equal(d.consider("#c", min(1)).picked, null, "not due yet");
  assert.deepEqual(layla.spontaneity.nudgeFor("#c", min(1)), { due: false, quietMinutes: 5 });
  layla.facts.lastLineAt = min(0);
  assert.match(d.consider("#c", min(2)).reason, /quiet 2 of 20 min/);
  assert.equal(layla.spontaneity.nudgeFor("#c", min(2)), null, "the nudge is spent once it's due and checked");

  layla.spontaneity.nudge("#c", T0);
  layla.facts.lastLineAt = null;
  isaac.facts.lastLineAt = null;
  const pick = d.consider("#c", min(6));
  assert.equal(pick.picked, "layla", "six quiet minutes since start, nudge due: the returning bot, not the heavier draw");
  assert.deepEqual(layla.offers.at(-1), { channel: "#c", quietMinutes: 6, nudged: true });
  d.release("#c", "layla", false, min(6));
  assert.match(d.consider("#c", min(10)).reason, /quiet 4 of 20 min/, "back to the channel's threshold");

  // A pending nudge keeps that bot out of the ordinary draw.
  layla.spontaneity.nudge("#c", min(30));
  assert.equal(d.consider("#c", min(31)).picked, "isaac");
});

test("disabled bots are never picked", () => {
  const bot = participant("layla", { config: { enabled: false } });
  assert.equal(director({ bots: [bot] }).consider("#c", min(500)).reason, "nobody free (layla: disabled)");
});

test("seedsForDay is the same few all day and different the next", () => {
  const seeds = ["a", "b", "c", "d", "e", "f"];
  const today = seedsForDay(seeds, "layla|2026-10-28", 2);
  assert.equal(today.length, 2);
  assert.deepEqual(seedsForDay(seeds, "layla|2026-10-28", 2), today);
  assert.notDeepEqual(seedsForDay(seeds, "layla|2026-10-29", 2), today);
  assert.deepEqual(seedsForDay([], "x", 2), []);
  assert.deepEqual(seedsForDay(seeds, "x", 0), []);
});

test("the news desk caches an answer per query and forgets failures", async () => {
  const calls = [];
  const search = {
    async searchWeb(q) {
      calls.push(q);
      if (q === "nothing") return { success: false, output: "", error: "no" };
      return { success: true, output: JSON.stringify({ query: q, answer: "  Some   news. ".repeat(60), references: [] }) };
    },
  };
  let now = T0;
  const desk = new NewsDesk({ search, ttlMinutes: 60, maxChars: 50, clock: () => now });
  const a = await desk.lookup("celebrity gossip this week");
  assert.equal(a.query, "celebrity gossip this week");
  assert.ok(a.answer.length <= 50 && a.answer.endsWith("…"), a.answer);
  await desk.lookup("Celebrity gossip this week ");
  assert.equal(calls.length, 1, "served from cache, case and spaces aside");
  now = min(61);
  await desk.lookup("celebrity gossip this week");
  assert.equal(calls.length, 2, "refetched after the ttl");
  assert.equal(await desk.lookup("nothing"), null);
  await desk.lookup("nothing");
  assert.equal(calls.filter((q) => q === "nothing").length, 2, "a failure is not cached");
  assert.equal(await new NewsDesk({ search: {} }).lookup("x"), null);
});
