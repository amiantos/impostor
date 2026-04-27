// Parses an incoming IRC message to recognize traffic from the bridge bot
// (typically nicked "EyeBridge"). Bridged Discord humans are unwrapped so the
// rest of the system sees the real username. Webhook announcements (GitHub,
// Discourse) come from the same bridge nick but lack the [discord] prefix and
// are flagged so callers can opt out of expensive per-URL processing.
//
// The bridge-nick check guards against spoofing — a regular user typing
// "[discord] <admin> ..." should never have their nick rewritten.

const BRIDGE_DISCORD_RE = /^\[discord\] <([^>]+)> ([\s\S]*)$/;

function parseBridgedMessage(eventNick, eventMessage, bridgeNick) {
  const fromBridge = eventNick.toLowerCase() === bridgeNick.toLowerCase();
  const bridgeMatch = fromBridge ? eventMessage.match(BRIDGE_DISCORD_RE) : null;

  if (bridgeMatch) {
    return {
      nick: bridgeMatch[1],
      message: bridgeMatch[2],
      isWebhookAnnouncement: false,
    };
  }

  return {
    nick: eventNick,
    message: eventMessage,
    isWebhookAnnouncement: fromBridge,
  };
}

module.exports = { parseBridgedMessage };
