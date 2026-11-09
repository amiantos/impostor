const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const DatabaseManager = require("../classes/database");
const ImpostorClient = require("../classes/impostor_client");
const { createIrcMessage } = require("../classes/irc_message");

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "impostor-test-"));
  const db = new DatabaseManager(silent, path.join(dir, "impostor.db"));
  db.initialize();
  return db;
}

let clock = Date.now() - 60 * 60 * 1000;
function store(db, nick, text, { channel = "#c", isBot = false, at = null } = {}) {
  const message = createIrcMessage(nick, channel, text, { isBot });
  message.createdAt = new Date(at ?? (clock += 1000));
  db.insertMessageEnhanced({
    id: message.id,
    channelId: channel,
    authorId: message.author.id,
    authorName: nick,
    content: text,
    createdAt: message.createdAt,
    isBotMessage: isBot,
  });
  return db.getMessage(message.id);
}

/** An ImpostorClient with only what evaluateAutonomousResponse touches, and a recording evaluator. */
function fakeBot(db) {
  const bot = Object.create(ImpostorClient.prototype);
  const asked = [];
  Object.assign(bot, {
    db,
    logger: silent,
    botNick: "mabel",
    watchword: "Mabel",
    config: { autonomous: {}, context: {}, journal: { enabled: false } },
    generatingChannels: new Set(),
    presence: { gone: false, notePending() {}, describe() { return null; } },
    roster: { describe() { return null; } },
    evaluator: {
      shouldRespond: async (messages, botUserId, channel, options) => {
        asked.push({ messages, options });
        return { action: "ignore", reason: "test", decisionId: null };
      },
    },
    messageQueue: [],
    isProcessing: false,
    processMessageQueue() {},
  });
  return { bot, asked };
}

test("an unaddressed line right after the bot spoke still goes to the evaluator: no cooldown, no ratio gate", async () => {
  const db = freshDb();
  const { bot, asked } = fakeBot(db);
  // The bot is most of the recent conversation and spoke two seconds ago.
  store(db, "mabel", "one", { isBot: true });
  store(db, "mabel", "two", { isBot: true });
  store(db, "mabel", "three", { isBot: true });
  store(db, "bob", "guy or girl?");
  store(db, "mabel", "no idea, it's a blanket with a phone under it", { isBot: true, at: Date.now() - 2000 });
  store(db, "bob", "what if it's a hostage", { at: Date.now() - 1000 });

  await bot.evaluateAutonomousResponse("#c");

  assert.equal(asked.length, 1, "the evaluator was asked");
  assert.equal(asked[0].options.restraint, undefined, "no restraint mode");
  assert.equal(asked[0].messages[asked[0].messages.length - 1].content, "what if it's a hostage");
  const suppressed = db.getDecisionsByChannel("#c", 10).filter((d) => /cooldown|ratio/.test(d.reason));
  assert.deepEqual(suppressed, [], "nothing is suppressed in code before the evaluator");
});

test("nothing new since the bot spoke means the evaluator isn't asked", async () => {
  const db = freshDb();
  const { bot, asked } = fakeBot(db);
  store(db, "bob", "hi");
  store(db, "mabel", "hi bob", { isBot: true });
  await bot.evaluateAutonomousResponse("#c");
  assert.equal(asked.length, 0);
});

test("the evaluator is told another bot's line into the room is not an opening", () => {
  const ResponseEvaluator = require("../classes/response_evaluator");
  const evaluator = new ResponseEvaluator(silent, { timezone: "UTC" }, null, null, { name: "Mabel", evaluator: "Mabel is a bot." }, null);
  const prompt = evaluator.buildDecisionPrompt();
  assert.match(prompt, /OTHER BOTS: the same line marks other chatbots "\(bot\)"\. A bot's line addressed to Mabel by name gets the normal treatment\./);
  assert.match(prompt, /two bots answering each other's dispatches is what empties a channel of people/);
});

test("the evaluator is told the bot's nick when it differs from the name", () => {
  const ResponseEvaluator = require("../classes/response_evaluator");
  const persona = { name: "Layla", evaluator: "Layla is a bot." };
  const withNick = new ResponseEvaluator(silent, { timezone: "UTC", irc: { nick: "notlayla" } }, null, null, persona, null);
  assert.match(withNick.buildDecisionPrompt(), /goes by the nick "notlayla"/);
  const sameNick = new ResponseEvaluator(silent, { timezone: "UTC", irc: { nick: "layla" } }, null, null, persona, null);
  assert.doesNotMatch(sameNick.buildDecisionPrompt(), /goes by the nick/);
});
