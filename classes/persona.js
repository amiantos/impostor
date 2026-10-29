const fs = require("fs");
const { parseSchedule } = require("./schedule");
const { parseCalendar } = require("./calendar");

/**
 * A persona is a markdown file: the character under a top-level "# Name"
 * heading, an optional "## Evaluator" section describing them for the
 * should-I-speak model, and an optional "## Reactions" section saying how
 * they use IRCv3 reactions (what they react to, which emoji or short text,
 * how often), shown to both the evaluator and the reply model, and an
 * optional "## Schedule" section with their routine (see schedule.js), an
 * optional "## Seeds" list (things they would bring up unprompted into a
 * quiet channel; a few are drawn per day) and an optional "## News" list
 * (search queries for what they'd keep up with; one is looked up before
 * some unprompted turns), and an optional "## Calendar" list (dates that
 * mean something to them, see calendar.js; the prompts say which are today
 * or near). Everything about the medium (IRC, the chatlog, the JSON
 * protocol, tools) lives in code; the file holds only who the bot is.
 *
 * @param {string} text - The file's contents
 * @returns {{name: string, character: string, evaluator: string, reactions: string|null, schedule: Object|null, seeds: string[], news: string[], calendar: Array}}
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
  const reactions = (sections.get("reactions") || []).join("\n").trim();
  let schedule = null;
  try {
    schedule = parseSchedule((sections.get("schedule") || []).join("\n"));
  } catch (err) {
    throw new Error(`Persona "${name}": ${err.message}`);
  }
  const seeds = parseList(sections.get("seeds"));
  const news = parseList(sections.get("news"));
  let calendar = [];
  try {
    calendar = parseCalendar(sections.get("calendar"));
  } catch (err) {
    throw new Error(`Persona "${name}": ${err.message}`);
  }

  return {
    name,
    character: characterText,
    // Without its own section, the evaluator is told the whole character.
    evaluator: evaluator || characterText,
    // Without its own section, the prompts use generic guidance.
    reactions: reactions || null,
    // Without a section the bot is always around (afk still applies).
    schedule,
    // Without these, unprompted turns draw only on the day, the screen and the notes.
    seeds,
    news,
    // Without one, no date means anything in particular.
    calendar,
  };
}

/** The items of a bulleted section ("- item" or "* item"); blank lines and "#" comments are skipped. */
function parseList(lines) {
  const out = [];
  for (const raw of lines || []) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    out.push(line.replace(/^[-*]\s+/, ""));
  }
  return out;
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
