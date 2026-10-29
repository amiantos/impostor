const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Roster } = require("../classes/roster");

const now = new Date("2026-10-28T06:30:00Z"); // 01:30 Chicago (-0500)
const make = () => new Roster({ selfNick: "layla", bridgeNick: "snitch", clock: () => now });

test("tracks membership through names, join, part, kick, quit and nick changes", () => {
  const r = make();
  r.setUserlist("#c", [{ nick: "amiantos" }, { nick: "Isaac" }, { nick: "layla" }, { nick: "snitch" }]);
  assert.deepEqual(r.others("#c"), ["amiantos", "Isaac"]);
  r.join("bob", "#C");
  r.leave("Isaac", "#c");
  assert.deepEqual(r.others("#c"), ["amiantos", "bob"]);
  r.rename("bob", "robert");
  assert.deepEqual(r.others("#c"), ["amiantos", "robert"]);
  r.quit("robert");
  assert.deepEqual(r.others("#c"), ["amiantos"]);
  r.forget("#c");
  assert.deepEqual(r.others("#c"), []);
  assert.equal(r.describe("#c"), null);
});

test("away-notify sets and clears away with the message; WHO only sets the flag", () => {
  const r = make();
  r.setUserlist("#c", ["amiantos", "isaac", "nightmare"]);
  r.setWho([{ nick: "isaac", away: true }, { nick: "amiantos", away: false }]);
  assert.equal(r.isAway("isaac"), true);
  assert.equal(r.awayOf("isaac").message, null);
  r.setAway("nightmare", "grazing. it is what there is.");
  r.setAway("isaac", "afk since 2026-10-28 01:07:00-0500");
  assert.equal(
    r.describe("#c"),
    "In #c right now: amiantos, isaac (afk for 23 minutes), nightmare (away: grazing. it is what there is.)."
  );
  r.setWho([{ nick: "isaac", away: true }]);
  assert.equal(r.awayOf("isaac").message, "afk since 2026-10-28 01:07:00-0500", "WHO keeps a known message");
  r.setBack("isaac");
  r.setWho([{ nick: "nightmare", away: false }]);
  assert.equal(r.describe("#c"), "In #c right now: amiantos, isaac, nightmare.");
  assert.deepEqual(r.present("#c"), ["amiantos", "isaac", "nightmare"]);
});

test("someone who just arrived is marked for a few minutes", () => {
  const r = make();
  r.setUserlist("#c", ["amiantos", "isaac"]);
  assert.equal(r.describe("#c"), "In #c right now: amiantos, isaac.", "the people who were here when the bot came are not arrivals");
  r.join("bob", "#c", new Date(now.getTime() - 30 * 1000));
  r.join("carol", "#c", new Date(now.getTime() - 6 * 60 * 1000));
  r.join("dave", "#c", new Date(now.getTime() - 15 * 60 * 1000));
  assert.equal(r.describe("#c"), "In #c right now: amiantos, isaac, bob (just joined), carol (joined 6 minutes ago), dave.");
  r.setAway("bob", "afk since 2026-10-28 01:29:00-0500");
  assert.equal(r.describe("#c"), "In #c right now: amiantos, isaac, bob (afk for 1 minute, just joined), carol (joined 6 minutes ago), dave.");
  r.rename("carol", "caroline");
  assert.match(r.describe("#c"), /caroline \(joined 6 minutes ago\)/);
  r.leave("caroline", "#c");
  r.join("caroline", "#c", new Date(now.getTime() - 20 * 60 * 1000));
  assert.doesNotMatch(r.describe("#c"), /caroline \(/, "a leave forgets the arrival");
  r.setUserlist("#c", ["amiantos", "bob"]);
  assert.equal(r.describe("#c"), "In #c right now: amiantos, bob (afk for 1 minute, just joined).", "a fresh NAMES keeps known arrivals");
});

test("says when everyone is away, and describes a DM partner only when they are away", () => {
  const r = make();
  r.setUserlist("#c", ["amiantos", "isaac"]);
  r.setAway("amiantos", "zzz");
  r.setAway("isaac", "afk since 2026-10-27 23:30:00-0500");
  assert.equal(r.describe("#c"), "In #c right now: amiantos (away: zzz), isaac (afk for 2 hours). Everyone else is away right now.");
  assert.deepEqual(r.present("#c"), []);
  assert.equal(r.describe("amiantos"), "amiantos is away: zzz, so they may not see this until they're back.");
  assert.equal(r.describe("nobody"), null);
});

test("leaving the last shared channel forgets the away state; a repeated AWAY keeps its start", () => {
  const r = make();
  r.setUserlist("#c", ["bob"]);
  r.setUserlist("#d", ["bob"]);
  r.setAway("bob", "brb", new Date(now.getTime() - 60000));
  r.setAway("bob", "brb", now);
  assert.equal(r.awayOf("bob").since.getTime(), now.getTime() - 60000);
  r.leave("bob", "#c");
  assert.equal(r.isAway("bob"), true);
  r.leave("bob", "#d");
  assert.equal(r.isAway("bob"), false);
});

test("typing: who is mid-line right now", () => {
  const r = make();
  r.noteTyping("#c", "amiantos", "active", new Date(now.getTime() - 5000));
  assert.equal(r.someoneTyping("#c"), "amiantos");
  assert.equal(r.someoneTyping("#c", 3), null);
  r.noteTyping("#c", "amiantos", "done");
  assert.equal(r.someoneTyping("#c"), null);
  r.noteTyping("#c", "bob", "active", now);
  r.noteTyping("#c", "amiantos", "done");
  assert.equal(r.someoneTyping("#c"), "bob", "someone else's done doesn't clear bob");
});
