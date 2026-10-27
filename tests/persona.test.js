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

test("a Reactions section is the bot's reaction style; none means the generic one", () => {
  const persona = parsePersona("# Bob\n\nYou are Bob.\n\n## Reactions\n\nonly 👍.\n\n- never 😂.\n");
  assert.equal(persona.reactions, "only 👍.\n\n- never 😂.");
  assert.equal(parsePersona("# Bob\n\nYou are Bob.\n").reactions, null);
  for (const file of ["isaac.md", "layla.md", "nightmare.md"]) {
    const shipped = loadPersona(path.join(__dirname, "..", "conf", "personas", file));
    assert.ok(shipped.reactions, `${file} has a Reactions section`);
    assert.doesNotMatch(shipped.character, /## /);
  }
  const nightmare = loadPersona(path.join(__dirname, "..", "conf", "personas", "nightmare.md"));
  assert.match(nightmare.reactions, /🖤/);
  assert.match(nightmare.evaluator, /RARELY REACTS/);
});

test("a Schedule section is parsed; none means no schedule", () => {
  const persona = parsePersona("# Bob\n\nYou are Bob.\n\n## Schedule\n\n# comment\naway 23:00-07:00 ~30m: asleep | zzz\n");
  assert.equal(persona.schedule.blocks.length, 1);
  assert.equal(persona.schedule.blocks[0].awayMessage, "zzz");
  assert.equal(parsePersona("# Bob\n\nYou are Bob.\n").schedule, null);
  assert.throws(() => parsePersona("# Bob\n\nYou are Bob.\n\n## Schedule\n\nnap 23:00-07:00: asleep\n"), /Persona "Bob": Schedule line 2/);
  const layla = loadPersona(path.join(__dirname, "..", "conf", "personas", "layla.md"));
  assert.ok(layla.schedule.blocks.some((b) => b.kind === "away" && b.activity === "asleep"));
  assert.ok(layla.schedule.blocks.some((b) => b.activity === "in class"));
  const isaac = loadPersona(path.join(__dirname, "..", "conf", "personas", "isaac.md"));
  assert.ok(isaac.schedule.blocks.every((b) => b.kind === "here"), "Isaac never goes away");
  const nightmare = loadPersona(path.join(__dirname, "..", "conf", "personas", "nightmare.md"));
  assert.ok(nightmare.schedule.blocks.some((b) => /grazing/.test(b.activity)));
});
