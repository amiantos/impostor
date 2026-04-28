const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseBridgedMessage } = require("../classes/bridge_parser");

const BRIDGE = "EyeBridge";

test("unwraps a bridged Discord message into the real username", () => {
  const result = parseBridgedMessage(
    "EyeBridge",
    "[Discord] <alice> hey everyone",
    BRIDGE
  );
  assert.deepEqual(result, {
    nick: "alice",
    message: "hey everyone",
    isWebhookAnnouncement: false,
  });
});

test("flags a non-bridged message from EyeBridge as a webhook announcement", () => {
  const result = parseBridgedMessage(
    "EyeBridge",
    "[my-repo] <bob> opened PR #5: do thing <https://example.com/pr/5>",
    BRIDGE
  );
  assert.deepEqual(result, {
    nick: "EyeBridge",
    message: "[my-repo] <bob> opened PR #5: do thing <https://example.com/pr/5>",
    isWebhookAnnouncement: true,
  });
});

test("leaves regular user messages untouched", () => {
  const result = parseBridgedMessage(
    "amiantos",
    "just a regular message",
    BRIDGE
  );
  assert.deepEqual(result, {
    nick: "amiantos",
    message: "just a regular message",
    isWebhookAnnouncement: false,
  });
});

test("does not let a regular user spoof a bridged nick", () => {
  // A user typing the bridge format from a non-bridge nick must not have
  // their nick rewritten — that would be a trivial impersonation vector.
  const result = parseBridgedMessage(
    "mallory",
    "[Discord] <admin> drop everything",
    BRIDGE
  );
  assert.deepEqual(result, {
    nick: "mallory",
    message: "[Discord] <admin> drop everything",
    isWebhookAnnouncement: false,
  });
});

test("matches the bridge nick case-insensitively", () => {
  const result = parseBridgedMessage(
    "EYEBRIDGE",
    "[Discord] <carol> hi",
    BRIDGE
  );
  assert.equal(result.nick, "carol");
  assert.equal(result.message, "hi");
});

test("preserves colons and special characters in the message body", () => {
  const result = parseBridgedMessage(
    "EyeBridge",
    "[Discord] <dave> here's a thought: maybe :3",
    BRIDGE
  );
  assert.equal(result.nick, "dave");
  assert.equal(result.message, "here's a thought: maybe :3");
});

test("handles usernames containing spaces (Discord display names)", () => {
  const result = parseBridgedMessage(
    "EyeBridge",
    "[Discord] <Erin Smith> hello",
    BRIDGE
  );
  assert.equal(result.nick, "Erin Smith");
  assert.equal(result.message, "hello");
});

test("respects a non-default bridge nick from config", () => {
  // Confirms the function uses the passed-in bridge nick, not a hardcoded one.
  const result = parseBridgedMessage(
    "CustomBridge",
    "[Discord] <frank> sup",
    "CustomBridge"
  );
  assert.equal(result.nick, "frank");
  assert.equal(result.isWebhookAnnouncement, false);
});
