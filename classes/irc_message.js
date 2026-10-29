const { v4: uuidv4 } = require("uuid");

/**
 * The stable author id for an IRC user: nick!ident@hostname when the
 * hostmask is known, the lowercased nick otherwise.
 */
function ircUserId(nick, ident, hostname) {
  return ident && hostname
    ? `${nick.toLowerCase()}!${ident}@${hostname}`
    : nick.toLowerCase();
}

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
 * @param {Date} [options.createdAt] - When it was sent; now by default
 * @returns {Object} Normalized message object
 */
function createIrcMessage(nick, channel, text, options = {}) {
  const { ident, hostname, isBot = false, createdAt = null } = options;

  const userId = ircUserId(nick, ident, hostname);

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
    createdAt: createdAt || new Date(),
    attachments: new Map(),
    reference: null,
  };
}

module.exports = { createIrcMessage, ircUserId };
