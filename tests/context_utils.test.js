const { test } = require("node:test");
const assert = require("node:assert/strict");
const ContextUtils = require("../classes/context_utils");

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const persona = { name: "Mabel", character: "You are Mabel, a cheerful bot.", evaluator: "Mabel is cheerful." };

function msg(nick, content, extra = {}) {
  return {
    id: `${nick}-${content}`,
    author_id: nick.toLowerCase(),
    author_name: nick,
    content,
    created_at: "2026-10-26T10:00:00.000Z",
    is_bot_message: false,
    ...extra,
  };
}

test("the system prompt is the persona's character, then the medium with the name filled in", () => {
  const ctx = new ContextUtils(silent, persona);
  const prompt = ctx.buildInstructions();
  assert.ok(prompt.startsWith("You are Mabel, a cheerful bot.\n\nHOW IRC WORKS HERE:"));
  assert.match(prompt, /<Mabel \(you\)>/);
  assert.match(prompt, /your normal Mabel response/);
  assert.doesNotMatch(prompt, /NAME/);
  assert.doesNotMatch(prompt, /remember/i);
  assert.match(prompt, /CURRENT DATE\/TIME: /);
});

test("the response schema no longer offers a remember tool", () => {
  const ctx = new ContextUtils(silent, persona);
  assert.deepEqual(ctx.getResponseSchema().properties.tool_request.properties.tool_name.enum, [
    "python",
    "web_search",
    "web_fetch",
  ]);
  assert.equal(
    ctx.validateStructuredResponse({
      needs_tool: true,
      continue_iterating: false,
      tool_request: { tool_name: "remember", reason: "r", username: "u", category: "fact", content: "c" },
      message: "",
    }),
    true,
    "validation only checks the tools it knows; unknown tools fail at execution"
  );
});

test("renderChatlog tags the bot's lines, skips ! commands, and collects link summaries", () => {
  const ctx = new ContextUtils(silent, persona);
  const summaries = [];
  const lines = ctx.renderChatlog(
    [
      msg("amiantos", "hi", { url_summaries: [{ url: "u", success: true, summary: "s" }] }),
      msg("Mabel", "hello", { is_bot_message: true }),
      msg("bob", "!roll"),
      msg("carol", "yo", { created_at: "2026-10-27T10:00:00.000Z" }),
    ],
    { urlSummaries: summaries }
  );
  assert.equal(lines.length, 6, "two day dividers, a lull marker, three lines");
  assert.ok(lines[0].startsWith("--- "));
  assert.match(lines[1], /<amiantos> hi$/);
  assert.match(lines[2], /<Mabel \(you\)> hello$/);
  assert.equal(lines[3], "--- 24 hours later ---");
  assert.ok(lines[4].startsWith("--- Tue"));
  assert.match(lines[5], /<carol> yo$/);
  assert.equal(summaries.length, 1);
});

test("the consolidated message leads with the journal and people, then the chatlog", () => {
  const ctx = new ContextUtils(silent, persona);
  const [message] = ctx.buildChatMessagesConsolidated(
    [msg("amiantos", "mabel: what did we decide"), msg("Mabel", "nothing", { is_bot_message: true })],
    "mabel",
    { userName: "amiantos", channelName: "#lurker" },
    null,
    { journal: "we argued about tabs.", people: new Map([["amiantos", "my creator"], ["bob", ""]]) }
  );
  assert.equal(message.role, "user");
  assert.ok(message.content.startsWith("--- YOUR JOURNAL FOR #LURKER ---\nwe argued about tabs.\n--- END JOURNAL ---\n\n--- PEOPLE ---\namiantos: my creator\n--- END PEOPLE ---\n\nRecent conversation in #lurker:"));
  assert.match(message.content, /Respond to amiantos, whose latest message was: "mabel: what did we decide"/);
});

test("no memory means no memory block, and a DM is labeled as one", () => {
  const ctx = new ContextUtils(silent, persona);
  const [message] = ctx.buildChatMessagesConsolidated(
    [msg("bob", "hey")],
    "mabel",
    { userName: "bob", channelName: "bob" },
    null,
    { journal: null, people: new Map() }
  );
  assert.ok(message.content.startsWith("Recent conversation in direct messages with bob:"));
  const [autonomous] = ctx.buildChatMessagesConsolidated([msg("bob", "hey")], "mabel", { userName: null, channelName: "#c" });
  assert.match(autonomous.content, /Respond naturally to the ongoing conversation/);
});

test("conversationLabel distinguishes channels from DMs", () => {
  assert.equal(ContextUtils.conversationLabel("#lurker"), "#lurker");
  assert.equal(ContextUtils.conversationLabel("bob"), "direct messages with bob");
});

test("every timestamp the model sees is in the configured zone, not the process clock", () => {
  const ctx = new ContextUtils(silent, persona, { timezone: "America/Los_Angeles" });
  // 2026-10-27T00:03:00Z is 5:03 PM PDT the day before.
  const [message] = ctx.buildChatMessagesConsolidated(
    [msg("amiantos", "hey", { created_at: "2026-10-27T00:03:00.000Z" })],
    "mabel",
    { userName: "amiantos", channelName: "#c" }
  );
  assert.match(message.content, /--- Mon, Oct 26, 2026 ---\n\[17:03\] m1 <amiantos> hey/);
  assert.match(ctx.buildInstructions(), /Timestamps are in Pacific Time/);
  assert.match(ctx.buildInstructions(), /CURRENT DATE\/TIME: .* P[DS]T$/);

  const tokyo = new ContextUtils(silent, persona, { timezone: "Asia/Tokyo" });
  assert.equal(tokyo.formatTime("2026-10-27T00:03:00.000Z"), "09:03");
  assert.equal(ctx.formatTime("2026-10-27T07:00:00.000Z"), "00:00", "midnight is 00, never 24");
  assert.throws(() => new ContextUtils(silent, persona, { timezone: "Mars/Olympus" }), /Unknown timezone/);
});

test("the bot's own lines are tagged with its IRC nick, the persona name stays the character", () => {
  const ctx = new ContextUtils(silent, persona, { nick: "mabel" });
  const lines = ctx.renderChatlog([msg("mabel", "hello", { is_bot_message: true })]);
  assert.match(lines[1], /<mabel \(you\)> hello$/);
  assert.match(ctx.buildInstructions(), /they show as "<mabel \(you\)>"/);
  assert.match(ctx.buildInstructions(), /your normal Mabel response/);
});

test("the reply prompt's chatlog gives every line a reference, skipping ! commands", () => {
  const ctx = new ContextUtils(silent, persona);
  const messages = [msg("amiantos", "hi"), msg("bob", "!roll"), msg("carol", "yo")];
  const refs = ContextUtils.assignRefs(messages);
  assert.deepEqual([...refs.values()], ["m1", "m2"]);
  assert.equal(refs.get("carol-yo"), "m2");
  const [message] = ctx.buildChatMessagesConsolidated(messages, "mabel", { userName: "carol", channelName: "#c" }, null, null, { refs });
  assert.match(message.content, /\] m1 <amiantos> hi\n.*\] m2 <carol> yo/s);
});

test("replies and reactions show on the lines they belong to", () => {
  const ctx = new ContextUtils(silent, persona, { nick: "mabel" });
  const lines = ctx.renderChatlog([
    msg("bob", "my landlord is a vampire", {
      reactions: [
        { nick: "alice", reaction: "😂", is_bot: false },
        { nick: "mabel", reaction: "🦇", is_bot: true },
      ],
    }),
    msg("alice", "wait what", { reply_to: { author_name: "mabel", is_bot_message: true, content: "tea is a soup" } }),
    msg("mabel", "you heard him", {
      is_bot_message: true,
      reply_to: { author_name: "bob", is_bot_message: false, content: "x".repeat(80) },
    }),
  ]);
  assert.match(lines[1], /<bob> my landlord is a vampire \[reactions: alice 😂, you 🦇\]$/);
  assert.match(lines[2], /<alice> \(replying to you: "tea is a soup"\) wait what$/);
  assert.match(lines[3], /<mabel \(you\)> \(replying to bob: "x{60}…"\) you heard him$/);
});

test("the system prompt explains reactions and replies with the persona's style and limits", () => {
  const ctx = new ContextUtils(silent, { ...persona, reactions: "only 🫖, and only for tea." }, { replyMinDistance: 7, reactMaxLength: 12 });
  const prompt = ctx.buildInstructions();
  assert.match(prompt, /HOW Mabel USES REACTIONS:\nonly 🫖, and only for tea\./);
  assert.match(prompt, /7 or more lines back/);
  assert.match(prompt, /at most 12 characters/);
  assert.doesNotMatch(prompt, /REPLY_MIN|REACT_MAX|REACTION_STYLE/);
  assert.match(new ContextUtils(silent, persona).buildInstructions(), new RegExp(ContextUtils.DEFAULT_REACTION_STYLE.slice(0, 20)));
});

test("a persona's reaction text is never read as a placeholder", () => {
  const ctx = new ContextUtils(silent, { ...persona, reactions: "NAME and NICK stay as written; $& too" });
  assert.match(ctx.buildInstructions(), /NAME and NICK stay as written; \$& too/);
});

test("the closing instruction says when reactions are unavailable", () => {
  const ctx = new ContextUtils(silent, persona);
  const [blocked] = ctx.buildChatMessagesConsolidated([msg("bob", "hey")], "mabel", { userName: null, channelName: "#c" }, null, null, { canReact: false });
  assert.match(blocked.content, /Reactions are unavailable right now, so leave "react" null\./);
  const [open] = ctx.buildChatMessagesConsolidated([msg("bob", "hey")], "mabel", { userName: null, channelName: "#c" });
  assert.doesNotMatch(open.content, /unavailable/);
});

test("a lull is marked in the chatlog instead of cutting the older lines", () => {
  assert.equal(ContextUtils.lullMarker(null, "2026-10-26T10:00:00Z", 30), null);
  assert.equal(ContextUtils.lullMarker("2026-10-26T10:00:00Z", "2026-10-26T10:29:00Z", 30), null);
  assert.equal(ContextUtils.lullMarker("2026-10-26T10:00:00Z", "2026-10-26T10:45:00Z", 30), "--- 45 minutes later ---");
  assert.equal(ContextUtils.lullMarker("2026-10-26T10:00:00Z", "2026-10-26T13:10:00Z", 30), "--- 3 hours later ---");
  assert.equal(ContextUtils.lullMarker("2026-10-26T10:00:00Z", "2026-10-29T10:00:00Z", 30), "--- 3 days later ---");

  const ctx = new ContextUtils(silent, persona, { lullMinutes: 60 });
  const lines = ctx.renderChatlog([
    msg("bob", "old thread", { created_at: "2026-10-26T10:00:00Z" }),
    msg("bob", "still old", { created_at: "2026-10-26T10:40:00Z" }),
    msg("alice", "morning", { created_at: "2026-10-26T15:00:00Z" }),
  ]);
  assert.deepEqual(lines.slice(1, 5).map((l) => l.replace(/^\[\d\d:\d\d\] /, "")), [
    "<bob> old thread",
    "<bob> still old",
    "--- 4 hours later ---",
    "<alice> morning",
  ]);
});

test("only the newest link summaries go in the reply prompt", () => {
  const ctx = new ContextUtils(silent, persona, { maxLinkSummaries: 2 });
  const linked = (n) => msg("bob", `link ${n}`, { url_summaries: [{ url: `u${n}`, success: true, summary: `s${n}` }] });
  const [message] = ctx.buildChatMessagesConsolidated([linked(1), linked(2), linked(3)], "mabel", { userName: null, channelName: "#c" });
  assert.doesNotMatch(message.content, /URL: u1/);
  assert.match(message.content, /URL: u2[\s\S]*URL: u3/);
});

test("the spontaneous instruction offers the floor with concrete material and leaves silence allowed, not default", () => {
  const text = ContextUtils.spontaneousInstruction({
    quietMinutes: 33,
    seeds: ["the weather", "a book"],
    news: { query: "robot news this week", answer: "A robot did a thing." },
    people: ["alice", "bob"],
  });
  assert.match(text, /^The channel has been quiet for 33 minutes and nobody is talking to you\. You have the floor if you want it/);
  assert.match(text, /- Things on your mind today: \(1\) the weather \(2\) a book/);
  assert.match(text, /- Something you came across today \(you looked up "robot news this week"\): A robot did a thing\./);
  assert.match(text, /- Your day \(see RIGHT NOW\)/);
  assert.match(text, /- The people here \(alice, bob\)/);
  assert.match(text, /return an empty "message"; that is allowed, but it is not the default\.$/);
  assert.doesNotMatch(text, /nothing is the usual answer/);
  const bare = ContextUtils.spontaneousInstruction({ quietMinutes: 5 });
  assert.doesNotMatch(bare, /on your mind|came across|people here/);
  assert.match(bare, /- Your day/);
});

test("the current time line is the same in the system prompt and in formatNow", () => {
  const ctx = new ContextUtils(silent, persona, { timezone: "America/Chicago" });
  const now = new Date("2026-10-28T03:44:00Z");
  assert.equal(ctx.formatNow(now), "Tuesday, October 27, 2026 at 10:44 PM CDT");
  assert.match(ctx.buildInstructions(null, now), /CURRENT DATE\/TIME: Tuesday, October 27, 2026 at 10:44 PM CDT$/);
});
