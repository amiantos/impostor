# Impostor for IRC

IRC chatbots powered by the DeepSeek API. One process runs any number of bots, each with its own personality file, IRC account, database and memory. Ships with Isaac (a melancholic, sarcastic, cynical robot). Autonomous responses, a journal the bot keeps between conversations, URL summarization, web search/fetch, and Python tool execution. Built for irc.lurker.chat, works on any network, via `irc-framework`.

## Features

- **Personas**: each bot is a markdown file describing who it is; the code owns how IRC works
- **Many bots**: one config, one process, one dashboard; each bot has its own connection, account, database and memory
- **Journal and people notes**: the Archivist reads the chatlog in the background and keeps a short first-person journal per conversation and a note per person, so the bot picks up where things left off
- **Autonomous Responses**: Bot naturally participates in conversations without being mentioned
- **Conversation Dominance Detection**: Prevents bot from dominating conversations by tracking message ratios
- **Typing Indicator**: Sends IRCv3 `+typing` tags while composing, so modern clients show "Isaac is typing…" (or whichever bot) during slow responses
- **URL Summarization**: Automatically summarizes shared links using Kagi Universal Summarizer
- **Web Search**: Answers questions about current events using Kagi FastGPT
- **Web Fetch**: Reads and extracts content from web pages
- **Python Tool Integration**: Executes Python code to solve problems and perform calculations
- **Web Dashboard**: Debug interface for viewing decisions, responses, and prompts
- **SQLite Database**: Tracks all messages, responses, and AI decisions

## How It Works

### Autonomous Responses
The bot monitors conversations and decides when to naturally chime in:
- Waits for conversation to settle (configurable debounce)
- Evaluates if there's something interesting to comment on
- Tracks its own message ratio to avoid dominating, and holds a cooldown after each message so a fast exchange counts as one turn rather than four
- Mentioning the bot's name (the persona's name, or `watchword` in its config) or nick always triggers a response

### The journal (memory)
Nothing about memory happens on the reply path. The Archivist runs in the background, per conversation (a channel or a DM partner), once there are 40 new lines or the conversation has been quiet for 20 minutes with at least 5 new lines:
- It reads the lines since its last pass, together with the current journal and its notes on the people who spoke, and writes both again whole: the journal in the bot's own voice, kept under about 1,500 characters, condensing the older part as it grows; each person's note under about 600.
- The reply model sees the journal and the notes of whoever is in the chatlog window, ahead of the chatlog. The evaluator sees the journal too.
- The watermark is stored with the journal, so a restart or a long backlog picks up exactly where it left off; a backlog is read in passes of 200 lines.
- Every version is kept with the Archivist's one-line rationale. The dashboard's **Journals** and **People** tabs show them, let you edit or forget one, and can run a pass on demand.

### Several bots
`bots` in `conf/config.json` lists them. Each entry names an `id` (its data directory and dashboard tab), a `nick`, a `persona` file, its `channels`, and its NickServ `account`. Any key under a bot's `irc`, `generator`, `autonomous`, `url_summarize` or `journal` overrides the shared section. Bots see each other as ordinary users; there is no special handling for bot-on-bot conversation, the personas and the evaluator are the brake.

On irc.lurker.chat, an oper registers each bot's account with `/msg NickServ SAREGISTER <nick> <password>` and the bot sets the server's bot mode (`+B`) on itself once connected.

### Personas
`conf/personas/<name>.md`: a `# Name` heading, the character (who they are, what they know and don't, how they write), and a `## Evaluator` section that tells the should-I-speak model who they are and what topics are theirs. Everything about the medium (the chatlog format, IRC conventions, the JSON reply protocol, the tools, the journal) is in `classes/context_utils.js` and shared by every persona.

### Python Tool Execution
The bot can execute Python code to solve problems:
- *"Write a response that's exactly 42 characters long"* → Iteratively crafts and measures
- *"What's 15% of $1,250 plus tax at 8.5%?"* → Calculates precisely
- Multi-iteration refinement with reflection on previous attempts

### URL Summarization
When users share links, the bot automatically summarizes them:
- Uses Kagi Universal Summarizer for articles, YouTube videos, PDFs, and more
- Summaries are cached in the database and included in conversation context
- Bot can discuss shared links naturally without needing to fetch them again

### Web Search & Fetch
The bot can search the web and read pages for current information:
- **Web Search**: Uses Kagi FastGPT to answer questions about current events, news, prices, etc.
- **Web Fetch**: Reads and extracts content from specific URLs using Mozilla Readability

### Bridged messages
The bridge between Discord, Libera, MansionNET and irc.lurker.chat lives in a separate project ([snitch](../snitch)) and sits in the channel as `EyeBridge`. Its lines look like `[libera] <nick> text`; `classes/bridge_parser.js` unwraps the tags listed in `irc.bridge_tags` so responses address the human, not the bridge nick. Lines with any other tag (`[repo-name] <user> opened ...`) are webhook announcements and are left alone unless someone asks about them.

## Requirements

- **Node.js 20+**
- **Python 3** (for tool execution)
- **Docker** (optional, for containerized deployment)
- **DeepSeek API Key** (for chat responses)
- **OpenAI API Key** (optional, for vision capability)
- **Kagi API Key** (optional, for web search and URL summarization)

## Setup

1. **Clone and install:**
```sh
git clone https://github.com/amiantos/impostor.git
cd impostor
npm install
```

2. **Configure:**
```sh
cp conf/config.json.example conf/config.json
# Edit conf/config.json with your API keys and IRC settings
```

3. **Run:**
```sh
# Development (with auto-restart)
npm run dev

# Production
npm start

# Docker
docker compose up -d --build
```

## Configuration

See `conf/config.json.example` for all options. Key sections:

| Section | Description |
|---------|-------------|
| `generator.deepseek` | DeepSeek API settings for chat responses |
| `generator.deepseek.thinking` | Let the model reason before replying (default `true`) |
| `generator.deepseek.evaluator_thinking` | Same, for the should-I-respond evaluator (default `false`) |
| `irc` | Shared IRC connection settings (host, port, TLS, bridge nick and tags) |
| `bots` | One entry per bot: `id`, `nick`, `persona`, `account`, `channels`, `pm_allowed_users`, and per-bot overrides of `irc`, `generator`, `autonomous`, `url_summarize`, `journal` |
| `bots[].watchword` | What people call the bot in chat, when it differs from the persona's name |
| `journal` | When the Archivist runs (`messages_per_pass`, `quiet_minutes`, `min_messages`) and how long a journal (`journal_max_chars`) and a note (`note_max_chars`) may get |
| `autonomous` | Autonomous response settings (debounce, timing) |
| `autonomous.cooldown_messages` / `cooldown_seconds` | Quiet period after the bot speaks, before it will volunteer again (3 msgs / 45s) |
| `autonomous.reply_window_seconds` | How long after speaking a human turn still counts as a reply to him (180s) |
| `autonomous.max_bot_ratio` / `ratio_window` | Hard ceiling on the bot's share of the last N messages (0.4 of 10) |
| `vision` | Image understanding via OpenAI GPT-4o (dormant on IRC) |
| `openai` | OpenAI API settings for vision |
| `web` | Web dashboard settings |
| `kagi` | Kagi API key for web search and URL summarization |
| `url_summarize` | Automatic URL summarization settings |

## Web Dashboard

When enabled, access the dashboard at `http://localhost:3000`. A picker in the header chooses the bot. For each bot:
- Recent AI decisions (should respond? why?)
- Bot responses with full prompt history
- Message database
- Journals and people notes, with their history and the Archivist's rationale per pass

## Data Storage

Each bot's data is stored in `data/<bot id>/impostor.db` (SQLite):
- Message history with URL summaries (each bot keeps its own copy of what it saw)
- Bot responses and trigger messages
- AI decision logs with reasoning
- Full prompts for debugging
- The journal per conversation and the note per person, with every version
