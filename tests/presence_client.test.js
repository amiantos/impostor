const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const ImpostorClient = require("../classes/impostor_client");
const { resolveBotConfig } = require("../classes/bot_config");
const { parsePersona } = require("../classes/persona");
const { createIrcMessage } = require("../classes/irc_message");
const { zonedDate } = require("../classes/schedule");

const TZ = "America/Chicago";
const at = (h, m) => zonedDate(TZ, 2026, 10, 28, h, m);
const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };
const tools = { pythonTool: {}, webSearchTool: {}, webFetchTool: {} };

// The evaluator says goodbye is warranted; the reply model says goodnight.
const calls = { evaluations: [], replies: [] };
const openai = {
  chat: {
    completions: {
      create: async ({ messages, response_format }) => {
        const user = messages[messages.length - 1].content;
        if (/say goodbye before going/.test(user)) {
          calls.evaluations.push(user);
          return { choices: [{ message: { content: JSON.stringify({ action: "respond", reason: "mid-chat" }) }, finish_reason: "stop" }] };
        }
        if (/has been quiet for/.test(user)) {
          calls.replies.push({ system: messages[0].content, user });
          return { choices: [{ message: { content: JSON.stringify({ needs_tool: false, continue_iterating: false, message: "class was so pointless today" }) }, finish_reason: "stop" }] };
        }
        if (/Should Mabel respond/.test(user)) {
          calls.evaluations.push(user);
          return { choices: [{ message: { content: JSON.stringify({ action: "ignore", reason: "nothing" }) }, finish_reason: "stop" }] };
        }
        calls.replies.push({ system: messages[0].content, user });
        return { choices: [{ message: { content: JSON.stringify({ needs_tool: false, continue_iterating: false, message: "ok bed. night" }) }, finish_reason: "stop" }] };
      },
    },
  },
};

let dataDir, bot, now;
const said = [];
const raws = [];
const aways = () => raws.filter((r) => r[0] === "AWAY");

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "impostor-presence-"));
  const persona = parsePersona("# Mabel\n\nYou are Mabel.\n\n## Schedule\n\naway 23:00-07:00: asleep | zzz\n");
  const config = resolveBotConfig(
    {
      generator: { deepseek: { api_key: "k", model: "m", temperature: 0.9, max_tokens: 500 } },
      irc: { host: "localhost" },
      autonomous: { enabled: true, debounce_seconds: 0, max_wait_seconds: 0 },
      journal: { enabled: false },
      presence: { afk_minutes: 15, linger_minutes: 15 },
      timezone: TZ,
    },
    { id: "mabel", nick: "Mabel", persona: "p", channels: ["#c"], pm_allowed_users: ["bob"] }
  );
  bot = new ImpostorClient(silent, config, { openai, tools, dataDir, persona });
  // The constructor ticked once with the real clock; start over on ours.
  bot.presence.stop();
  now = at(22, 50);
  Object.assign(bot.presence, { clock: () => now, lastSentAt: now, gone: false, current: null, afk: false, applied: null, initial: false });
  // A stand-in for the IRC connection: records what goes out.
  bot.ircClient = {
    connected: true,
    say: (target, line) => said.push([target, line]),
    raw: (...args) => raws.push(args),
    tagmsg: () => {},
    quit: () => {},
    network: { supportsTag: () => false, cap: { isEnabled: () => false } },
  };
});

after(() => bot.shutdown());

async function line(nick, text, channel = "#c") {
  const msg = createIrcMessage(nick, channel, text, { isBot: false });
  msg.createdAt = now;
  await bot.messageTracker.addMessage(msg, { isBotMessage: false, processVision: false, processUrls: false });
  return msg;
}

test("at bedtime a live channel gets a goodbye, then the bot is away and answers nothing", async () => {
  now = at(22, 58);
  await line("alice", "mabel what do you think");
  bot.presence.noteAddressed(now);
  bot.presence.initial = false;

  now = at(23, 0);
  await bot.presence.tick();
  assert.equal(bot.presence.gone, false, "lingers: alice spoke a moment ago");

  now = at(23, 4);
  await bot.presence.tick();
  assert.equal(bot.presence.gone, true);
  assert.equal(calls.evaluations.length, 1);
  assert.match(calls.evaluations[0], /about to go \(asleep\)/);
  assert.equal(calls.replies.length, 1);
  assert.match(calls.replies[0].system, /RIGHT NOW: You're about to go: asleep, until about 7:00 AM\./);
  assert.match(calls.replies[0].user, /Say a brief goodbye/);
  assert.deepEqual(said, [["#c", "ok bed. night"]]);
  assert.deepEqual(aways(), [["AWAY", "zzz"]]);
  assert.ok(bot.db.getRecentMessages("#c", 5, true).some((m) => m.is_bot_message && m.content === "ok bed. night"), "the goodbye is in the chatlog");
  assert.equal(bot.db.db.prepare("SELECT response_type FROM responses ORDER BY rowid DESC LIMIT 1").get().response_type, "goodbye");

  // Overnight: a channel line naming her and a DM. Stored, not answered.
  now = at(23, 30);
  await bot.handleIrcMessage({ nick: "alice", target: "#c", message: "mabel you still there", tags: {} });
  await bot.handleIrcMessage({ nick: "bob", target: "Mabel", message: "psst", tags: {} });
  assert.equal(bot.evaluationTimers.size, 0);
  assert.equal(bot.messageQueue.length, 0);
  assert.equal(bot.db.getRecentMessages("bob", 5, true).length, 1, "the DM is stored");
  assert.deepEqual([...bot.presence.pending.keys()], ["#c", "bob"]);
  assert.equal(bot.presence.pending.get("#c").addressed, true);
});

test("in the morning the status clears and the missed conversations get one look", async () => {
  now = at(7, 0);
  // 7:00 the next day is "2026-10-29"; the block ran from the 28th.
  now = zonedDate(TZ, 2026, 10, 29, 7, 0);
  const before = { evaluations: calls.evaluations.length, replies: calls.replies.length };
  bot.roster.setUserlist("#c", ["amiantos", "bob", "Mabel"]);
  bot.roster.setAway("bob", "zzz");
  await bot.presence.tick();
  assert.equal(bot.presence.gone, false);
  assert.deepEqual(aways().at(-1), ["AWAY"]);
  assert.ok(bot.evaluationTimers.has("#c"), "the channel is scheduled for evaluation");
  // The DM reply is queued and answered; run the channel's evaluation
  // ourselves instead of waiting out the debounce.
  await new Promise((r) => setTimeout(r, 50));
  bot.cancelEvaluationTimer("#c");
  await bot.evaluateAutonomousResponse("#c");
  assert.equal(calls.replies.length, before.replies + 1, "bob's DM got an answer");
  assert.match(calls.replies.at(-1).system, /RIGHT NOW: You just got back \(just now\): you were asleep until 7:00 AM/);
  assert.equal(said.at(-1)[0], "bob");
  assert.match(calls.replies.at(-1).user, /^bob is away: zzz, so they may not see this until they're back\.\n\nRecent conversation/m);
  assert.equal(calls.evaluations.length, before.evaluations + 1, "the channel got one evaluation");
  assert.match(calls.evaluations.at(-1), /Mabel's day right now: You just got back/);
  assert.match(calls.evaluations.at(-1), /In #c right now: amiantos, bob \(away: zzz\)\./);
  assert.equal(bot.presence.pending.size, 0);
});

test("after a quiet stretch the bot may say something unprompted, once, and the broker closes the channel", async () => {
  const later = zonedDate(TZ, 2026, 10, 29, 9, 0);
  now = later;
  Object.assign(bot.spontaneity, { clock: () => now, startedAt: zonedDate(TZ, 2026, 10, 29, 8, 0), random: () => 0 });
  bot.roster.setUserlist("#c", ["amiantos", "bob", "Mabel"]);
  bot.roster.setBack("bob");
  // The newest line in #c was stored at the real clock (yesterday in test time), so #c has been quiet for ages.
  const replies = calls.replies.length;
  bot.checkSilences(now);
  assert.equal(bot.messageQueue.length + (bot.isProcessing ? 1 : 0) >= 1 || calls.replies.length > replies, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.replies.length, replies + 1);
  assert.match(calls.replies.at(-1).user, /The channel has been quiet for \d+ minutes and nobody is talking to you/);
  assert.match(calls.replies.at(-1).user, /In #c right now: amiantos, bob\./);
  assert.deepEqual(said.at(-1), ["#c", "class was so pointless today"]);
  assert.equal(bot.db.db.prepare("SELECT response_type FROM responses ORDER BY rowid DESC LIMIT 1").get().response_type, "spontaneous");
  assert.match(bot.db.db.prepare("SELECT reason FROM decision_log ORDER BY rowid DESC LIMIT 1").get().reason, /^\[spontaneous\] spoke after \d+ quiet minutes/);
  assert.equal(bot.spontaneity.spoken.length, 1);

  // Right after, the channel is closed: the bot's own gap and the broker both say no.
  now = new Date(later.getTime() + 60 * 60000);
  bot.checkSilences(now);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.replies.length, replies + 1);
});
