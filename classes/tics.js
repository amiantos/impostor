/**
 * The tic ledger: what a bot has been saying too much lately, worked out
 * from its own recent lines in one conversation.
 *
 * A model at temperature continues whatever pattern is in front of it, and
 * half of a DM screen is the bot's own lines, so a pet name or a sign-off it
 * used three times becomes the thing it says every time. Telling it "don't
 * repeat yourself" does little; telling it exactly which phrases, emoji and
 * line shapes it has been leaning on works. This module finds those:
 *
 *  - phrases (2 to 4 words) that recur across many lines, longest kept,
 *    their sub-phrases dropped;
 *  - single words that recur in a large share of lines;
 *  - emoji that recur, and whether most lines end on one;
 *  - the same opening word(s) on many lines;
 *  - lines that end by telling the other person what to do;
 *  - the bot's recent reactions being mostly one thing.
 *
 * `findTics` is pure and returns the ledger; `ticLedgerText` renders it as
 * the prompt block, or null when nothing is worth saying.
 */

const STOPWORDS = new Set(
  (
    "a an the and or but so if then than that this these those there here of to in on at by for from with " +
    "about as into like through after over between out against during without before under around among " +
    "is am are was were be been being have has had do does did doing will would shall should can could may " +
    "might must i me my mine you your yours u ur he him his she her hers it its we us our ours they them their " +
    "theirs what which who whom whose when where why how all any both each few more most other some such no nor " +
    "not only own same too very just also still yet even ever again once now im i'm ive i've dont don't cant " +
    "can't wont won't isnt isn't aint ain't gonna wanna gotta kinda sorta lol lmao ok okay oh ah um uh yeah yes nah " +
    "no yep nope and/or rn tho though bc because cause cuz cos get got go going went let lets let's one thing things " +
    "way really actually literally basically honestly pretty much many lot bit"
  ).split(/\s+/)
);

/** Verbs a line ends on when it is telling the other person what to do. */
const IMPERATIVES = /^(?:now |just |ok |okay |pls |please )*(?:go|get|drink|eat|finish|focus|sleep|stop|tell|try|come|make|leave|take|put|send|do not|don't|dont|be|stay|keep|log|clock|text|call|check|give|answer|say|read|look|close|open)\b/;

const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu;

/** Lowercase words with runs of a letter collapsed ("lmaooo" -> "lmao"), urls and the nick prefix dropped. */
function tokens(line) {
  return stripPrefix(line)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(EMOJI, " ")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/(\p{L})\1{2,}/gu, "$1")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** "amiantos: hi" -> "hi": the IRC addressing prefix is not a phrase. */
function stripPrefix(line) {
  return String(line || "").replace(/^\s*[A-Za-z0-9_\-[\]\\`^{}|]+:\s+/, "").trim();
}

function ngrams(words, n) {
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) {
    const gram = words.slice(i, i + n);
    if (gram.every((w) => STOPWORDS.has(w) || /^\d+$/.test(w))) continue;
    out.add(gram.join(" "));
  }
  return out;
}

/**
 * @param {string[]} lines - The bot's own recent lines in one conversation, oldest first
 * @param {Object} [options]
 * @param {string[]} [options.reactions] - The bot's recent reactions there, newest first
 * @param {number} [options.minLines=8] - Fewer lines than this is no evidence of anything
 * @returns {Object|null} The ledger, or null when there is too little to go on
 */
function findTics(lines, { reactions = [], minLines = 8 } = {}) {
  const clean = (lines || []).map((l) => stripPrefix(l)).filter((l) => l.length > 0);
  const n = clean.length;
  if (n < minLines) return null;
  const perLine = clean.map(tokens);

  // Phrases: in how many lines does each 2-4 gram occur.
  const phraseMin = Math.max(3, Math.round(n * 0.15));
  const counts = new Map(); // gram -> line count
  for (const words of perLine) {
    const seen = new Set();
    for (const len of [4, 3, 2]) for (const g of ngrams(words, len)) seen.add(g);
    for (const g of seen) counts.set(g, (counts.get(g) || 0) + 1);
  }
  const phrases = [];
  const candidates = [...counts.entries()]
    .filter(([, c]) => c >= phraseMin)
    .sort((a, b) => b[0].split(" ").length - a[0].split(" ").length || b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [text, count] of candidates) {
    // A sub-phrase of something already kept, said about as often, is the same tic.
    const covered = phrases.some((p) => ` ${p.text} `.includes(` ${text} `) && count <= p.count + 1);
    if (!covered) phrases.push({ text, count });
  }
  // And the other way round: "sleep old man" (3) beside "old man" (9) is
  // just "old man" with a word in front of it some of the time.
  const trimmed = phrases.filter(
    (p) => !phrases.some((q) => q !== p && q.count > p.count && ` ${p.text} `.includes(` ${q.text} `))
  );
  phrases.length = 0;
  phrases.push(...trimmed);
  phrases.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));

  // Single words in a large share of lines.
  const wordMin = Math.max(5, Math.round(n * 0.35));
  const wordCounts = new Map();
  for (const words of perLine) {
    for (const w of new Set(words)) {
      if (STOPWORDS.has(w) || w.length < 3 || /^\d+$/.test(w)) continue;
      wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
    }
  }
  const words = [...wordCounts.entries()]
    .filter(([w, c]) => c >= wordMin && !phrases.some((p) => ` ${p.text} `.includes(` ${w} `) && c <= p.count + 1))
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));

  // Emoji: which recur, and how many lines end on one.
  const emojiMin = Math.max(3, Math.round(n * 0.2));
  const emojiCounts = new Map();
  let endsOnEmoji = 0;
  const endingEmoji = new Map();
  for (const line of clean) {
    const found = line.match(EMOJI) || [];
    for (const e of new Set(found)) emojiCounts.set(e, (emojiCounts.get(e) || 0) + 1);
    const tail = line.trim().match(new RegExp(`(${EMOJI.source})\\s*$`, "u"));
    if (tail) {
      endsOnEmoji++;
      endingEmoji.set(tail[1], (endingEmoji.get(tail[1]) || 0) + 1);
    }
  }
  const emoji = [...emojiCounts.entries()]
    .filter(([, c]) => c >= emojiMin)
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count);
  const topEnding = [...endingEmoji.entries()].sort((a, b) => b[1] - a[1])[0];
  const ending =
    endsOnEmoji >= Math.max(4, Math.round(n * 0.4)) ? { count: endsOnEmoji, top: topEnding ? topEnding[0] : null } : null;

  // Openers: the same first word or two on many lines.
  const openerMin = Math.max(3, Math.round(n * 0.25));
  const firsts = new Map();
  const firstPairs = new Map();
  for (const w of perLine) {
    if (w.length === 0) continue;
    firsts.set(w[0], (firsts.get(w[0]) || 0) + 1);
    if (w.length > 1) firstPairs.set(`${w[0]} ${w[1]}`, (firstPairs.get(`${w[0]} ${w[1]}`) || 0) + 1);
  }
  const openers = [];
  for (const [text, count] of [...firstPairs.entries()].sort((a, b) => b[1] - a[1])) {
    if (count >= openerMin) openers.push({ text, count });
  }
  for (const [text, count] of [...firsts.entries()].sort((a, b) => b[1] - a[1])) {
    if (count >= openerMin && !openers.some((o) => o.text.startsWith(`${text} `) && count <= o.count + 1)) {
      openers.push({ text, count });
    }
  }

  // Closers: lines whose last sentence is an order to the other person.
  let closers = 0;
  for (const line of clean) {
    const sentences = line
      .replace(EMOJI, " ")
      .split(/[.!?\n]+|,\s+(?=(?:now|just|ok|okay)\s)/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const last = sentences[sentences.length - 1];
    if (last && IMPERATIVES.test(last)) closers++;
  }
  const closing = closers >= Math.max(4, Math.round(n * 0.35)) ? closers : 0;

  // Reactions: mostly the same one.
  let reaction = null;
  const recent = (reactions || []).filter(Boolean).slice(0, 10);
  if (recent.length >= 6) {
    const tally = new Map();
    for (const r of recent) tally.set(r, (tally.get(r) || 0) + 1);
    const [top, count] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (count >= Math.ceil(recent.length / 2)) reaction = { text: top, count, total: recent.length };
  }

  const ledger = { lines: n, phrases, words, emoji, ending, openers, closing, reaction };
  ledger.empty = phrases.length + words.length + emoji.length + openers.length === 0 && !ending && !closing && !reaction;
  return ledger;
}

/**
 * The ledger as the prompt block, or null when there is nothing to say.
 * @param {Object|null} ledger - From findTics
 * @param {number} [maxItems=8] - At most this many named tics
 */
function ticLedgerText(ledger, maxItems = 8) {
  if (!ledger || ledger.empty) return null;
  const items = [];
  const named = [...ledger.phrases, ...ledger.words].slice(0, maxItems);
  for (const p of named) items.push(`"${p.text}" (${p.count} of them)`);
  for (const e of ledger.emoji.slice(0, 2)) {
    if (ledger.ending && ledger.ending.top === e.text) {
      items.push(`${e.text} (${e.count}, and ${ledger.ending.count} lines end on an emoji)`);
    } else {
      items.push(`${e.text} (${e.count})`);
    }
  }
  if (ledger.ending && !ledger.emoji.some((e) => e.text === ledger.ending.top)) {
    items.push(`ending on an emoji (${ledger.ending.count} lines)`);
  }
  for (const o of ledger.openers.slice(0, 2)) items.push(`opening with "${o.text}" (${o.count})`);
  if (ledger.closing) items.push(`ending by telling the other person what to do (${ledger.closing} lines)`);
  if (ledger.reaction) items.push(`reacting with ${ledger.reaction.text} (${ledger.reaction.count} of your last ${ledger.reaction.total} reactions)`);
  if (items.length === 0) return null;
  return (
    `SAY IT DIFFERENTLY: over your last ${ledger.lines} lines here you keep leaning on the same moves: ${items.join(", ")}. ` +
    `Rest all of these for now. Don't swap in a new catchphrase for them; just say what you'd say without the bit. ` +
    `A running joke gets one callback and then it's retired, and a line doesn't have to end the way your last one did.`
  );
}

module.exports = { findTics, ticLedgerText, stripPrefix, tokens };
