const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const ImpostorClient = require("../classes/impostor_client");
const { resolveBotConfig } = require("../classes/bot_config");
const { parsePersona } = require("../classes/persona");

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };
const tools = { pythonTool: {}, webSearchTool: {}, webFetchTool: {} };
const openai = { chat: { completions: { create: async () => { throw new Error("no model calls here"); } } } };

let dataDir, bot;
const raws = [];
const stub = (isEnabled) => ({ raw: (...args) => raws.push(args), quit() {}, network: { cap: { isEnabled } } });
const metadata = () => raws.filter((r) => r[0] === "METADATA");

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "impostor-metadata-"));
  const persona = parsePersona("# Layla\n\nYou are Layla.\n");
  const config = resolveBotConfig(
    { generator: { deepseek: { api_key: "k", model: "m" } }, irc: { host: "localhost" }, journal: { enabled: false } },
    { id: "layla", nick: "layla", persona: "p", avatar_url: "https://x.test/layla.png", display_name: "Layla" }
  );
  bot = new ImpostorClient(silent, config, { openai, tools, dataDir, persona });
  bot.presence.stop();
});

after(() => bot.shutdown());

test("the cap is requested before connecting", () => {
  assert.ok(bot.ircClient.request_extra_caps.includes("draft/metadata-2"));
});

test("display-name and avatar are set once the cap is enabled", () => {
  raws.length = 0;
  bot.ircClient = stub((c) => c === "draft/metadata-2");
  bot.sendMetadata();
  assert.deepEqual(metadata(), [
    ["METADATA", "*", "SET", "display-name", "Layla"],
    ["METADATA", "*", "SET", "avatar", "https://x.test/layla.png"],
  ]);
});

test("nothing is sent without the cap", () => {
  raws.length = 0;
  bot.ircClient = stub(() => false);
  bot.sendMetadata();
  assert.deepEqual(metadata(), []);
});

test("without an avatar_url only the display name goes out", () => {
  raws.length = 0;
  bot.config.irc.avatar_url = null;
  bot.ircClient = stub(() => true);
  bot.sendMetadata();
  assert.deepEqual(metadata(), [["METADATA", "*", "SET", "display-name", "Layla"]]);
});

test("without a display_name no display-name is sent; the persona's name is not a fallback", () => {
  raws.length = 0;
  bot.config.irc.display_name = null;
  bot.config.irc.avatar_url = "https://x.test/layla.png";
  bot.ircClient = stub(() => true);
  bot.sendMetadata();
  assert.deepEqual(metadata(), [["METADATA", "*", "SET", "avatar", "https://x.test/layla.png"]]);
});
