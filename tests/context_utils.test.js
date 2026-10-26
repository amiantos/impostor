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
  assert.equal(lines.length, 5, "two day dividers, three lines");
  assert.ok(lines[0].startsWith("--- "));
  assert.match(lines[1], /<amiantos> hi$/);
  assert.match(lines[2], /<Mabel \(you\)> hello$/);
  assert.ok(lines[3].startsWith("--- "));
  assert.match(lines[4], /<carol> yo$/);
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
