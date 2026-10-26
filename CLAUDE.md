# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Impostor runs IRC chatbots powered by the DeepSeek API. One process runs every bot listed in `conf/config.json`; each bot has a persona file (`conf/personas/*.md`), its own IRC connection and NickServ account, its own SQLite database under `data/<id>/`, and its own memory. Isaac (melancholic, sarcastic, cynical robot) ships as the first persona. Built for irc.lurker.chat (`~/Coding/lurker-dev/IRC_SERVER_PLAN.md`). The design is in `JOURNAL_AND_MULTIBOT_PLAN.md`.

The bridge between Discord, Libera, MansionNET and irc.lurker.chat, the GitHub/Discourse webhook receivers, and the channel-log archive all live in a separate project ([`~/Coding/snitch`](../snitch)). Bots parse bridged lines of the form `[tag] <nick> message` via `classes/bridge_parser.js` so they address the real person; which tags are humans is `irc.bridge_tags`. That is the only contract between the two projects.

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
| **persona.js** | Loads `conf/personas/*.md`: `# Name`, the character text, an optional `## Evaluator` section |
| **Archivist** | The memory: a journal per conversation and a note per person, rewritten whole by a background model call over the chatlog since the last pass (watermark = messages rowid) |
| **irc_message.js** | Factory for normalized message objects (IRC events -> common shape used by all downstream code) |
| **ContextUtils** | System prompt = persona character + the medium (IRC conventions, chatlog format, journal/people blocks, JSON protocol, tools); renders the chatlog for the reply model and the Archivist |
| **DatabaseManager** | SQLite persistence for messages, decisions, responses, prompts, journals, people (per bot) |
| **MessageTracker** | Per-channel message tracking, triggers URL processing |
| **ResponseEvaluator** | AI evaluation for autonomous responses (should bot respond?); generic rules + the persona's Evaluator section + the journal |
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
- **Several bots**: no special handling for bot-on-bot conversation, by decision; personas and the evaluator prompt are the brake
- **Tool Iteration**: Up to 10 iterations with reflection for precise tasks (exact character counts, complex math)
- **URL Summarization**: Kagi summarizes shared links proactively
- **Web Tools**: Search (Kagi FastGPT) and fetch (Readability) for current information
- **Message Splitting**: Long responses are split into ~400-char lines for IRC compatibility

## Database Schema

SQLite database per bot at `data/<id>/impostor.db`:
- **messages**: All messages with attachments, vision_descriptions, url_summaries (rowid is the Archivist's watermark)
- **decision_log**: Autonomous response evaluations with reasoning
- **responses**: Bot responses with trigger tracking
- **prompts**: Full prompts for debugging (system + messages)
- **journals** / **journal_versions**: One journal per conversation with its watermark; every version with source (`archivist`, `edit`) and rationale
- **people** / **people_versions**: One note per nick (`nick_key` lowercased), every version
- `user_memories` from the old remember tool is dropped on first start

## Message Flow

### Direct Response (nick mention)
1. `handleIrcMessage` detects bot nick in message content
2. Message tracked in DB with URL processing
3. Added to queue for sequential processing
4. Build context from recent DB messages via `ContextUtils`
5. Call DeepSeek with JSON response format
6. Execute tools if requested, iterate with reflection (max 10 times)
7. Reply split into IRC-friendly lines (~400 chars each)

### Autonomous Response
1. All messages tracked in configured channels
2. Debounce timer (`autonomous.debounce_seconds`, default 20s) waits for conversation to settle
3. `addressSinceLastBotMessage` classifies who, if anyone, is talking to him. IRC has no reply threading, so this is inferred:
   - **`named`** — someone used his name/nick. Straight to the evaluator, no dampers.
   - **`reply`** — nobody named him, but within `reply_window_seconds` (180) of his last message a human used second person, asked a question, *or* was the only person speaking (a 1:1 exchange). Also goes to the evaluator.
   - **`none`** — he'd be volunteering into a conversation that moved on without him.
4. Only `none` hits the hard local gates, which run *before* the model is asked anything so a burst can't talk its way past them:
   - **Cooldown** — after speaking he needs `cooldown_messages` (3) new messages *and* `cooldown_seconds` (45) of wall clock
   - **Ratio ceiling** — blocked when he's already `max_bot_ratio` (0.4) of the last `ratio_window` (10) messages
5. `ResponseEvaluator` asks DeepSeek for `respond` / `react` / `ignore`. A `reply` that arrives inside the cooldown window passes `restraint: true`, which tells the evaluator to answer only if something genuinely new was raised.
6. If `respond`, generates via the same pipeline as a direct mention
7. Decision logged with reasoning — suppressions land in `decision_log` as `[ignore] cooldown: …` / `[ignore] bot ratio …`

His problem was never total volume (~11% of channel messages) but clustering: he'd answer a message, then answer the two-word correction that followed it. The split matters — **hard-blocking is reserved for the unaddressed case**, because going silent on someone plainly talking to you is a worse failure than being a little chatty. Everything else is handled by the evaluator prompt's "one turn per thought" rule. Tune `cooldown_messages`/`cooldown_seconds` to trade responsiveness against chattiness.

## IRC Details

- Uses `irc-framework` library with TLS, SASL auth, auto-reconnect
- The `messages.channel_id` column stores the IRC PRIVMSG target verbatim. For channel messages that's `#name`; for DMs it's the other party's nick (since channel and PM both go through PRIVMSG, the leading `#` is what distinguishes them). Conversation context is keyed off this column for both kinds.
- Author IDs in the `messages` table are the IRC hostmask (`nick!ident@hostname`) for stable cross-nick-change identity. People notes are keyed by nick only — hostmasks aren't shown to the LLM.
- On a server that advertises the `BOT` ISUPPORT token (Ergo: `B`), each bot sets that mode on itself after registering.
- Message IDs are UUIDs (IRC has no server-assigned message IDs)
- DMs are accepted from anyone (so the dashboard can monitor them) but only sent to nicks listed in `irc.pm_allowed_users`. Empty list = no DM responses.

## API Response Format

Bot responses use structured JSON:
```json
{
  "needs_tool": false,
  "tool_name": null,
  "tool_input": null,
  "continue_iterating": false,
  "message": "Response text here"
}
```

Tools: `python`, `web_search`, `web_fetch`
