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

test("unwraps any listed relay tag, such as snitch's [libera] on irc.lurker.chat", () => {
  const result = parseBridgedMessage(
    "EyeBridge",
    "[libera] <bob> hi from libera",
    BRIDGE,
    ["Discord", "libera", "mansion"]
  );
  assert.deepEqual(result, { nick: "bob", message: "hi from libera", isWebhookAnnouncement: false });
});

test("a tag that is not listed is a webhook announcement even in envelope shape", () => {
  // GitHub announcements look like "[repo] <user> opened ...", so the tag
  // list is what separates a relayed human from an automated line.
  const result = parseBridgedMessage(
    "EyeBridge",
    "[lurker] <amiantos> opened PR #1: thing <https://example.com>",
    BRIDGE,
    ["Discord", "libera"]
  );
  assert.equal(result.nick, "EyeBridge");
  assert.equal(result.isWebhookAnnouncement, true);
});

test("tags match case-insensitively", () => {
  const result = parseBridgedMessage("EyeBridge", "[DISCORD] <eve> yo", BRIDGE, ["discord"]);
  assert.equal(result.nick, "eve");
});

test("without a bridge nick nothing is unwrapped", () => {
  const result = parseBridgedMessage("EyeBridge", "[Discord] <eve> yo", null);
  assert.deepEqual(result, { nick: "EyeBridge", message: "[Discord] <eve> yo", isWebhookAnnouncement: false });
});

test("a misconfigured bridge_tags value falls back to the default instead of throwing", () => {
  assert.equal(parseBridgedMessage("EyeBridge", "[Discord] <eve> yo", BRIDGE, "Discord").nick, "eve");
  assert.equal(parseBridgedMessage("EyeBridge", "[Discord] <eve> yo", BRIDGE, [42]).nick, "EyeBridge");
});
