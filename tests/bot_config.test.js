const { test } = require("node:test");
const assert = require("node:assert/strict");
const { listBots, resolveBotConfig } = require("../classes/bot_config");

const shared = {
  generator: { deepseek: { api_key: "k", model: "deepseek-flash", temperature: 0.9 } },
  irc: { host: "irc.lurker.chat", port: 6697, tls: true, bridge_nick: "EyeBridge", max_line_length: 340 },
  autonomous: { enabled: true, debounce_seconds: 20, max_wait_seconds: 60 },
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
    autonomous: { max_wait_seconds: 90 },
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
  assert.equal(cfg.autonomous.max_wait_seconds, 90);
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

test("a bot may not re-point the shared model client", () => {
  assert.throws(() => listBots({ bots: [{ id: "a", nick: "A", persona: "p", generator: { api_key: "x" } }] }), /generator.api_key is shared/);
  assert.throws(() => listBots({ bots: [{ id: "a", nick: "A", persona: "p", generator: { base_url: "x" } }] }), /generator.base_url is shared/);
});

test("keys with a top-level alias are refused under irc", () => {
  assert.throws(() => listBots({ bots: [{ id: "a", nick: "A", persona: "p", irc: { channels: ["#x"] } }] }), /irc.channels belongs at the bot's top level/);
  assert.throws(() => listBots({ bots: [{ id: "a", nick: "A", persona: "p", irc: { password: "x" } }] }), /irc.password belongs/);
});

test("timezone is shared with a per-bot override", () => {
  assert.equal(resolveBotConfig({ ...shared, timezone: "America/Los_Angeles" }, { id: "a", nick: "A", persona: "p" }).timezone, "America/Los_Angeles");
  assert.equal(resolveBotConfig({ ...shared, timezone: "America/Los_Angeles" }, { id: "a", nick: "A", persona: "p", timezone: "Europe/Berlin" }).timezone, "Europe/Berlin");
  assert.equal(resolveBotConfig(shared, { id: "a", nick: "A", persona: "p" }).timezone, undefined, "unset falls through to the ContextUtils default");
});

test("display_name is carried into irc and must be a non-empty string", () => {
  assert.equal(resolveBotConfig(shared, { id: "b", nick: "Bob", persona: "p.md", display_name: "Robert" }).irc.display_name, "Robert");
  assert.equal(resolveBotConfig(shared, { id: "b", nick: "Bob", persona: "p.md" }).irc.display_name, null);
  assert.throws(
    () => listBots({ bots: [{ id: "b", nick: "Bob", persona: "p.md", display_name: " " }] }),
    /display_name must be a non-empty string/
  );
});

test("avatar_url is carried into irc and must be an http(s) URL", () => {
  const cfg = resolveBotConfig(shared, { id: "b", nick: "Bob", persona: "p.md", avatar_url: "https://x.test/bob.png" });
  assert.equal(cfg.irc.avatar_url, "https://x.test/bob.png");
  assert.equal(resolveBotConfig(shared, { id: "b", nick: "Bob", persona: "p.md" }).irc.avatar_url, null);
  assert.throws(
    () => listBots({ bots: [{ id: "b", nick: "Bob", persona: "p.md", avatar_url: "bob.png" }] }),
    /avatar_url must be an http\(s\) URL/
  );
  assert.throws(
    () => listBots({ bots: [{ id: "b", nick: "Bob", persona: "p.md", irc: { avatar_url: "https://x.test/b.png" } }] }),
    /irc.avatar_url belongs at the bot's top level/
  );
});
