# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Impostor runs IRC chatbots powered by the DeepSeek API. One process runs every bot listed in `conf/config.json`; each bot has a persona file (`conf/personas/*.md`), its own IRC connection and NickServ account, its own SQLite database under `data/<id>/`, and its own memory. Isaac (melancholic, sarcastic, cynical robot) ships as the first persona. Built for irc.lurker.chat (`~/Coding/lurker-dev/IRC_SERVER_PLAN.md`). The design is in `JOURNAL_AND_MULTIBOT_PLAN.md`.

The bridge between Discord, Libera, MansionNET and irc.lurker.chat, the GitHub/Discourse webhook receivers, and the channel-log archive all live in a separate project ([`~/Coding/snitch`](../snitch)). When `irc.bridge_nick` is set, bots parse that nick's lines of the form `[tag] <nick> message` via `classes/bridge_parser.js` so they address the real person; which tags are humans is `irc.bridge_tags`. Unset, no bridge is assumed. That is the only contract between the two projects.

## Development Commands

```bash
# Development with auto-restart
npm run dev

# Production start
npm start

# Docker deployment
./start.sh    # Start the bot with Docker
./stop.sh     # Stop the Docker container
```

## Architecture

### Entry Point
- **index.js**: Reads `bots`, builds one shared OpenAI client and one set of tools, one ImpostorClient per bot with a prefixed logger and its persona, one dashboard over all of them

### Core Classes (`classes/`)

| Class | Purpose |
|-------|---------|
| **ImpostorClient** | One bot: IRC client (irc-framework), message handling, queue system, tool execution, DeepSeek API calls, its Archivist |
| **bot_config.js** | `listBots` validates the `bots` list; `resolveBotConfig` layers a bot's overrides over the shared sections into the single-bot shape the client reads |
| **persona.js** | Loads `conf/personas/*.md`: `# Name`, the character text, optional `## Evaluator`, `## Reactions` (how they react: which emoji/words, how often), `## Schedule` (their routine), `## Seeds` (bullet list: things they'd bring up unprompted) and `## News` (bullet list: search queries they'd keep up with) sections |
| **schedule.js** | Pure: parses a `## Schedule` section (`<away\|here> [days] HH:MM-HH:MM [~jitter]: activity [\| away message]`), timezone math, seeded jitter, `presenceAt(schedule, now)` = current/previous/next block |
| **Presence** | Stateful: ticks the schedule, sets the IRC AWAY status (block message, or lurker-style `afk since …` after `presence.afk_minutes` of its own silence), lingers when mid-conversation, runs the client's goodbye pass before an away block and the catch-up after, and writes the `RIGHT NOW` line for the prompts |
| **Roster** | Per bot: who is in each channel and who is away (NAMES, join/part/kick/quit/nick, away-notify with the message, WHO on join for the flag) plus the last `+typing` per channel; `describe(conversation)` is the "In #c right now: alice, isaac (afk for 23 minutes)" line both prompts get. `present` = not away; `reachable` = not away or only auto-afk (`afk since …`), which is what spontaneity counts |
| **Spontaneity** / **SilenceDirector** / **NewsDesk** | Unprompted lines. `Spontaneity` is per bot: `allowed(facts, now)` (enabled, not away, `max_per_day`, `min_gap_minutes`), its `weight` in the draw, `nudge` after an away block ends. `SilenceDirector` is one object shared by every bot (index.js, ticks each minute): per channel it draws a quiet threshold (`quiet_min`..`quiet_max`), and when the channel is quiet past it, someone is reachable and nobody is typing, it picks ONE bot by weighted draw (weight × 0.3 if it filled the last silence there, ÷ (1 + lines spoken unprompted today)) and calls `takeSpontaneousTurn`; after any bot speaks the channel is closed to all for `channel_gap_minutes`. `NewsDesk` caches one web search per query (`news_cache_minutes`) for all bots |
| **Archivist** | The memory: a journal per conversation and a note per person, rewritten whole by a background model call over the chatlog since the last pass (watermark = messages rowid). Told to paraphrase: never the bot's own lines, catchphrases or pet names, since the bot rereads the journal before every reply and would echo them |
| **tics.js** | The tic ledger: `findTics(lines, {reactions})` reads the bot's own last `context.tic_lines` (30) lines in one conversation and finds what it keeps repeating (phrases of 2 to 4 words across many lines, longest kept; words in a third of lines; emoji, and lines ending on one; the same opener; lines ending by telling the other person what to do; reactions mostly one thing). `ticLedgerText` renders it as the `SAY IT DIFFERENTLY: … "old man" (15 of them), 💀 (18), ending by telling the other person what to do (11 lines). Rest all of these for now.` block that `generateResponseWithChatCompletions` puts right before the closing instruction of every reply prompt (null when nothing recurs). Pure; the client wraps it in `ticLedger(channelId)` |
| **irc_message.js** | Factory for normalized message objects (IRC events -> common shape used by all downstream code) |
| **ContextUtils** | System prompt = persona character + the medium (IRC conventions, chatlog format, reactions/replies, journal/people blocks, JSON protocol, tools); renders the chatlog for the reply model and the Archivist, with replies and reactions shown on their lines and per-prompt line refs (`m12`) for the reply model |
| **DatabaseManager** | SQLite persistence for messages, msgids, reactions, decisions, responses, prompts, journals, people (per bot) |
| **MessageTracker** | Per-channel message tracking, triggers URL processing |
| **ResponseEvaluator** | AI evaluation for autonomous responses (should bot respond?); generic rules + the persona's Evaluator section + the journal. Gets the same clock as the reply model: `[HH:MM]` on every line and a `CURRENT DATE/TIME` line, in the bot's timezone (it had none before and invented the hour) |
| **VisionService** | GPT-4o image recognition (dormant for IRC -- no attachments) |
| **UrlSummarizeService** | Kagi Universal Summarizer for shared links |
| **PythonTool** | Executes Python code via subprocess |
| **WebSearchTool** | Kagi FastGPT for current information |
| **WebFetchTool** | Mozilla Readability + Cheerio for web content extraction |
| **Logger** | Simple logging utility |

### Web Dashboard (`web/`)
- **server.js**: Express server for dashboard; `?bot=<id>` on every API call picks the bot (first bot by default) and sets `req.db` / `req.client`
- **routes/api.js**: REST API for bots, messages, decisions, responses, prompts, journals, people
- **views/dashboard.html**: Debug UI; bot picker in the header, Journals and People tabs after the channels

### Configuration
- **conf/config.json**: All settings (gitignored). Shared sections plus `bots: [...]`
- **conf/config.json.example**: Template with all options documented
- **conf/personas/*.md**: Committed. Who each bot is; nothing about the medium

## Key Features

- **Autonomous Responses**: Bot monitors conversations and decides when to naturally respond (debounced, cooldown- and ratio-gated)
- **Direct Mentions**: Mentioning the bot's name (persona name or `watchword`) or nick triggers a direct response
- **Journal**: The Archivist runs per conversation at 40 new lines, or 20 quiet minutes with 5+ new lines (`journal.*`); reads a backlog in passes of 200; a failed or unparseable answer leaves the watermark alone. The reply prompt gets the journal and the notes for the nicks in the window; the evaluator gets the journal. No memory is written on the reply path (the `remember` tool is gone)
- **The screen**: the reply model and the evaluator both see `screenFor`: the last `context.screen_lines` (50) lines however old, reaching back further to every line the journal hasn't read yet (capped at `context.max_lines`, 150), so no line is in neither the chatlog nor memory. There is no age or gap cut: a silence of `context.lull_minutes` (30) shows as `--- 3 hours later ---`, and the evaluator gets a `--- new since NAME last spoke ---` divider and is told to decide mainly on what's below it. Only the newest `context.max_link_summaries` (5) link summaries go in the reply prompt
- **Repetition**: a bot at temperature copies whatever is on its own screen, so a pet name used three times becomes every line, and the journal used to quote it back as memory. Three brakes: the tic ledger (`tics.js`) names the exact phrases, emoji and line shapes it has been leaning on in that conversation; the Archivist paraphrases instead of quoting; and `generator.deepseek.frequency_penalty` (0.3 unless set; `presence_penalty` 0) goes on the reply call. The personas also say tics expire and lines needn't share a shape. Every reply prompt ends its system prompt with `ON YOUR MIND TODAY: (1) … (2) …`, today's seeds (`todaysSeeds`: `seeds_per_day` of the persona's `## Seeds`, order fixed by bot id and date, window slid by one per unprompted line spoken today), so the bot has something of its own to bring up instead of only bouncing the other person's line back; a spontaneous turn lists them in its own instruction instead
- **Several bots**: no special handling for bot-on-bot conversation, by decision; personas and the evaluator prompt are the brake. The evaluator's "topic they don't know about" rule only applies when the bot has no angle either: a question or a view from their own corner counts, faking knowledge doesn't. Their subjects are what they bring up, not the only things they'll talk about; gating them to their gimmick's topics and then telling them to be clipped produced caricatures (every Nightmare line was fog and the grave). Bots do see who is away (the Roster line in both prompts, and lurker's `afk since …` rendered as "afk for N minutes"), so a sleeping bot isn't addressed
- **Tool Iteration**: Up to 10 iterations with reflection for precise tasks (exact character counts, complex math)
- **URL Summarization**: Kagi summarizes shared links proactively
- **Web Tools**: Search (Kagi FastGPT) and fetch (Readability) for current information
- **Message Splitting**: where the server has IRCv3 `draft/multiline` (lurker does; `irc.multiline`, default on), a long reply goes out as ONE message: a `BATCH … draft/multiline` of PRIVMSG pieces (`splitForConcat`: ≤ `irc.max_line_length` chars and ≤ 400 bytes each, joined with `draft/multiline-concat` so the reader sees one message), one msgid, no inter-line delay. Over the server's `max-bytes`/`max-lines`, or without the cap, it falls back to separate ~400-char lines. Incoming multiline messages (anyone's, and the bot's own echoes) arrive at irc-framework's `batch end draft/multiline`; the pieces are joined (`handleMultilineBatch`) and the start line's tags (msgid, `+draft/reply`), which irc-framework drops, are recovered from the raw line (`noteBatchStart`). Line breaks inside a message are kept and shown indented in the prompts
- **Reactions** (IRCv3 `+draft/react`): the evaluator's `react` action names a line and a reaction (emoji or a word or two, ≤ `irc.reaction_max_length`), sent as a TAGMSG; the reply model can also attach `"react": {"to": "m12", "reaction": "🖤"}` to a message or send it alone. Gated in code: never his own line, never a line he already reacted to, and after a reaction he needs `autonomous.react_cooldown_messages` (3) lines from others *and* `react_cooldown_seconds` (30). Reactions are not messages, so they don't count toward the speaking cooldown or bot ratio, but a reaction is a turn: lines he reacted after aren't evaluated again. Where the server or the line can't carry a react (no msgid, `irc.reactions: false`), an evaluator react is said as a plain line instead
- **Reply tags** (IRCv3 `+draft/reply`): the reply model may set `"reply_to": "m12"`, but the tag is only sent when that line has `irc.reply_min_distance` (5) or more lines after it; otherwise it's silently dropped and the `nick:` prefix does the job. Incoming replies are threaded onto their line, and a reply to one of his lines classifies as `named`
- **Seeing reactions**: other people's react/unreact TAGMSGs are stored and shown inline on the line they target (`[reactions: alice 😂, you 🖤]`) in the reply prompt, the evaluator and the Archivist
- **Spontaneous lines**: the shared `SilenceDirector` ticks each minute and offers a quiet channel to one bot (see the class table); `takeSpontaneousTurn` queues a `spontaneous` item (dropped if anyone spoke meanwhile) and `processSpontaneousMessage` asks the reply model directly (no evaluator), `canReact: false`, with "you have the floor if you want it" and material to speak from (`spontaneousMaterial`): today's seeds (`todaysSeeds`, see Repetition; one drops off each time it speaks unprompted), with probability `news_chance` the answer to one of the persona's `## News` queries (looked up through the `NewsDesk` before the call, never a tool call), the RIGHT NOW line, the screen, and notes on everyone in the channel (not just whoever spoke in the window) so it can ask after someone. An empty message is allowed but no longer presented as the default. Logged as a `spontaneous` response and a `[spontaneous] spoke/stayed quiet` decision. Per bot: `max_per_day` (5), `min_gap_minutes` (60), `weight` (1). People who are only auto-afk count as someone to talk to
- **Schedules / presence**: an `away` block (asleep, in class, grazing) = gone: AWAY set to its message, nothing evaluated or answered (messages still stored, Archivist still runs), DMs and channels that moved are noted in `presence.pending` and get one evaluation / a DM reply on return (`catchUp`). Before going, `sayGoodbyes` runs the evaluator with `leaving` in every channel with a human line in the last `goodbye_window_minutes`; a "respond" goes through `processAutonomousMessage` with the goodbye instruction (logged as a `goodbye` response). Mid-conversation (addressed or spoke within 3 min) he lingers up to `linger_minutes`. A `here` block is narrative only. Afk: `afk_minutes` after his own last line AWAY becomes `afk since YYYY-MM-DD HH:MM:SS±ZZZZ` (lurker's format), cleared in `sendIrcMessage`. Jitter is seeded by bot id + date so restarts don't move bedtime. The reply prompt and the evaluator get `Presence.describe()` as a `RIGHT NOW` line. Starting up inside a block = gone, no goodbyes. Timers (`presence.start`) are unref'd; tests drive `tick(now)` with an injected clock

## Database Schema

SQLite database per bot at `data/<id>/impostor.db`:
- **messages**: All messages with attachments, vision_descriptions, url_summaries (rowid is the Archivist's watermark)
- **decision_log**: Autonomous response evaluations with reasoning
- **responses**: Bot responses with trigger tracking
- **prompts**: Full prompts for debugging (system + messages)
- **message_msgids**: server msgid -> message id; several per bot message (one per PRIVMSG line, learned from echo-message); the lowest rowid is the one reacts/replies point at
- **reactions**: every IRCv3 reaction, his and others', keyed by `target_msgid`
- **journals** / **journal_versions**: One journal per conversation with its watermark; every version with source (`archivist`, `edit`) and rationale
- **people** / **people_versions**: One note per nick (`nick_key` lowercased), every version
- `user_memories` from the old remember tool is dropped on first start

## Message Flow

### Direct Response (nick mention)
1. `handleIrcMessage` detects bot nick in message content
2. Message tracked in DB with URL processing
3. Added to queue for sequential processing
4. Build context from the screen (`screenFor`) via `ContextUtils`
5. Call DeepSeek with JSON response format
6. Execute tools if requested, iterate with reflection (max 10 times)
7. Reply split into IRC-friendly lines (~400 chars each)

### Autonomous Response
1. All messages tracked in configured channels
2. Debounce timer (`autonomous.debounce_seconds`, default 20s) waits for conversation to settle. Each line pushes it back, but a wait has a deadline (`max_wait_seconds`, 60s) fixed when it began, and a line naming the bot pulls that deadline in (`address_wait_seconds`, 5s); otherwise a busy channel would reset the timer forever (`classes/eval_debounce.js`)
3. `addressSinceLastBotMessage` classifies who, if anyone, is talking to him. Plain IRC has no reply threading, so this is mostly inferred:
   - **`named`** — someone used his name/nick, or sent an IRCv3 reply to one of his lines. Straight to the evaluator, no dampers.
   - **`reply`** — nobody named him, but within `reply_window_seconds` (180) of his last message a human used second person, asked a question, *or* was the only person speaking (a 1:1 exchange). Also goes to the evaluator.
   - **`none`** — he'd be volunteering into a conversation that moved on without him.
4. Only `none` hits the hard local gates, which run *before* the model is asked anything so a burst can't talk its way past them (and nothing at all runs while `presence.gone`):
   - **Cooldown** — after speaking he needs `cooldown_messages` (3) new messages *and* `cooldown_seconds` (45) of wall clock
   - **Ratio ceiling** — blocked when he's already `max_bot_ratio` (0.4) of the last `ratio_window` (10) messages
5. `ResponseEvaluator` asks DeepSeek for `respond` / `react` / `ignore` (messages shown as `[m3] nick: …`; `react` also returns the line ref and the reaction). A `reply` that arrives inside the cooldown window passes `restraint: true`, which tells the evaluator to answer only if something genuinely new was raised. Inside the reaction cooldown it's told `react` is unavailable, and a `react` anyway becomes `ignore`.
6. If `respond`, generates via the same pipeline as a direct mention
7. Decision logged with reasoning — suppressions land in `decision_log` as `[ignore] cooldown: …` / `[ignore] bot ratio …`

His problem was never total volume (~11% of channel messages) but clustering: he'd answer a message, then answer the two-word correction that followed it. The split matters — **hard-blocking is reserved for the unaddressed case**, because going silent on someone plainly talking to you is a worse failure than being a little chatty. Everything else is handled by the evaluator prompt's "one turn per thought" rule. Tune `cooldown_messages`/`cooldown_seconds` to trade responsiveness against chattiness.

## IRC Details

- Uses `irc-framework` library with TLS, SASL auth, auto-reconnect
- The `messages.channel_id` column stores the IRC PRIVMSG target verbatim. For channel messages that's `#name`; for DMs it's the other party's nick (since channel and PM both go through PRIVMSG, the leading `#` is what distinguishes them). Conversation context is keyed off this column for both kinds.
- Author IDs in the `messages` table are the IRC hostmask (`nick!ident@hostname`) for stable cross-nick-change identity. People notes are keyed by nick only — hostmasks aren't shown to the LLM.
- On a server that advertises the `BOT` ISUPPORT token (Ergo: `B`), each bot sets that mode on itself after registering.
- IRCv3 metadata (`draft/metadata-2`): after each registration `sendMetadata` sets `display-name` (`bots[].display_name`) and `avatar` (`bots[].avatar_url`), and deletes each that is unset so the config is the source of truth (the server may remember an old value). Always after registration, never diffed. A `FAIL METADATA …` is logged via the `unknown command` event; `KEY_NOT_SET` (deleting a key that was already absent) at debug
- Message IDs are UUIDs. The server's IRCv3 `msgid` tag, when present, goes in `message_msgids` (stored before the message itself, since link summarizing can delay the insert and a reaction may arrive first). The bot's own msgids come from `echo-message`: `sendIrcMessage` queues each line in `pendingEchoes` and `recordEcho` matches echoes back in order (prefix-consuming, since irc-framework may split a line further)
- Requests `message-tags` always and `echo-message` via irc-framework's `enable_echomessage`; `canSendReactions` checks `CLIENTTAGDENY` through `network.supportsTag`
- DMs are accepted from anyone (so the dashboard can monitor them) but only sent to nicks listed in `irc.pm_allowed_users`. Empty list = no DM responses. A DM reply waits a random `irc.dm_delay_min_seconds` to `dm_delay_max_seconds` (2 to 6) before the bot starts typing; the screen is built after the pause.

## API Response Format

Bot responses use structured JSON:
```json
{
  "needs_tool": false,
  "tool_name": null,
  "tool_input": null,
  "continue_iterating": false,
  "message": "Response text here",
  "reply_to": null,
  "react": null
}
```

`reply_to` and `react` are optional (see Reactions / Reply tags above); refs are resolved back to message ids in `deliverResponse`.

Tools: `python`, `web_search`, `web_fetch`
