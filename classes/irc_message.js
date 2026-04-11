const { v4: uuidv4 } = require("uuid");

/**
 * Create a normalized message object from an IRC event.
 * Matches the shape that MessageTracker, ContextUtils, and other
 * downstream code expect.
 *
 * @param {string} nick - IRC nick of the message author
 * @param {string} channel - IRC channel name (e.g. "#amiantos")
 * @param {string} text - Message content
 * @param {Object} options - Additional options
 * @param {string} options.ident - IRC ident (user) string
 * @param {string} options.hostname - IRC hostname
 * @param {boolean} options.isBot - Whether this message is from the bot itself
 * @returns {Object} Normalized message object
 */
function createIrcMessage(nick, channel, text, options = {}) {
  const { ident, hostname, isBot = false } = options;

  // Build a stable user ID from nick!ident@hostname if available
  const userId = ident && hostname
    ? `${nick.toLowerCase()}!${ident}@${hostname}`
    : nick.toLowerCase();

  return {
    id: uuidv4(),
    channel: {
      id: channel,
      name: channel.replace(/^#/, ""),
    },
    author: {
      id: userId,
      username: nick,
      bot: isBot,
    },
    content: text,
    createdAt: new Date(),
    attachments: new Map(),
    reference: null,
  };
}

module.exports = { createIrcMessage };
