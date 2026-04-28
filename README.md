# Impostor for IRC

An IRC chatbot powered by DeepSeek API, featuring a built-in Isaac personality (a melancholic, sarcastic, cynical robot) with autonomous responses, URL summarization, web search/fetch, and Python tool execution. Connects to libera.chat via `irc-framework`.

## Features

- **Isaac Personality**: Melancholic, sarcastic, and cynical robot character
- **Autonomous Responses**: Bot naturally participates in conversations without being mentioned
- **Conversation Dominance Detection**: Prevents bot from dominating conversations by tracking message ratios
- **URL Summarization**: Automatically summarizes shared links using Kagi Universal Summarizer
- **Web Search**: Answers questions about current events using Kagi FastGPT
- **Web Fetch**: Reads and extracts content from web pages
- **Python Tool Integration**: Executes Python code to solve problems and perform calculations
- **User Memory**: Remembers facts, preferences, and relationships about users across conversations
- **GitHub Webhooks**: Receives GitHub webhook events and posts notifications to IRC
- **Discord Bridge**: Bidirectional message relay between IRC and Discord channels
- **Chat Log Upload**: Periodically uploads IRC logs to Cloudflare R2 for external display
- **Web Dashboard**: Debug interface for viewing decisions, responses, and prompts
- **SQLite Database**: Tracks all messages, responses, and AI decisions

## How It Works

### Autonomous Responses
The bot monitors conversations and decides when to naturally chime in:
- Waits for conversation to settle (configurable debounce)
- Evaluates if there's something interesting to comment on
- Tracks its own message ratio to avoid dominating
- Mentioning the bot's watchword (e.g. "Isaac") or nick always triggers a response

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

### User Memory
The bot can remember things about users across conversations:
- Stores facts (job, hobbies, location), preferences (likes/dislikes), and relationships (inside jokes, how it knows someone)
- Memories are recalled when users appear in conversation context
- Stored in SQLite alongside other bot data

### GitHub Webhooks
The bot receives GitHub webhook events and posts formatted notifications to IRC:
- Supports fork, issue, pull request, release, and star events
- HMAC-SHA256 signature verification for security
- Configurable target channel

### Discord Bridge
Bidirectional message relay between an IRC channel and a Discord channel:
- Uses a separate IRC connection (configurable nick with SASL auth)
- IRC messages appear in Discord as `[#channel] <**Username**> message`
- Discord messages appear in IRC as `[Discord] <Username> message`
- Isaac parses bridged messages to see the real Discord username, not the bridge nick
- Handles Discord mentions, custom emoji, attachments, and IRC message splitting

### Chat Log Upload
Periodically uploads the tail of an IRC log file to Cloudflare R2:
- Configurable upload interval and number of tail lines
- Skips upload if the log file hasn't changed
- Useful for displaying a live chat view on an external site

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
| `irc` | IRC connection settings (host, nick, channels, SASL auth) |
| `irc.watchword` | Word that triggers the bot (e.g. "Isaac"), separate from nick |
| `autonomous` | Autonomous response settings (debounce, timing) |
| `vision` | Image understanding via OpenAI GPT-4o (dormant on IRC) |
| `openai` | OpenAI API settings for vision |
| `web` | Web dashboard settings |
| `kagi` | Kagi API key for web search and URL summarization |
| `discord` | Discord-IRC bridge settings (token, channels, bridge nick, SASL) |
| `github_webhook` | GitHub webhook receiver (secret, target channel) |
| `url_summarize` | Automatic URL summarization settings |
| `chat_log_upload` | Chat log upload to Cloudflare R2 (interval, log path, R2 credentials) |

## Web Dashboard

When enabled, access the dashboard at `http://localhost:3000` to view:
- Recent AI decisions (should respond? why?)
- Bot responses with full prompt history
- Message database

## Data Storage

All data is stored in `data/impostor.db` (SQLite):
- Message history with URL summaries
- Bot responses and trigger messages
- AI decision logs with reasoning
- Full prompts for debugging
- User memories (facts, preferences, relationships)
