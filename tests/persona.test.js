const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { parsePersona, loadPersona } = require("../classes/persona");

test("splits a persona into name, character and evaluator", () => {
  const persona = parsePersona(`# Mabel

You are Mabel, a cheerful bot.

- Likes tea.

## Evaluator

Mabel is cheerful and knows about tea.
`);
  assert.equal(persona.name, "Mabel");
  assert.equal(persona.character, "You are Mabel, a cheerful bot.\n\n- Likes tea.");
  assert.equal(persona.evaluator, "Mabel is cheerful and knows about tea.");
});

test("falls back to the character text when there is no Evaluator section", () => {
  const persona = parsePersona("# Bob\n\nYou are Bob.\n");
  assert.equal(persona.evaluator, "You are Bob.");
});

test("matches the Evaluator heading case-insensitively and ignores other sections", () => {
  const persona = parsePersona("# Bob\n\nYou are Bob.\n\n## Notes\n\nscratch\n\n## EVALUATOR\n\nBob is bob.\n");
  assert.equal(persona.character, "You are Bob.");
  assert.equal(persona.evaluator, "Bob is bob.");
});

test("requires a name heading and character text", () => {
  assert.throws(() => parsePersona("You are nobody."), /# Name/);
  assert.throws(() => parsePersona("# Ghost\n\n## Evaluator\n\nboo"), /no character text/);
});

test("the shipped Isaac persona loads and keeps his all-lowercase rule", () => {
  const isaac = loadPersona(path.join(__dirname, "..", "conf", "personas", "isaac.md"));
  assert.equal(isaac.name, "Isaac");
  assert.match(isaac.character, /Write in all lowercase/);
  assert.match(isaac.evaluator, /IRC IS NOT A TOPIC ISAAC KNOWS ABOUT/);
  // The character file owns who Isaac is, never the medium or the tools.
  assert.doesNotMatch(isaac.character, /needs_tool|remember tool|JSON/);
});

test("loadPersona names the missing file", () => {
  assert.throws(() => loadPersona("/nonexistent/persona.md"), /Cannot read persona file/);
});

test("a Reactions section gives the bot its own laugh pool; none means the stock pool", () => {
  const persona = parsePersona("# Bob\n\nYou are Bob.\n\n## Reactions\n\nha.\n\n  a grim chuckle.  \n");
  assert.deepEqual(persona.reactions, ["ha.", "a grim chuckle."]);
  assert.equal(parsePersona("# Bob\n\nYou are Bob.\n").reactions, null);
  const layla = loadPersona(path.join(__dirname, "..", "conf", "personas", "layla.md"));
  assert.ok(layla.reactions.includes("lmaooo"));
  const nightmare = loadPersona(path.join(__dirname, "..", "conf", "personas", "nightmare.md"));
  assert.equal(nightmare.name, "Nightmare");
  assert.deepEqual(nightmare.reactions, ["ha.", "a grim chuckle.", "hm. yes.", "...ha."]);
  assert.match(nightmare.evaluator, /RARELY REACTS/);
  assert.doesNotMatch(nightmare.character, /## /);
});
