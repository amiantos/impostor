const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatPost,
  stripPostContent,
  truncateByBytes,
} = require("../classes/discourse_webhook");

// --- truncateByBytes ---

test("truncateByBytes: returns the input unchanged when already short enough", () => {
  assert.equal(truncateByBytes("hello", 100), "hello");
});

test("truncateByBytes: cuts at the requested byte budget", () => {
  const result = truncateByBytes("abcdefghij", 5);
  assert.equal(result, "abcde");
});

test("truncateByBytes: respects multibyte characters (utf-8, not chars)", () => {
  // Each emoji is 4 bytes. With a 5-byte budget we can fit one but not two.
  const text = "🍕🍕🍕";
  const result = truncateByBytes(text, 5);
  assert.equal(Buffer.byteLength(result, "utf8") <= 5, true);
  assert.equal(result, "🍕");
});

// --- stripPostContent ---

test("stripPostContent: removes triple-backtick code blocks", () => {
  const result = stripPostContent("before\n```\ncode here\n```\nafter");
  assert.match(result, /before/);
  assert.match(result, /after/);
  assert.doesNotMatch(result, /code here/);
});

test("stripPostContent: collapses inline code spans", () => {
  const result = stripPostContent("see `the docs` for details");
  assert.doesNotMatch(result, /`/);
  assert.match(result, /see/);
  assert.match(result, /details/);
});

test("stripPostContent: strips images entirely but keeps link text", () => {
  const result = stripPostContent("![alt text](https://img/x.png) and [click here](https://example.com)");
  assert.doesNotMatch(result, /alt text/);
  assert.doesNotMatch(result, /\(/);
  assert.match(result, /click here/);
});

test("stripPostContent: preserves bare URLs through markdown cleanup", () => {
  // Regression: the cleanup pass replaces *_~#> chars with spaces. URLs must
  // be tokenised before that pass and restored afterwards or they get mangled.
  const result = stripPostContent("see https://example.com/path_with_underscores for more");
  assert.match(result, /https:\/\/example\.com\/path_with_underscores/);
});

test("stripPostContent: drops blockquote lines", () => {
  const result = stripPostContent("> quoted thing\nactual content");
  assert.doesNotMatch(result, /quoted/);
  assert.match(result, /actual content/);
});

// --- formatPost ---

const basePost = (overrides = {}) => ({
  post: {
    username: "alice",
    topic_title: "thoughts on isaac",
    topic_slug: "thoughts-on-isaac",
    topic_id: 17,
    post_number: 3,
    raw: "this is a fairly short forum post",
    ...overrides,
  },
});

test("formatPost: builds '[title] <user> body <url>' shape", () => {
  const result = formatPost(
    basePost(),
    "https://forum.example.com",
    350
  );
  assert.equal(
    result,
    "[thoughts on isaac] <alice> this is a fairly short forum post <https://forum.example.com/t/thoughts-on-isaac/17/3>"
  );
});

test("formatPost: trims trailing slash on the base URL", () => {
  const result = formatPost(basePost(), "https://forum.example.com///", 350);
  assert.match(result, /<https:\/\/forum\.example\.com\/t\//);
  assert.doesNotMatch(result, /\.com\/\/\/t\//);
});

test("formatPost: truncates the body and appends ... when over budget", () => {
  const long = "x".repeat(2000);
  const result = formatPost(basePost({ raw: long }), "https://f.example", 350);
  assert.ok(result.endsWith(" <https://f.example/t/thoughts-on-isaac/17/3>"));
  assert.ok(result.includes("..."));
  assert.ok(
    Buffer.byteLength(result, "utf8") <= 350,
    `payload exceeded 350 bytes: ${Buffer.byteLength(result, "utf8")}`
  );
});

test("formatPost: returns null when payload has no post field", () => {
  assert.equal(formatPost({}, "https://f.example", 350), null);
});

test("formatPost: output begins with [title] <user> so the bridge parser tags it as a webhook", () => {
  // Regression guard: as with GitHub, the leading tag must not be [discord].
  const result = formatPost(basePost(), "https://f.example", 350);
  assert.match(result, /^\[[^\]]+\] <[^>]+> /);
  assert.doesNotMatch(result, /^\[discord\] /);
});
