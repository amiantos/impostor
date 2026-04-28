// Parses an EyeBridge admin command (a channel message beginning with "!").
// Returns { command, args } with the command lowercased, or null if the input
// isn't a recognizable command. Authorization and dispatch are handled by the
// caller — this module is intentionally pure so it can be unit-tested without
// an IRC client.

function parseAdminCommand(text) {
  if (typeof text !== "string" || text.length === 0 || text[0] !== "!") {
    return null;
  }

  const match = text.slice(1).match(/^([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  return {
    command: match[1].toLowerCase(),
    args: (match[2] || "").trim(),
  };
}

module.exports = { parseAdminCommand };
