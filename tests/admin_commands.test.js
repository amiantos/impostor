const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseAdminCommand } = require("../classes/admin_commands");

test("parses !topic with multi-word args", () => {
  assert.deepEqual(parseAdminCommand("!topic Welcome to #amiantos"), {
    command: "topic",
    args: "Welcome to #amiantos",
  });
});

test("parses !op with no args", () => {
  assert.deepEqual(parseAdminCommand("!op"), { command: "op", args: "" });
});

test("parses !op with a target nick", () => {
  assert.deepEqual(parseAdminCommand("!op alice"), {
    command: "op",
    args: "alice",
  });
});

test("lowercases the command name", () => {
  assert.equal(parseAdminCommand("!TOPIC hello").command, "topic");
});

test("returns null for plain chat", () => {
  assert.equal(parseAdminCommand("hello world"), null);
  assert.equal(parseAdminCommand("just !excited"), null);
});

test("returns null for bare ! and !-only-with-whitespace", () => {
  assert.equal(parseAdminCommand("!"), null);
  assert.equal(parseAdminCommand("!   "), null);
});

test("returns null for empty or non-string input", () => {
  assert.equal(parseAdminCommand(""), null);
  assert.equal(parseAdminCommand(undefined), null);
  assert.equal(parseAdminCommand(null), null);
});

test("trims surrounding whitespace from args", () => {
  assert.deepEqual(parseAdminCommand("!topic    spaced out  "), {
    command: "topic",
    args: "spaced out",
  });
});

test("preserves internal whitespace in args", () => {
  assert.equal(parseAdminCommand("!topic a    b").args, "a    b");
});
