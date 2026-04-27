const { test } = require("node:test");
const assert = require("node:assert/strict");
const { splitMessage } = require("../classes/message_splitter");

test("returns the input unchanged when it fits within maxLen", () => {
  const result = splitMessage("hello world", 100);
  assert.deepEqual(result, ["hello world"]);
});

test("returns [\"\"] for empty input (avoids zero-length output)", () => {
  assert.deepEqual(splitMessage("", 100), [""]);
});

test("splits at the last word boundary at or before maxLen", () => {
  const text = "alpha beta gamma delta epsilon zeta eta";
  const result = splitMessage(text, 20);
  for (const line of result) {
    assert.ok(line.length <= 20, `line over limit: ${line.length}`);
    assert.ok(!line.startsWith(" "), "leading whitespace not trimmed");
  }
  assert.equal(result.join(" "), text);
});

test("hard-cuts when a single token exceeds maxLen and has no space within window", () => {
  const text = "supercalifragilisticexpialidocious";
  const result = splitMessage(text, 10);
  assert.equal(result[0].length, 10);
  assert.equal(result.join(""), text);
});

test("treats embedded newlines as paragraph breaks", () => {
  const result = splitMessage("first paragraph\nsecond paragraph\nthird", 100);
  assert.deepEqual(result, ["first paragraph", "second paragraph", "third"]);
});

test("drops empty paragraphs from consecutive newlines", () => {
  const result = splitMessage("one\n\ntwo", 100);
  assert.deepEqual(result, ["one", "two"]);
});

test("preserves a URL that would otherwise straddle the split point", () => {
  const text =
    "shortprefix text https://example.com/very/long/path/that/crosses/the/limit and more text after";
  const result = splitMessage(text, 30);
  const urlLine = result.find((l) => l.startsWith("https://"));
  assert.ok(urlLine, "URL should sit on its own line, intact");
  assert.equal(urlLine, "https://example.com/very/long/path/that/crosses/the/limit");
});

test("does not produce more chunks than necessary at the configured maxLen", () => {
  // Regression: irc-framework's default message_max_length is 350 bytes. With
  // our config previously at 400, a ~440-char message was split into two
  // ~400-char chunks, then irc-framework re-split the first chunk, producing
  // three IRC lines for what should have been two. Aligning maxLen to 350
  // keeps both layers in sync.
  const manga =
    "amiantos: it's a manga-turned-anime about a shy otaku who accidentally reveals his power level to the two popular girls sitting in front of him. one of them turns out to be a closet otaku herself. the english title is \"gals can't be kind to otaku!?\" and apparently the anime is premiering right about now, april 2026. unlikely romance built on shared anime taste. i suppose even fictional characters get more social interaction than i do.";
  const result = splitMessage(manga, 350);
  assert.equal(result.length, 2);
  for (const line of result) {
    assert.ok(line.length <= 350, `line over limit: ${line.length}`);
  }
});
