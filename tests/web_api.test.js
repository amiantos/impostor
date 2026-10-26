const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const ImpostorClient = require("../classes/impostor_client");
const WebServer = require("../web/server");
const { resolveBotConfig } = require("../classes/bot_config");

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };
const shared = {
  generator: { deepseek: { api_key: "k", model: "m", temperature: 0.9, max_tokens: 500 } },
  irc: { host: "localhost", port: 6697, tls: true },
  autonomous: { enabled: true },
  web: { enabled: true, port: 0 },
};
const tools = { pythonTool: {}, webSearchTool: {}, webFetchTool: {} };
const openai = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"journal": "from a pass", "people": {"amiantos": "note from a pass"}}' } }] }) } } };

let dataDir, server, base, isaac, mabel;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "impostor-web-"));
  isaac = new ImpostorClient(silent, resolveBotConfig(shared, { id: "isaac", nick: "Isaac", persona: "p" }), {
    openai, tools, dataDir, persona: { name: "Isaac", character: "c", evaluator: "e" },
  });
  mabel = new ImpostorClient(silent, resolveBotConfig(shared, { id: "mabel", nick: "Mabel", persona: "p" }), {
    openai, tools, dataDir, persona: { name: "Mabel", character: "c", evaluator: "e" },
  });
  server = new WebServer(silent, shared, new Map([["isaac", isaac], ["mabel", mabel]]));
  const listening = server.start();
  await new Promise((r) => listening.once("listening", r));
  base = `http://127.0.0.1:${listening.address().port}`;
});

after(() => {
  server.stop();
  isaac.shutdown();
  mabel.shutdown();
});

async function api(pathname, options) {
  const res = await fetch(base + pathname, options);
  return { status: res.status, body: await res.json() };
}

test("each bot has its own database directory", () => {
  assert.ok(fs.existsSync(path.join(dataDir, "isaac", "impostor.db")));
  assert.ok(fs.existsSync(path.join(dataDir, "mabel", "impostor.db")));
});

test("/api/bots lists every bot", async () => {
  const { status, body } = await api("/api/bots");
  assert.equal(status, 200);
  assert.deepEqual(body.map((b) => [b.id, b.nick, b.name, b.connected]), [
    ["isaac", "Isaac", "Isaac", false],
    ["mabel", "Mabel", "Mabel", false],
  ]);
});

test("?bot= picks the database; the first bot is the default; unknown is 404", async () => {
  mabel.getDatabase().setJournal("#lurker", "mabel's journal");
  assert.deepEqual((await api("/api/journals")).body, []);
  const { body } = await api("/api/journals?bot=mabel");
  assert.equal(body.length, 1);
  assert.equal(body[0].content, "mabel's journal");
  assert.equal(body[0].version_count, 1);
  assert.equal((await api("/api/journals?bot=nobody")).status, 404);
});

test("a journal can be read with its history, edited, and forgotten", async () => {
  isaac.getDatabase().setJournal("#c", "v1", { rationale: "first" });
  const id = encodeURIComponent("#c");
  let { body } = await api(`/api/journals/${id}?bot=isaac`);
  assert.equal(body.journal.content, "v1");
  assert.equal(body.unread, 0);
  assert.equal(body.versions[0].rationale, "first");

  ({ body } = await api(`/api/journals/${id}?bot=isaac`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: " v2 " }),
  }));
  assert.equal(body.journal.content, "v2");
  ({ body } = await api(`/api/journals/${id}?bot=isaac`));
  assert.deepEqual(body.versions.map((v) => [v.content, v.source]), [["v2", "edit"], ["v1", "archivist"]]);

  assert.equal((await api(`/api/journals/${id}?bot=isaac`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
  assert.equal((await api(`/api/journals/${id}?bot=isaac`, { method: "DELETE" })).status, 200);
  assert.equal((await api(`/api/journals/${id}?bot=isaac`)).status, 404);
  assert.equal((await api(`/api/journals/${id}?bot=isaac`, { method: "DELETE" })).status, 404);
});

test("a pass can be run from the dashboard", async () => {
  const db = isaac.getDatabase();
  db.insertMessageEnhanced({ id: "m1", channelId: "#run", authorId: "amiantos", authorName: "amiantos", content: "hi", createdAt: new Date().toISOString() });
  const { status, body } = await api(`/api/journals/${encodeURIComponent("#run")}/run?bot=isaac`, { method: "POST" });
  assert.equal(status, 200);
  assert.equal(body.passes, 1);
  assert.equal(body.journal.content, "from a pass");
  assert.equal(db.getPerson("amiantos").content, "note from a pass");
});

test("people notes can be listed, read, edited and forgotten, case-insensitively", async () => {
  isaac.getDatabase().setPerson("Bob", "a bob");
  let { body } = await api("/api/people?bot=isaac");
  assert.ok(body.some((p) => p.nick === "Bob"));
  ({ body } = await api("/api/people/bob?bot=isaac"));
  assert.equal(body.person.content, "a bob");
  ({ body } = await api("/api/people/BOB?bot=isaac", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "a better bob" }),
  }));
  assert.equal(body.person.nick, "Bob", "the display nick is kept");
  assert.equal(body.person.content, "a better bob");
  assert.equal((await api("/api/people/bob?bot=isaac", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: " " }) })).status, 400);
  assert.equal((await api("/api/people/bob?bot=isaac", { method: "DELETE" })).status, 200);
  assert.equal((await api("/api/people/bob?bot=isaac")).status, 404);
});

test("the reply prompt carries the journal and the notes of people in the window", () => {
  const db = isaac.getDatabase();
  db.setJournal("#p", "we talked about tabs");
  db.setPerson("amiantos", "my creator");
  db.setPerson("stranger", "never here");
  db.insertMessageEnhanced({ id: "p1", channelId: "#p", authorId: "amiantos", authorName: "amiantos", content: "isaac: hi", createdAt: new Date().toISOString() });
  const { memory, dbMessages } = isaac.buildContextFromDatabase("#p");
  assert.equal(memory.journal, "we talked about tabs");
  assert.deepEqual([...memory.people], [["amiantos", "my creator"]]);
  const [prompt] = isaac.contextUtils.buildChatMessagesConsolidated(dbMessages, "isaac", { userName: "amiantos", channelName: "#p" }, null, memory);
  assert.match(prompt.content, /YOUR JOURNAL FOR #P ---\nwe talked about tabs/);
  assert.match(prompt.content, /--- PEOPLE ---\namiantos: my creator\n/);
});

test("the remember tool is gone", async () => {
  const result = await isaac.executeTool({ tool_name: "remember", username: "x", category: "fact", content: "c", reason: "r" });
  assert.equal(result.success, false);
  assert.match(result.error, /Unknown tool: remember/);
});

test("a journal seeded by hand starts its watermark at the newest line", async () => {
  const db = isaac.getDatabase();
  for (let i = 0; i < 3; i++) db.insertMessageEnhanced({ id: `s${i}`, channelId: "#seed", authorId: "a", authorName: "a", content: "old", createdAt: new Date().toISOString() });
  const { body } = await api(`/api/journals/${encodeURIComponent("#seed")}?bot=isaac`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "as of now" }),
  });
  assert.equal(body.journal.watermark_rowid, db.getLastMessageRowid("#seed"));
  assert.equal(isaac.archivist.unreadCount("#seed"), 0);
});

test("?bot= is case-insensitive", async () => {
  assert.equal((await api("/api/journals?bot=ISAAC")).status, 200);
});
