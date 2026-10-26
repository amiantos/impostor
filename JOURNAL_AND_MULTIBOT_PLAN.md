# Impostor revival: journals and many bots

> Written 2026-10-26. Target network: irc.lurker.chat (see `~/Coding/lurker-dev/IRC_SERVER_PLAN.md`).
> Two changes, one PR: replace the memory system, run several bots from one process.

## What's wrong today

- **Memory only exists if the model remembers to call a tool mid-reply.** `remember` is one of
  four tools in the reply JSON. The model is busy answering, so most things worth keeping never
  get stored. Facts are appended one row at a time (`user_memories`), keyed by nick, never
  revised, never summarized, and shown as a flat bullet list. Nothing captures *what has been
  going on* in a channel; only the last ~50 lines of chatlog do, and `filterByConversationGaps`
  drops everything before a 30-minute gap.
- **The prompt is Isaac in three places.** `ContextUtils.system_prompt` (character, voice, IRC
  mechanics, tool protocol, all in one string), `ResponseEvaluator.buildDecisionPrompt` (a second
  description of who he is and what he knows), and `irc.watchword`. A second character means
  copying all of it.
- **One bot per process, per config, per database.** `ImpostorClient` owns the IRC connection,
  the DB at `data/impostor.db`, the tools and the OpenAI client. The dashboard assumes one bot.
- The bridge parser only unwraps `[Discord] <nick> text`. snitch on irc.lurker.chat renders
  `[libera] <nick> text` and `[mansion] <nick> text` too.

## Part 1: the journal

Borrowed from writers-guild: a **Continuity** is one short prose account of what's true, rewritten
whole by the **Archivist** with each new development worked in, condensed when long, every version
kept. Here the Continuity is the bot's own journal, and the Archivist is a background pass over
the chatlog rather than something the reply model has to think about.

### Two documents, one pass

1. **Journal**, one per bot per conversation (a channel or a DM partner). First person, in the
   bot's voice: what has been going on here lately, what's unresolved, what it said it would do.
   Short: the Archivist is told to keep it under about 1,500 characters and to condense the
   older part as it grows. This is the "inner short-term memory".
2. **People**, one note per nick per bot, shared across that bot's conversations. Who they are,
   what they like, how the bot gets on with them. The card-Archivist analog: facts that would be
   true in any conversation, not what happened in this one. Kept under about 600 characters each.

One Archivist call reads the previous journal, the current notes for the nicks present, and the
stretch of chatlog since the last pass (the bot's own lines tagged `(you)`), and answers:

```json
{"journal": "the whole journal, rewritten", "people": {"amiantos": "the whole note, rewritten"}, "rationale": "one sentence"}
```

`journal: null` means nothing worth carrying forward; a nick missing from `people` means its note
is unchanged. The parser is lenient the way `parseContinuity` is (strips think blocks and fences,
takes the outer braces). An answer that is not JSON is asked for once more, then dropped; the
watermark does not move, so the next pass reads the same stretch again.

### When it runs

Per conversation, whichever comes first:

- **40 new messages** since the watermark, or
- **20 minutes of quiet** after the newest message, with at least 5 new messages.

The watermark is the `created_at` of the last message the pass read, stored with the journal, so a
restart picks up where it left off; nothing is lost because the messages are already in SQLite.
A long backlog (the bot was down for a day) is read in passes of at most 200 messages, each one
rewriting the journal the previous pass produced, like `runContinuityArchivist`.

The pass runs off the reply path: it never delays a reply and a reply never waits for it. One
pass per conversation at a time; a trigger that fires mid-pass is queued, not dropped.

### What the reply model sees

Replaces the `YOUR MEMORIES ABOUT USERS IN THIS CONVERSATION` bullet block:

```
--- YOUR JOURNAL FOR #lurker ---
<journal text>
--- PEOPLE ---
amiantos: <note>
bob: <note>
--- RECENT CONVERSATION ---
<chatlog as today>
```

Only people present in the chatlog window get their note shown. The evaluator gets the journal
too (one paragraph is cheap and it is the thing that stops "he answered that yesterday").

### Storage

Per bot, in that bot's own database:

```
journals          (conversation_id PK, content, watermark_at, updated_at)
journal_versions  (id, conversation_id, content, rationale, created_at)
people            (nick PK, content, updated_at)
people_versions   (id, nick, content, rationale, created_at)
```

Versions are the debugging surface: the dashboard shows a journal's history and the rationale per
pass, like a Continuity's History tab. No restore button to start with; delete and edit, yes.

### What goes away

- The `remember` tool, its category enum, its validation, the `user_memories` table, the
  `/users` and `/memories` dashboard routes and the memories view. The reply JSON keeps
  `python`, `web_search`, `web_fetch`.
- The "your only persistent memory is the remember tool" paragraph in the character prompt.

## Part 2: many bots

### Config

`conf/config.json` holds what is shared; each bot is an entry in `bots`:

```json
{
  "generator": { "deepseek": { "api_key": "...", "model": "deepseek-flash", "...": "" } },
  "kagi": { "api_key": "..." },
  "web": { "enabled": true, "port": 3000, "auth": { "...": "" } },
  "irc": { "host": "irc.lurker.chat", "port": 6697, "tls": true, "bridge_nick": "EyeBridge" },
  "bots": [
    {
      "id": "isaac",
      "nick": "Isaac",
      "account": { "name": "Isaac", "password": "..." },
      "persona": "conf/personas/isaac.md",
      "channels": ["#lurker"],
      "pm_allowed_users": ["amiantos"],
      "generator": { "temperature": 0.9 },
      "autonomous": { "cooldown_seconds": 45 }
    }
  ]
}
```

Any key under a bot's `irc`, `generator`, `autonomous` or `url_summarize` overrides the shared
one. `id` names the bot's data directory and its dashboard tab; `nick` is what it is on IRC.

### Personas

One markdown file per character, two sections:

```markdown
# Isaac

<the character: who they are, disposition, interests, aversions, voice and style quirks such as
all-lowercase. Everything that is Isaac and nothing that is IRC.>

## Evaluator

<two or three paragraphs: who this is and what they do and don't know about, for the
should-I-speak model. Today's "melancholic, thoughtful chatbot ... programming, classic sci-fi"
paragraph, minus the generic rules.>
```

Code owns **the medium**: the chatlog format and how to read it, the `(you)` tag, the relay-bot
envelope, the JSON reply protocol, the tool list and guidance, "no markdown, one block, the
system splits lines", the `nick:` addressing convention, the journal and people blocks, the
date/time footer. `ContextUtils.buildInstructions()` becomes persona + medium; the evaluator's
prompt becomes its generic rules + the persona's Evaluator section. The Isaac text moves out of
`context_utils.js` and `response_evaluator.js` into `conf/personas/isaac.md` without changing a
word, so his behavior is unchanged. `conf/personas/` is committed (personas are not secrets);
`conf/config.json` stays gitignored.

### Process model

One process, one `ImpostorClient` per bot entry, each with its own IRC connection, its own
`DatabaseManager` at `data/<id>/impostor.db`, its own `MessageTracker`, evaluator, queue, typing
timers and Archivist. Tools (`PythonTool`, `WebSearchTool`, `WebFetchTool`), the OpenAI client
and the `Logger` are built once and shared; the logger prefixes lines with the bot id. `index.js`
reads `bots`, builds each client, connects them, and the one dashboard gets a bot picker.

Why one process: one `npm start`, one container, one port, one dashboard. The bots are idle
event loops; nothing here needs isolation that a separate SQLite file doesn't give.

Each bot stores its own copy of the channel log. That is duplication across bots and it is
correct: each bot's journal is its own reading of the room, and a bot removed from a channel
loses nothing of the others'.

### Bots hearing bots

No special handling. A line from another bot is a line like any other: the same cooldown and
ratio gates on the unaddressed path, the same evaluator on the addressed one. Two bots talking
should wind down because their personas and the evaluator's "one turn per thought" rule say so,
not because a rule about bots says so. If a loop shows up on the live server it is a prompt fix.
(Decided 2026-10-26; the earlier draft proposed a bots-share-the-ratio rule.)

### Accounts on irc.lurker.chat

Each bot is its own NickServ account, SASL PLAIN as today. Registration there needs email
verification; an oper with the `accreg` capability registers on a bot's behalf with
`/msg NickServ SAREGISTER <username> [password]` (checked against Ergo's `irc/nickserv.go`).
Brad does this once per bot and puts the password in its `account` block. The bot sets `+B` on
itself after registration.

### Bridge envelope

`parseBridgedMessage` generalizes from `^\[Discord\] <nick> text` to `^\[(\w+)\] <nick> text` for
any tag, still only when the line comes from a listed bridge nick, so `[libera] <bob> hi` on
irc.lurker.chat addresses bob. Lines from the bridge nick without a `<nick>` envelope are still
webhook announcements. Bridged humans are humans: they can address a bot. The prompt's
"THE EYEBRIDGE BOT" section becomes a generic relay-bot section in the medium prompt.

### Dashboard

A bot picker in the header; every API route takes `?bot=<id>` and reads that bot's DB (the
`req.db` middleware resolves it). The memories view becomes Journals (per conversation, with
history and rationale) and People (per nick, editable, deletable). Everything else is unchanged.

## Build order

Foundation first, behavior last, one PR off `main`.

1. **Persona split.** Move Isaac's text to `conf/personas/isaac.md`; code owns the medium. Prompt
   output byte-identical for Isaac before and after (a test pins it against the old string).
2. **Many bots.** `bots` config, per-bot client, per-bot DB directory, shared tools, bot picker
   in the dashboard. Bridge envelope generalized, with tests. The old single-bot config shape is not
   supported; `config.json.example` is rewritten.
3. **Journal.** Tables, the Archivist pass (prompt builder, lenient parser, watermark, backlog
   chunking, the two triggers), the prompt blocks, the dashboard views. Remove the `remember`
   tool and `user_memories`.
4. **Point it at irc.lurker.chat.** Config, `+B`, README and CLAUDE.md rewritten for the new
   shape.

Tests run with `node --test`. Pure parts get unit tests: persona loading and prompt assembly,
the Archivist prompt and parser, the watermark and trigger logic (time injected, not slept), the
address classifier with bot lines, the bridge parser. The IRC and DeepSeek edges are not tested
here; Brad QAs against the live server with two bots in one channel.

## Decided 2026-10-26

1. **No bot-on-bot rules.** Personas and the evaluator prompt are the brake.
2. **The journal is per conversation; people notes are per bot across conversations.** The DM
   journal stays out of the channel prompt and the other way round.

## Not in this PR

- Switching providers. DeepSeek through the `openai` client stays; the model and temperature are
  per bot already.
- Restoring a journal version from the dashboard.
- Tagging lines from `+B` users as `(bot)` in the chatlog. Ergo sends the `bot` tag on them, so
  it is cheap if the personas turn out to need the hint.
- RELAYMSG, so bridged users appear as `nick/libera`. That is a snitch and Lurker change.
- Any Lurker-side work.
