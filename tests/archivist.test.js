const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const {
  Archivist,
  decidePass,
  journalConfig,
  buildArchivistPrompt,
  parseArchivistAnswer,
} = require("../classes/archivist");
const ContextUtils = require("../classes/context_utils");
const DatabaseManager = require("../classes/database");

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const persona = { name: "Isaac", character: "You are Isaac. Melancholic.", evaluator: "Isaac is sad." };

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "impostor-test-"));
  const db = new DatabaseManager(silent, path.join(dir, "impostor.db"));
  db.initialize();
  return db;
}

let clock = Date.parse("2026-10-26T10:00:00Z");
function say(db, conversation, nick, content, isBot = false) {
  clock += 1000;
  db.insertMessageEnhanced({
    id: `${nick}-${clock}`,
    channelId: conversation,
    authorId: nick.toLowerCase(),
    authorName: nick,
    content,
    createdAt: new Date(clock).toISOString(),
    isBotMessage: isBot,
  });
}

function fakeOpenai(answers) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (req) => {
          calls.push(req);
          const next = answers.shift();
          if (next instanceof Error) throw next;
          return { choices: [{ message: { content: typeof next === "string" ? next : JSON.stringify(next) } }] };
        },
      },
    },
  };
}

test("decidePass: enough lines runs now, a few waits for quiet, fewer does nothing", () => {
  const cfg = journalConfig({ journal: { messages_per_pass: 40, min_messages: 5 } });
  assert.equal(decidePass(40, cfg), "now");
  assert.equal(decidePass(5, cfg), "when-quiet");
  assert.equal(decidePass(4, cfg), "no");
  assert.equal(decidePass(0, cfg), "no");
});

test("journalConfig layers the bot's settings over the defaults", () => {
  const cfg = journalConfig({ journal: { quiet_minutes: 3 } });
  assert.equal(cfg.quiet_minutes, 3);
  assert.equal(cfg.messages_per_pass, 40);
});

test("parseArchivistAnswer reads the shape leniently and drops junk", () => {
  const parsed = parseArchivistAnswer('```json\n{"journal": " hi ", "people": {"bob": " a note ", "eve": "", "x": 3}, "rationale": "r"}\n```');
  assert.equal(parsed.journal, "hi");
  assert.deepEqual([...parsed.people], [["bob", "a note"]]);
  assert.equal(parsed.rationale, "r");

  assert.deepEqual(parseArchivistAnswer('<think>hmm</think>{"journal": null}'), {
    journal: null,
    people: new Map(),
    rationale: "",
  });
  assert.equal(parseArchivistAnswer("not json"), null);
  assert.equal(parseArchivistAnswer('{"people": {}}'), null, "journal key is required");
  assert.equal(parseArchivistAnswer('{"journal": 5}'), null);
  assert.equal(parseArchivistAnswer(""), null);
});

test("buildArchivistPrompt names the conversation, shows notes, and tags the bot's lines", () => {
  const cfg = journalConfig({});
  const { system, user } = buildArchivistPrompt({
    persona,
    conversationId: "#lurker",
    journal: "",
    people: new Map([["amiantos", "my creator"]]),
    nicks: ["amiantos", "bob"],
    lines: ["[10:00] <amiantos> hi", "[10:01] <Isaac (you)> hey"],
    part: { index: 0, count: 1 },
    cfg,
  });
  assert.match(system, /memory of Isaac/);
  assert.match(system, /JOURNAL for #lurker/);
  assert.match(system, /under about 1500 characters/);
  assert.match(system, /You are Isaac\. Melancholic\./);
  assert.match(user, /# The journal for #lurker\n\n\(empty so far\)/);
  assert.match(user, /amiantos: my creator\nbob: \(no note yet\)/);
  assert.match(user, /# The chatlog\n\n\[10:00\] <amiantos> hi\n\[10:01\] <Isaac \(you\)> hey/);
  assert.doesNotMatch(user, /part 1 of/);

  const dm = buildArchivistPrompt({
    persona, conversationId: "bob", journal: "old", people: new Map(), nicks: [], lines: ["x"],
    part: { index: 1, count: 3 }, cfg,
  });
  assert.match(dm.system, /JOURNAL for direct messages with bob/);
  assert.match(dm.user, /part 2 of 3/);
  assert.match(dm.user, /already includes what the earlier parts/);
  assert.match(dm.user, /\(nobody but you spoke\)/);
});

test("a pass rewrites the journal and the notes of people present, and moves the watermark", async () => {
  const db = tempDb();
  say(db, "#lurker", "amiantos", "i run a lurker instance for friends");
  say(db, "#lurker", "Isaac", "sounds exhausting", true);
  say(db, "#lurker", "bob", "lol");

  const openai = fakeOpenai([
    {
      journal: "amiantos told me about the lurker instance. bob laughed.",
      people: { amiantos: "runs a lurker instance for friends", carol: "never spoke", bob: "laughs at me" },
      rationale: "first stretch",
    },
  ]);
  const ctx = new ContextUtils(silent, persona);
  const archivist = new Archivist(silent, { journal: { messages_per_pass: 3 } }, db, openai, ctx);

  const result = await archivist.runPass("#lurker");
  assert.deepEqual(result, { passes: 1, changed: true });
  assert.equal(db.getJournalText("#lurker"), "amiantos told me about the lurker instance. bob laughed.");
  assert.equal(db.getJournal("#lurker").watermark_rowid, 3);
  assert.equal(db.getPerson("amiantos").content, "runs a lurker instance for friends");
  assert.equal(db.getPerson("bob").content, "laughs at me");
  assert.equal(db.getPerson("carol"), null, "a note for someone not in the stretch is ignored");
  assert.equal(db.getJournalVersions("#lurker").length, 1);
  assert.equal(db.getJournalVersions("#lurker")[0].rationale, "first stretch");
  assert.equal(archivist.unreadCount("#lurker"), 0);

  // The prompt carried the chatlog with the bot's line tagged, and no thinking.
  const req = openai.calls[0];
  assert.match(req.messages[1].content, /<Isaac \(you\)> sounds exhausting/);
  assert.deepEqual(req.thinking, { type: "disabled" });

  // Second pass sees the new journal and note, and a null journal keeps it.
  say(db, "#lurker", "amiantos", "anyway");
  openai.calls.length = 0;
  openai.chat.completions.create = fakeOpenai([{ journal: null, people: {} }]).chat.completions.create;
  const second = await archivist.runPass("#lurker");
  assert.deepEqual(second, { passes: 1, changed: false });
  assert.equal(db.getJournal("#lurker").watermark_rowid, 4);
  assert.equal(db.getJournalVersions("#lurker").length, 1, "an unchanged journal adds no version");
  db.close();
});

test("a failed or unparseable answer leaves the watermark alone so the stretch is reread", async () => {
  const db = tempDb();
  say(db, "#c", "amiantos", "hello");
  const openai = fakeOpenai(["garbage", "more garbage"]);
  const archivist = new Archivist(silent, {}, db, openai, new ContextUtils(silent, persona));
  const result = await archivist.runPass("#c");
  assert.deepEqual(result, { passes: 1, changed: false });
  assert.equal(db.getJournal("#c"), null);
  assert.equal(archivist.unreadCount("#c"), 1);
  assert.equal(openai.calls.length, 2, "asked once more for JSON");

  const failing = fakeOpenai([new Error("boom"), new Error("boom")]);
  const archivist2 = new Archivist(silent, {}, db, failing, new ContextUtils(silent, persona));
  await archivist2.runPass("#c");
  assert.equal(archivist2.unreadCount("#c"), 1);
  db.close();
});

test("a backlog is read in batches, each rewriting the last one's journal", async () => {
  const db = tempDb();
  for (let i = 0; i < 5; i++) say(db, "#c", "amiantos", `line ${i}`);
  const openai = fakeOpenai([
    { journal: "first two", people: {} },
    { journal: "first four", people: {} },
    { journal: "all five", people: {} },
  ]);
  const archivist = new Archivist(silent, { journal: { max_messages_per_pass: 2 } }, db, openai, new ContextUtils(silent, persona));
  const result = await archivist.runPass("#c");
  assert.deepEqual(result, { passes: 3, changed: true });
  assert.equal(db.getJournalText("#c"), "all five");
  assert.equal(db.getJournal("#c").watermark_rowid, 5);
  assert.match(openai.calls[1].messages[1].content, /# The journal for #c\n\nfirst two/);
  assert.match(openai.calls[0].messages[1].content, /part 1 of 3/);
  assert.match(openai.calls[2].messages[1].content, /part 3 of 3/);
  db.close();
});

test("a journal far over budget is kept out, but the watermark still moves", async () => {
  const db = tempDb();
  say(db, "#c", "amiantos", "hello");
  const openai = fakeOpenai([{ journal: "x".repeat(10000), people: { amiantos: "y".repeat(5000) } }]);
  const archivist = new Archivist(silent, { journal: { journal_max_chars: 100, note_max_chars: 50 } }, db, openai, new ContextUtils(silent, persona));
  await archivist.runPass("#c");
  assert.equal(db.getJournalText("#c"), "");
  assert.equal(db.getJournal("#c").watermark_rowid, 1);
  assert.equal(db.getPerson("amiantos"), null);
  db.close();
});

test("memoryFor returns the journal and only the notes of the nicks asked for", async () => {
  const db = tempDb();
  db.setJournal("#c", "the story so far");
  db.setPerson("Amiantos", "my creator");
  db.setPerson("bob", "a bob");
  const archivist = new Archivist(silent, {}, db, fakeOpenai([]), new ContextUtils(silent, persona));
  const memory = archivist.memoryFor("#c", ["amiantos", "carol"]);
  assert.equal(memory.journal, "the story so far");
  assert.deepEqual([...memory.people], [["amiantos", "my creator"]], "keyed by the nick as asked for");
  assert.equal(archivist.memoryFor("#other", []).journal, null);
  db.close();
});

test("noteActivity runs a pass at the message threshold and arms a quiet timer below it", async () => {
  const db = tempDb();
  const openai = fakeOpenai([{ journal: "j", people: {} }]);
  const archivist = new Archivist(silent, { journal: { messages_per_pass: 2, min_messages: 1, quiet_minutes: 0.0001 } }, db, openai, new ContextUtils(silent, persona));
  say(db, "#c", "a", "one");
  archivist.noteActivity("#c");
  assert.equal(archivist.quietTimers.size, 1);
  assert.equal(openai.calls.length, 0);
  say(db, "#c", "a", "two");
  archivist.noteActivity("#c");
  assert.equal(archivist.quietTimers.size, 0, "a pass replaces the timer");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(openai.calls.length, 1);
  assert.equal(db.getJournalText("#c"), "j");

  // Below the threshold the quiet timer fires a pass on its own.
  openai.chat.completions.create = fakeOpenai([{ journal: "k", people: {} }]).chat.completions.create;
  say(db, "#c", "a", "three");
  archivist.noteActivity("#c");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(db.getJournalText("#c"), "k");
  archivist.shutdown();
  db.close();
});

test("a disabled journal never runs", () => {
  const db = tempDb();
  const archivist = new Archivist(silent, { journal: { enabled: false } }, db, fakeOpenai([]), new ContextUtils(silent, persona));
  say(db, "#c", "a", "one");
  archivist.noteActivity("#c");
  assert.equal(archivist.quietTimers.size, 0);
  db.close();
});

test("a note is found and kept whatever case the nick is typed in today", async () => {
  const db = tempDb();
  db.setPerson("Amiantos", "my creator, likes tabs");
  say(db, "#c", "amiantos", "i also like spaces now");
  const openai = fakeOpenai([{ journal: null, people: { amiantos: "my creator, likes tabs and now spaces" } }]);
  const archivist = new Archivist(silent, {}, db, openai, new ContextUtils(silent, persona));
  await archivist.runPass("#c");
  assert.match(openai.calls[0].messages[1].content, /amiantos: my creator, likes tabs/, "the old note was shown");
  assert.equal(db.getPerson("AMIANTOS").content, "my creator, likes tabs and now spaces");
  assert.equal(db.getPersonVersions("amiantos").length, 2, "updated, not replaced from scratch");
  assert.deepEqual([...archivist.memoryFor("#c", ["AMIANTOS"]).people], [["AMIANTOS", "my creator, likes tabs and now spaces"]]);
  db.close();
});

test("after a failed pass the message threshold waits out the backoff instead of retrying per line", async () => {
  const db = tempDb();
  const openai = fakeOpenai(["junk", "junk"]);
  const archivist = new Archivist(silent, { journal: { messages_per_pass: 1, min_messages: 1, quiet_minutes: 60 } }, db, openai, new ContextUtils(silent, persona));
  say(db, "#c", "a", "one");
  await archivist.runPass("#c");
  assert.equal(openai.calls.length, 2);
  say(db, "#c", "a", "two");
  archivist.noteActivity("#c");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(openai.calls.length, 2, "no immediate retry");
  assert.equal(archivist.quietTimers.size, 1, "the quiet timer is armed instead");
  archivist.shutdown();
  db.close();
});

test("lines that arrive during a pass get the quiet timer afterwards", async () => {
  const db = tempDb();
  say(db, "#c", "a", "one");
  let release;
  const gate = new Promise((r) => (release = r));
  const openai = {
    calls: [],
    chat: { completions: { create: async (req) => { openai.calls.push(req); await gate; return { choices: [{ message: { content: '{"journal": "j", "people": {}}' } }] }; } } },
  };
  const archivist = new Archivist(silent, { journal: { messages_per_pass: 1, min_messages: 1, quiet_minutes: 60 } }, db, openai, new ContextUtils(silent, persona));
  const running = archivist.runPass("#c");
  await new Promise((r) => setTimeout(r, 5));
  say(db, "#c", "a", "two");
  archivist.noteActivity("#c"); // mid-pass: queued, timer cleared
  assert.equal(archivist.quietTimers.size, 0);
  release();
  await running;
  // The tail is below messages_per_pass? No: it is 1 >= 1, so a second pass runs.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(openai.calls.length, 2);
  archivist.shutdown();
  db.close();
});

test("a ! command alone does not put its sender among the people of a stretch", async () => {
  const db = tempDb();
  say(db, "#c", "carol", "!seen bob");
  say(db, "#c", "amiantos", "hello");
  const openai = fakeOpenai([{ journal: "j", people: { carol: "invented", amiantos: "real" } }]);
  const archivist = new Archivist(silent, {}, db, openai, new ContextUtils(silent, persona));
  await archivist.runPass("#c");
  assert.doesNotMatch(openai.calls[0].messages[1].content, /carol/);
  assert.equal(db.getPerson("carol"), null);
  assert.equal(db.getPerson("amiantos").content, "real");
  db.close();
});
