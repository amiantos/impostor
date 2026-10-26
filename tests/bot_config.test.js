const { test } = require("node:test");
const assert = require("node:assert/strict");
const { listBots, resolveBotConfig } = require("../classes/bot_config");

const shared = {
  generator: { deepseek: { api_key: "k", model: "deepseek-flash", temperature: 0.9 } },
  irc: { host: "irc.lurker.chat", port: 6697, tls: true, bridge_nick: "EyeBridge", max_line_length: 340 },
  autonomous: { enabled: true, cooldown_seconds: 45, debounce_seconds: 20 },
  url_summarize: { enabled: true },
  journal: { messages_per_pass: 40 },
  kagi: { api_key: "kagi" },
  web: { enabled: true, port: 3000 },
};

test("a bot inherits every shared section and overrides key by key", () => {
  const cfg = resolveBotConfig(shared, {
    id: "isaac",
    nick: "Isaac",
    persona: "conf/personas/isaac.md",
    channels: ["#lurker"],
    account: { password: "pw" },
    generator: { temperature: 0.5 },
    autonomous: { cooldown_seconds: 90 },
    journal: { quiet_minutes: 5 },
  });
  assert.equal(cfg.irc.host, "irc.lurker.chat");
  assert.equal(cfg.irc.nick, "Isaac");
  assert.equal(cfg.irc.username, "isaac");
  assert.equal(cfg.irc.realname, "Isaac");
  assert.deepEqual(cfg.irc.channels, ["#lurker"]);
  assert.equal(cfg.irc.sasl, true);
  assert.equal(cfg.irc.account, "Isaac");
  assert.equal(cfg.irc.password, "pw");
  assert.equal(cfg.generator.deepseek.model, "deepseek-flash");
  assert.equal(cfg.generator.deepseek.temperature, 0.5);
  assert.equal(cfg.autonomous.cooldown_seconds, 90);
  assert.equal(cfg.autonomous.debounce_seconds, 20);
  assert.deepEqual(cfg.journal, { messages_per_pass: 40, quiet_minutes: 5 });
  assert.equal(cfg.kagi.api_key, "kagi");
  assert.deepEqual(cfg.bot, { id: "isaac", persona: "conf/personas/isaac.md" });
  assert.equal(cfg.bots, undefined);
  // The shared config is not mutated.
  assert.equal(shared.generator.deepseek.temperature, 0.9);
});

test("a bot without an account connects without SASL", () => {
  const cfg = resolveBotConfig(shared, { id: "b", nick: "Bob", persona: "p.md" });
  assert.equal(cfg.irc.sasl, false);
  assert.equal(cfg.irc.password, undefined);
  assert.deepEqual(cfg.irc.channels, []);
  assert.deepEqual(cfg.irc.pm_allowed_users, []);
});

test("the account name may differ from the nick", () => {
  const cfg = resolveBotConfig(shared, {
    id: "b",
    nick: "Bob",
    persona: "p.md",
    account: { name: "bob_acct", password: "pw" },
  });
  assert.equal(cfg.irc.account, "bob_acct");
});

test("listBots rejects a missing list, missing fields, and duplicates", () => {
  assert.throws(() => listBots({}), /non-empty list/);
  assert.throws(() => listBots({ bots: [{ id: "a", nick: "A" }] }), /"persona"/);
  assert.throws(() => listBots({ bots: [{ id: "a b", nick: "A", persona: "p" }] }), /names a directory/);
  assert.throws(
    () => listBots({ bots: [{ id: "a", nick: "A", persona: "p" }, { id: "A", nick: "B", persona: "p" }] }),
    /share the id/
  );
  assert.throws(
    () => listBots({ bots: [{ id: "a", nick: "Same", persona: "p" }, { id: "b", nick: "same", persona: "p" }] }),
    /share the nick/
  );
  const bots = listBots({ bots: [{ id: "a", nick: "A", persona: "p" }] });
  assert.equal(bots.length, 1);
});

test("channels and pm_allowed_users must be lists of strings, and ids are lowercased", () => {
  assert.throws(() => listBots({ bots: [{ id: "a", nick: "A", persona: "p", channels: "#lurker" }] }), /"channels" must be a list/);
  assert.throws(() => listBots({ bots: [{ id: "a", nick: "A", persona: "p", pm_allowed_users: "brad" }] }), /"pm_allowed_users" must be a list/);
  assert.throws(() => listBots({ bots: [{ id: "a", nick: "A", persona: "p", irc: { bridge_tags: "libera" } }] }), /"bridge_tags" must be a list/);
  const cfg = resolveBotConfig(shared, { id: "Isaac", nick: "Isaac", persona: "p.md" });
  assert.equal(cfg.bot.id, "isaac");
});
