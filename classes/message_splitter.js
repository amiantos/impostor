const URL_REGEX = /https?:\/\/\S+/g;

function splitMessage(text, maxLen) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) continue;
    if (paragraph.length <= maxLen) {
      lines.push(paragraph);
      continue;
    }

    let remaining = paragraph;
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
  }
  return lines.length > 0 ? lines : [""];
}

module.exports = { splitMessage };
