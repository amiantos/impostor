const URL_REGEX = /https?:\/\/\S+/g;

function splitMessage(text, maxLen) {
  // IRC has no rendering distinction for paragraph breaks: each PRIVMSG is just
  // a line. Collapse all whitespace runs (including newlines the model sometimes
  // sprinkles mid-thought) into a single space, so length-based splitting can
  // never strand a fragment like "broken" on its own line.
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return [""];
  if (normalized.length <= maxLen) return [normalized];

  const lines = [];
  let remaining = normalized;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt === -1) splitAt = maxLen;

    const urlMatches = [...remaining.matchAll(URL_REGEX)];
    for (const match of urlMatches) {
      const urlStart = match.index;
      const urlEnd = urlStart + match[0].length;
      if (splitAt > urlStart && splitAt < urlEnd) {
        const beforeUrl = remaining.lastIndexOf(" ", urlStart);
        if (beforeUrl > 0) {
          splitAt = beforeUrl;
        } else if (urlEnd <= maxLen + 50) {
          splitAt = urlEnd;
        }
        break;
      }
    }

    lines.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}

module.exports = { splitMessage };

/**
 * Split for an IRCv3 draft/multiline batch: the pieces concatenate back to
 * the (whitespace-normalized) text exactly, so each piece after the first
 * is sent with draft/multiline-concat and the reader sees one message. Each
 * piece stays within both limits; the space at a split point stays at the
 * head of the next piece.
 * @param {string} text
 * @param {{maxChars?: number, maxBytes?: number}} [limits]
 * @returns {string[]}
 */
function splitForConcat(text, { maxChars = 350, maxBytes = 400 } = {}) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return [""];
  const fits = (s) => s.length <= maxChars && Buffer.byteLength(s, "utf8") <= maxBytes;
  if (fits(normalized)) return [normalized];

  const pieces = [];
  let remaining = normalized;
  while (!fits(remaining)) {
    // The longest prefix that fits, then back to the last space in it (not
    // the leading one, which is the previous split).
    let end = Math.min(remaining.length, maxChars);
    while (end > 1 && !fits(remaining.slice(0, end))) end -= 1;
    let splitAt = remaining.lastIndexOf(" ", end);
    if (splitAt <= 0) splitAt = end; // a token longer than the limit: hard cut
    pieces.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

module.exports.splitForConcat = splitForConcat;
