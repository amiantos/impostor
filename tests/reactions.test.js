const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const DatabaseManager = require("../classes/database");
const ImpostorClient = require("../classes/impostor_client");
const { Roster } = require("../classes/roster");
const { createIrcMessage } = require("../classes/irc_message");

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "impostor-test-"));
  const db = new DatabaseManager(silent, path.join(dir, "impostor.db"));
  db.initialize();
  return db;
}

let clock = Date.now() - 60 * 60 * 1000;
function store(db, nick, text, { channel = "#c", isBot = false, msgid = null, at = null, replyTo = null } = {}) {
  const message = createIrcMessage(nick, channel, text, { isBot });
  message.createdAt = new Date(at ?? (clock += 1000));
  if (replyTo) message.reference = { messageId: replyTo };
  db.insertMessageEnhanced({
    id: message.id,
    channelId: channel,
    authorId: message.author.id,
    authorName: nick,
    content: text,
    createdAt: message.createdAt,
    isBotMessage: isBot,
    replyToMessageId: replyTo,
  });
  if (msgid) db.addMsgid(message.id, msgid);
  return db.getMessage(message.id);
}

/** An ImpostorClient with only the parts these tests touch. */
function fakeBot(db, { config = {}, supports = true, echo = true, multiline = null } = {}) {
  const bot = Object.create(ImpostorClient.prototype);
  const sent = { tagmsgs: [], says: [], raws: [] };
  Object.assign(bot, {
    db,
    logger: silent,
    botNick: "mabel",
    watchword: "Mabel",
    pendingEchoes: new Map(),
    batchTags: new Map(),
    presence: { noteSent() {}, gone: false, noteAddressed() {}, describe() { return null; } },
    roster: new Roster({ selfNick: "mabel" }),
    config: { irc: { ...(config.irc || {}) }, autonomous: { ...(config.autonomous || {}) } },
    ircClient: {
      network: {
        supportsTag: () => supports,
        cap: {
          isEnabled: (cap) => (echo && cap === "echo-message") || (multiline !== null && cap === "draft/multiline"),
          available: new Map(multiline ? [["draft/multiline", multiline]] : []),
        },
      },
      tagmsg: (target, tags) => sent.tagmsgs.push({ target, tags }),
      say: (target, line, tags) => sent.says.push({ target, line, tags }),
      raw: (line) => sent.raws.push(line),
    },
  });
  return { bot, sent };
}

test("threading attaches msgids, reactions and the replied-to line", () => {
  const db = freshDb();
  const joke = store(db, "bob", "my landlord is a vampire", { msgid: "A1" });
  const answer = store(db, "mabel", "first half", { isBot: true, msgid: "B1" });
  db.addMsgid(answer.id, "B2"); // the second line of a split reply
  store(db, "alice", "wait what", { msgid: "C1", replyTo: answer.id });

  db.addReaction({ channelId: "#c", targetMsgid: "A1", authorId: "alice", authorName: "alice", reaction: "😂" });
  db.addReaction({ channelId: "#c", targetMsgid: "A1", authorId: "alice", authorName: "alice", reaction: "😂" });
  db.addReaction({ channelId: "#c", targetMsgid: "B2", authorId: "bob", authorName: "bob", reaction: "🖤" });

  const [j, a, w] = db.getRecentMessages("#c", 10, true);
  assert.equal(j.msgid, "A1");
  assert.deepEqual(j.reactions, [{ nick: "alice", reaction: "😂", is_bot: false }], "a repeated reaction is one");
  assert.equal(a.msgid, "B1", "the first line's msgid is the one to point at");
  assert.deepEqual(a.reactions.map((r) => r.reaction), ["🖤"], "a reaction to any line of a split reply counts");
  assert.equal(w.reply_to.author_name, "mabel");
  assert.equal(w.reply_to.is_bot_message, true);
  assert.equal(db.getMessageByMsgid("B2").id, answer.id);
  assert.equal(db.getMsgidFor(joke.id), "A1");

  db.removeReaction("A1", "alice", "😂");
  assert.deepEqual(db.getRecentMessages("#c", 10, true)[0].reactions, []);
});

test("echoes are matched back to the lines that were sent, in order", () => {
  const db = freshDb();
  const { bot } = fakeBot(db);
  const now = Date.now();
  bot.pendingEchoes.set("#c", [
    { messageId: "m-1", text: "a long line that the library split in two", sentAt: now },
    { messageId: "m-1", text: "second line", sentAt: now },
    { messageId: "m-2", text: "next message", sentAt: now },
  ]);
  const echo = (message, msgid) => bot.recordEcho({ target: "#C", message, tags: { msgid } });

  echo("a long line that the", "E1");
  echo("library split in two", "E2");
  echo("next message", "E3"); // "second line" was never echoed
  echo("something unrelated", "E4");

  assert.equal(db.getMsgidFor("m-1"), "E1");
  assert.equal(db.db.prepare("SELECT message_id FROM message_msgids WHERE msgid = 'E2'").get().message_id, "m-1");
  assert.equal(db.getMsgidFor("m-2"), "E3");
  assert.equal(db.db.prepare("SELECT 1 FROM message_msgids WHERE msgid = 'E4'").get(), undefined);
  assert.equal(bot.pendingEchoes.has("#c"), false);
});

test("sendIrcMessage tags only the first line as a reply and queues echoes", async () => {
  const db = freshDb();
  const { bot, sent } = fakeBot(db, { config: { irc: { max_line_length: 20 } } });
  await bot.sendIrcMessage("#c", "one two three four five six seven", { messageId: "m-1", replyToMsgid: "A1" });
  assert.ok(sent.says.length > 1);
  assert.deepEqual(sent.says[0].tags, { "+draft/reply": "A1" });
  assert.ok(sent.says.slice(1).every((s) => s.tags === undefined));
  assert.equal(bot.pendingEchoes.get("#c").length, sent.says.length);
});

test("a reply tag is only used on a line buried deep enough", () => {
  const db = freshDb();
  const { bot } = fakeBot(db, { config: { irc: { reply_min_distance: 5 } } });
  const old = store(db, "bob", "what was that film", { msgid: "OLD" });
  for (let i = 0; i < 4; i++) store(db, "alice", `chatter ${i}`);
  assert.equal(bot.replyTagFor("#c", old), null, "four lines after it is still recent");
  store(db, "alice", "chatter 4");
  assert.equal(bot.replyTagFor("#c", old), "OLD");

  const { bot: plain } = fakeBot(db, { supports: false });
  assert.equal(plain.replyTagFor("#c", old), null, "not on a server without the tag");
});

test("reactions go out as TAGMSGs, once per line, with a cooldown", () => {
  const db = freshDb();
  const { bot, sent } = fakeBot(db, { config: { autonomous: { react_cooldown_messages: 2, react_cooldown_seconds: 0 } } });
  const joke = store(db, "bob", "a joke", { msgid: "J1", at: Date.now() - 5000 });

  const first = bot.sendReaction("#c", joke, "  💀 ");
  assert.equal(first.sent, true);
  assert.deepEqual(sent.tagmsgs[0], { target: "#c", tags: { "+draft/reply": "J1", "+draft/react": "💀" } });
  assert.equal(db.hasBotReaction("J1"), true);

  const later = store(db, "alice", "another", { msgid: "J2", at: Date.now() + 1000 });
  assert.match(bot.sendReaction("#c", later, "😭").reason, /needs 2/);
  store(db, "carol", "and another", { at: Date.now() + 2000 });
  assert.equal(bot.reactionCooldown("#c").blocked, false);
  assert.match(bot.sendReaction("#c", joke, "😭").reason, /already reacted/);
  assert.equal(bot.sendReaction("#c", later, "😭").sent, true);

  const mine = store(db, "mabel", "my own line", { isBot: true, msgid: "M1" });
  assert.match(bot.sendReaction("#c", mine, "👍").reason, /his own line/);
  assert.match(bot.sendReaction("#c", later, "x".repeat(40)).reason, /unusable/);
  assert.equal(sent.tagmsgs.length, 2);
});

test("without server support or a msgid, a reaction is reported as unsupported", () => {
  const db = freshDb();
  const { bot } = fakeBot(db, { supports: false });
  const line = store(db, "bob", "hi", { msgid: "H1" });
  assert.equal(bot.sendReaction("#c", line, "👋").reason, "unsupported");
  const { bot: tagged } = fakeBot(db);
  assert.equal(tagged.sendReaction("#c", store(db, "bob", "no msgid"), "👋").reason, "unsupported");
  const { bot: off } = fakeBot(db, { config: { irc: { reactions: false } } });
  assert.equal(off.canSendReactions(), false);
});

test("incoming reactions are stored and removed, typing notifications ignored", () => {
  const db = freshDb();
  const { bot } = fakeBot(db);
  bot.isAllowedChannel = () => true;
  const line = store(db, "bob", "hi", { msgid: "H1" });
  const tagmsg = (nick, tags) => bot.handleTagmsg({ nick, ident: "u", hostname: "h", target: "#c", tags });

  tagmsg("alice", { "+draft/reply": "H1", "+draft/react": "👋" });
  tagmsg("alice", { "+typing": "active" });
  tagmsg("mabel", { "+draft/reply": "H1", "+draft/react": "🤖" });
  assert.deepEqual(db.attachThreading([db.getMessage(line.id)])[0].reactions, [{ nick: "alice", reaction: "👋", is_bot: false }]);

  tagmsg("alice", { "+draft/reply": "H1", "+draft/unreact": "👋" });
  assert.deepEqual(db.attachThreading([db.getMessage(line.id)])[0].reactions, []);
});

test("a reply to one of his lines is threaded onto it, so the evaluator sees who it answers", () => {
  const db = freshDb();
  const mine = store(db, "mabel", "tea is a soup", { isBot: true });
  store(db, "alice", "lunch plans");
  store(db, "bob", "pizza", {});
  store(db, "carol", "disagree", { replyTo: mine.id });
  const recent = db.getRecentMessages("#c", 50, true);
  const reply = recent[recent.length - 1];
  assert.equal(reply.content, "disagree");
  assert.equal(reply.reply_to_message_id, mine.id);
  assert.equal(reply.reply_to.is_bot_message, true);
});

test("the evaluator answers with line references and a reaction; the client gets message ids", async () => {
  const ResponseEvaluator = require("../classes/response_evaluator");
  let answer = null;
  let lastPrompt = null;
  const openai = {
    chat: {
      completions: {
        create: async ({ messages }) => {
          lastPrompt = messages;
          return { choices: [{ message: { content: JSON.stringify(answer) } }] };
        },
      },
    },
  };
  const db = { logDecision: () => 7, storePrompt: () => {} };
  const persona = { name: "Mabel", evaluator: "Mabel likes tea.", reactions: "only 🫖." };
  const evaluator = new ResponseEvaluator(silent, { generator: { deepseek: { model: "m" } } }, db, null, persona, openai);
  const messages = [
    { id: "id-1", author_name: "bob", content: "tea time", created_at: "2026-10-26T10:00:00Z", reactions: [{ nick: "alice", reaction: "☕", is_bot: false }] },
    { id: "id-2", author_name: "alice", content: "earl grey or nothing", created_at: "2026-10-26T10:01:00Z" },
  ];

  answer = { action: "react", reply_to_message_id: "m2", reaction: "🫖", reason: "tea" };
  const decision = await evaluator.shouldRespond(messages, "mabel", "#c", null, {});
  assert.equal(decision.action, "react");
  assert.equal(decision.reply_to_message_id, "id-2");
  assert.equal(decision.reaction, "🫖");
  assert.match(lastPrompt[0].content, /HOW MABEL USES REACTIONS:\nonly 🫖\./);
  assert.match(lastPrompt[1].content, /\[m1\] \[\d\d:\d\d\] bob: tea time \[reactions: alice ☕\]\n\[m2\] \[\d\d:\d\d\] alice: earl grey or nothing\n\nCURRENT DATE\/TIME: /);

  const blocked = await evaluator.shouldRespond(messages, "mabel", "#c", null, { canReact: false });
  assert.equal(blocked.action, "ignore", "no reacting inside the cooldown");
  assert.match(lastPrompt[1].content, /"react" is not available right now/);

  answer = { action: "react", reply_to_message_id: "m1", reason: "no reaction given" };
  assert.equal((await evaluator.shouldRespond(messages, "mabel", "#c", null, {})).action, "ignore");
});

test("the screen is the last screen_lines lines, however old, reaching back to whatever the journal hasn't read", () => {
  const db = freshDb();
  const { bot } = fakeBot(db, { config: {} });
  bot.config.context = { screen_lines: 4, max_lines: 8 };
  bot.config.journal = { enabled: true };
  for (let i = 0; i < 12; i++) store(db, "bob", `line ${i}`, { at: Date.now() - (12 - i) * 3 * 60 * 60 * 1000 });

  // No journal yet: nothing is remembered, so as far back as the cap allows.
  assert.equal(bot.screenFor("#c").length, 8);

  // The journal has read up to line 9: the last 4 lines are the screen.
  const rowid = db.db.prepare("SELECT rowid FROM messages WHERE content = 'line 9'").get().rowid;
  db.setJournal("#c", "we talked.", { watermarkRowid: rowid });
  const screen = bot.screenFor("#c");
  assert.deepEqual(screen.map((m) => m.content), ["line 8", "line 9", "line 10", "line 11"], "hours apart and still on screen");

  // Read up to line 5: lines 6 through 11 are unread, so all six show.
  const earlier = db.db.prepare("SELECT rowid FROM messages WHERE content = 'line 5'").get().rowid;
  db.setJournalWatermark("#c", earlier);
  assert.equal(bot.screenFor("#c")[0].content, "line 6");

  bot.config.journal.enabled = false;
  assert.equal(bot.screenFor("#c").length, 4, "no journal, no reach");
});

test("the evaluator marks where the lines since the bot last spoke begin", async () => {
  const ResponseEvaluator = require("../classes/response_evaluator");
  let lastPrompt = null;
  const openai = { chat: { completions: { create: async ({ messages }) => {
    lastPrompt = messages;
    return { choices: [{ message: { content: JSON.stringify({ action: "ignore", reason: "r" }) } }] };
  } } } };
  const evaluator = new ResponseEvaluator(silent, { generator: { deepseek: { model: "m" } } }, { logDecision: () => 1, storePrompt: () => {} }, null, { name: "Mabel", evaluator: "e" }, openai);
  await evaluator.shouldRespond([
    { id: "1", author_name: "bob", content: "old", created_at: "2026-10-26T06:00:00Z" },
    { id: "2", author_name: "bob", content: "hi", created_at: "2026-10-26T10:00:00Z" },
    { id: "3", author_name: "mabel", author_id: "mabel", is_bot_message: true, content: "hello", created_at: "2026-10-26T10:01:00Z" },
    { id: "4", author_name: "bob", content: "how are you", created_at: "2026-10-26T10:02:00Z" },
  ], "mabel", "#c");
  assert.match(lastPrompt[1].content, /\[m1\] \[\d\d:\d\d\] bob: old\n--- 4 hours later ---\n\[m2\] \[\d\d:\d\d\] bob: hi\n\[m3\] \[\d\d:\d\d\] mabel \(Mabel\): hello\n--- new since Mabel last spoke ---\n\[m4\] \[\d\d:\d\d\] bob: how are you/);
});

test("the typing indicator pauses after typing_notifications.max_seconds", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const db = freshDb();
  const { bot, sent } = fakeBot(db, { config: { irc: { typing_notifications: { refresh_seconds: 1, max_seconds: 5 } } } });
  bot.typingTimers = new Map();
  bot.startTyping("#c");
  t.mock.timers.tick(3000);
  assert.equal(sent.tagmsgs.length, 4, "active at 0, 1, 2, 3 seconds");
  assert.ok(sent.tagmsgs.every((m) => m.tags["+typing"] === "active"));
  t.mock.timers.tick(3000);
  assert.deepEqual(sent.tagmsgs.at(-1).tags, { "+typing": "paused" });
  assert.equal(bot.typingTimers.has("#c"), false, "no more refreshes");
  const count = sent.tagmsgs.length;
  t.mock.timers.tick(10000);
  assert.equal(sent.tagmsgs.length, count);
});

test("with draft/multiline a long reply is one batch of concat pieces, one echo, one msgid", async () => {
  const db = freshDb();
  const { bot, sent } = fakeBot(db, { config: { irc: { max_line_length: 20 } }, multiline: "max-bytes=4096,max-lines=24" });
  await bot.sendIrcMessage("#c", "one two three four five six seven", { messageId: "m-1", replyToMsgid: "A1" });
  assert.deepEqual(sent.says, [], "nothing went out as plain lines");
  const id = sent.raws[0].match(/BATCH \+(\S+) draft\/multiline #c$/)[1];
  assert.equal(sent.raws[0], `@+draft/reply=A1 BATCH +${id} draft/multiline #c`);
  assert.equal(sent.raws[1], `@batch=${id} PRIVMSG #c :one two three four`);
  assert.equal(sent.raws[2], `@batch=${id};draft/multiline-concat PRIVMSG #c : five six seven`);
  assert.equal(sent.raws.at(-1), `BATCH -${id}`);
  assert.deepEqual(bot.pendingEchoes.get("#c").map((e) => e.text), ["one two three four five six seven"]);

  // The echo comes back as a batch whose start line carries the msgid.
  bot.noteBatchStart(`@msgid=E9;time=2026-10-28T03:00:00.000Z :mabel!u@h BATCH +${id} draft/multiline #c`);
  await bot.handleMultilineBatch({
    id,
    type: "draft/multiline",
    params: ["#c"],
    commands: [
      { command: "PRIVMSG", nick: "mabel", ident: "u", hostname: "h", params: ["#c", "one two three four"], tags: { batch: id } },
      { command: "PRIVMSG", nick: "mabel", ident: "u", hostname: "h", params: ["#c", " five six seven"], tags: { batch: id, "draft/multiline-concat": "" } },
    ],
  });
  assert.equal(db.getMsgidFor("m-1"), "E9");
  assert.equal(bot.pendingEchoes.has("#c"), false);
  assert.equal(bot.batchTags.size, 0);

  // A short reply is still a single plain line.
  await bot.sendIrcMessage("#c", "ok", { messageId: "m-2" });
  assert.deepEqual(sent.says, [{ target: "#c", line: "ok", tags: undefined }]);
  // Over the server's limits it falls back to plain lines.
  const small = fakeBot(db, { config: { irc: { max_line_length: 20 } }, multiline: "max-bytes=4096,max-lines=2" });
  await small.bot.sendIrcMessage("#c", "one two three four five six seven eight nine ten eleven", { messageId: "m-3" });
  assert.deepEqual(small.sent.raws, []);
  assert.ok(small.sent.says.length > 2);
});

test("an incoming multiline batch is one message with the start line's tags; its lines are kept", async () => {
  const db = freshDb();
  const { bot } = fakeBot(db, { multiline: "max-bytes=4096,max-lines=24" });
  const seen = [];
  bot.handleIrcMessage = async (event) => seen.push(event);
  bot.noteBatchStart("@msgid=M1;+draft/reply=A1;time=2026-10-28T03:00:00.000Z;account=bob :bob!u@h BATCH +xyz draft/multiline #c");
  assert.deepEqual(bot.batchTags.get("xyz"), { msgid: "M1", "+draft/reply": "A1", time: "2026-10-28T03:00:00.000Z", account: "bob" });
  await bot.handleMultilineBatch({
    id: "xyz",
    type: "draft/multiline",
    params: ["#c"],
    commands: [
      { command: "PRIVMSG", nick: "bob", ident: "u", hostname: "h", params: ["#c", "first line"], tags: { batch: "xyz" } },
      { command: "PRIVMSG", nick: "bob", ident: "u", hostname: "h", params: ["#c", " continued"], tags: { batch: "xyz", "draft/multiline-concat": "" } },
      { command: "PRIVMSG", nick: "bob", ident: "u", hostname: "h", params: ["#c", "second line"], tags: { batch: "xyz" } },
    ],
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].nick, "bob");
  assert.equal(seen[0].target, "#c");
  assert.equal(seen[0].message, "first line continued\nsecond line");
  assert.equal(seen[0].tags.msgid, "M1");
  assert.equal(seen[0].tags["+draft/reply"], "A1");
  assert.equal(bot.batchTags.has("xyz"), false);
  // A batch of something other than PRIVMSG, or an unknown start, is ignored.
  bot.noteBatchStart(":irc.example BATCH +q chathistory #c");
  assert.equal(bot.batchTags.has("q"), false);
  await bot.handleMultilineBatch({ id: "q", type: "draft/multiline", params: ["#c"], commands: [] });
  assert.equal(seen.length, 1);
});
