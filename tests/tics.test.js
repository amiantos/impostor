const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findTics, ticLedgerText, stripPrefix, tokens } = require("../classes/tics");

// A conversation in the shape of the real one: a pet name, a sign-off, a
// catchphrase, the same emoji at the end, and an order to close most lines.
const chatty = [
  "amiantos: lmaoo ok your secret's safe with me. no take backs 💀",
  "amiantos: sure blame the wifi 😭 it counts triple now, no take backs. go to sleep old man",
  "see this is the problem, you keep saying stuff like that. no take backs btw 💀",
  "amiantos: bet. you literally did this to yourself, go finish your code old man 💀",
  "amiantos: our secret little arc, love that for us. no take backs. now go to sleep",
  "amiantos: not a situationship? ok so what would you call it then 💀",
  "amiantos: secret online girlfriend?? no take backs though, this is legally binding now. go drink some water old man",
  "mostly rotting on my couch scrolling tiktok. wbu old man 😌",
  "amiantos: fresh out the shower and already in work mode. go clock in old man 💀",
  "look at you, doing actual work. just don't code yourself into a headache, go to sleep",
  "amiantos: ok and? i got distracted by the audacity. say it again old man 💀",
  "amiantos: go to sleep thennn, old man bedtime is calling. no take backs on checking it 😌",
  "soon, probably around 1ish. don't worry about me, go sleep old man 💀",
  "amiantos: psych major, third year. anyway don't tell the server, no take backs 💀",
  "amiantos: it's literally my whole brand at this point, no take backs on that either. now go to sleep old man 💀",
  "ok grandpa, make up your mind. what's keeping you up, me or the code?",
];

test("stripPrefix drops the IRC addressing prefix and tokens collapse stretched words", () => {
  assert.equal(stripPrefix("amiantos: hi there"), "hi there");
  assert.equal(stripPrefix("a clause: not a prefix"), "a clause: not a prefix", "only a bare nick before the colon counts");
  assert.deepEqual(tokens("amiantos: LMAOOO nooo, stoppp 💀 https://x.y/z it's fine"), ["lmao", "no", "stop", "it's", "fine"]);
});

test("findTics names the phrases, the emoji, and the line shapes a bot keeps leaning on", () => {
  const ledger = findTics(chatty, { reactions: ["💀", "💀", "😭", "💀", "💀", "🫶", "💀", "💀"] });
  assert.equal(ledger.lines, 16);
  const phrases = Object.fromEntries(ledger.phrases.map((p) => [p.text, p.count]));
  assert.deepEqual(phrases, { "old man": 9, "no take backs": 8, "go to sleep": 5 });
  assert.equal(phrases["take backs"], undefined, "a sub-phrase of a kept phrase is the same tic");
  assert.equal(phrases["sleep old man"], undefined, "a rarer phrase around a kept phrase is the same tic");
  assert.ok(!ledger.words.some((w) => w.text === "man"), "a word inside a kept phrase is the same tic");
  assert.deepEqual(ledger.emoji[0], { text: "💀", count: 9 });
  assert.deepEqual(ledger.ending, { count: 11, top: "💀" });
  assert.equal(ledger.closing, 8);
  assert.deepEqual(ledger.reaction, { text: "💀", count: 6, total: 8 });
  assert.equal(ledger.empty, false);

  const text = ticLedgerText(ledger);
  assert.match(text, /^SAY IT DIFFERENTLY: over your last 16 lines here you keep leaning on the same moves: "old man" \(9 of them\), "no take backs" \(8 of them\), "go to sleep" \(5 of them\), /);
  assert.match(text, /💀 \(9, and 11 lines end on an emoji\)/);
  assert.match(text, /ending by telling the other person what to do \(8 lines\)/);
  assert.match(text, /reacting with 💀 \(6 of your last 8 reactions\)/);
  assert.match(text, /Rest all of these for now\./);
});

test("too few lines, or varied ones, is no ledger", () => {
  assert.equal(findTics(chatty.slice(0, 5)), null);
  assert.equal(ticLedgerText(null), null);
  const varied = [
    "yeah that tracks",
    "amiantos: what did the dog do this time",
    "i have no idea what a vhost is and i'm at peace with that",
    "the bagel was fine. the cream cheese was a lie",
    "ok that's actually kind of sweet",
    "bob: did you ever finish that show",
    "class was long. the man talked for ninety minutes",
    "nooo not the withdrawal headache",
    "fair",
    "what are we doing about dinner",
  ];
  const ledger = findTics(varied);
  assert.equal(ledger.empty, true);
  assert.equal(ticLedgerText(ledger), null);
});

test("the same opener on many lines is a tic too, and the all-stopword n-grams are not", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `no bc why would you say that to me ${i}`);
  const ledger = findTics(lines);
  assert.ok(ledger.openers.some((o) => o.text === "no bc"), JSON.stringify(ledger.openers));
  assert.ok(!ledger.phrases.some((p) => p.text === "to me"), "stopword-only grams are skipped");
});
