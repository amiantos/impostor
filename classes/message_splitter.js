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
