// Parses an incoming IRC message to recognize traffic from the bridge bot
// (snitch, typically nicked "EyeBridge"). Bridged humans arrive as
// "[Tag] <nick> text", where Tag names where they are chatting from
// (Discord, libera, mansion, ...); they are unwrapped so the rest of the
// system sees the real person. Webhook announcements (GitHub, Discourse)
// come from the same bridge nick in the same shape, "[repo-name] <user>
// opened ...", so only tags listed in `bridgeTags` count as humans; every
// other line from the bridge nick is flagged as an announcement.
//
// The bridge-nick check guards against spoofing — a regular user typing
// "[Discord] <admin> ..." should never have their nick rewritten.

const ENVELOPE_RE = /^\[([^\]\s]+)\] <([^>]+)> ([\s\S]*)$/;
const DEFAULT_TAGS = ["Discord"];

function parseBridgedMessage(eventNick, eventMessage, bridgeNick, bridgeTags = DEFAULT_TAGS) {
  const fromBridge =
    Boolean(bridgeNick) && eventNick.toLowerCase() === bridgeNick.toLowerCase();
  const match = fromBridge ? eventMessage.match(ENVELOPE_RE) : null;
  const tags = (bridgeTags && bridgeTags.length > 0 ? bridgeTags : DEFAULT_TAGS).map((t) =>
    t.toLowerCase()
  );

  if (match && tags.includes(match[1].toLowerCase())) {
    return {
      nick: match[2],
      message: match[3],
      isWebhookAnnouncement: false,
    };
  }

  return {
    nick: eventNick,
    message: eventMessage,
    isWebhookAnnouncement: fromBridge,
  };
}

module.exports = { parseBridgedMessage, DEFAULT_TAGS };
