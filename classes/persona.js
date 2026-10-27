const fs = require("fs");

/**
 * A persona is a markdown file: the character under a top-level "# Name"
 * heading, an optional "## Evaluator" section describing them for the
 * should-I-speak model, and an optional "## Reactions" section, one short
 * laugh-reaction per line, used when the evaluator picks "react". Everything
 * about the medium (IRC, the chatlog, the JSON protocol, tools) lives in
 * code; the file holds only who the bot is.
 *
 * @param {string} text - The file's contents
 * @returns {{name: string, character: string, evaluator: string, reactions: string[]|null}}
 */
function parsePersona(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");

  let name = null;
  const sections = new Map(); // lowercased "## heading" -> lines
  let current = []; // lines before any "## " heading = the character
  const character = current;

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    if (h1 && name === null) {
      name = h1[1];
      continue;
    }
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      current = [];
      sections.set(h2[1].toLowerCase(), current);
      continue;
    }
    current.push(line);
  }

  if (!name) {
    throw new Error('Persona file needs a "# Name" heading on its first heading line');
  }
  const characterText = character.join("\n").trim();
  if (!characterText) {
    throw new Error(`Persona "${name}" has no character text under its heading`);
  }
  const evaluator = (sections.get("evaluator") || []).join("\n").trim();
  const reactions = (sections.get("reactions") || [])
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("<!--"));

  return {
    name,
    character: characterText,
    // Without its own section, the evaluator is told the whole character.
    evaluator: evaluator || characterText,
    // Without its own section, the bot uses the stock pool.
    reactions: reactions.length > 0 ? reactions : null,
  };
}

function loadPersona(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`Cannot read persona file ${filePath}: ${err.message}`);
  }
  return parsePersona(text);
}

module.exports = { parsePersona, loadPersona };
