# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Impostor is an IRC chatbot powered by DeepSeek API with an Isaac personality (melancholic, sarcastic, cynical robot). Connects to libera.chat and joins #amiantos. Features include autonomous responses, URL summarization, web search/fetch, and Python code execution.

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
- **index.js**: Initializes Logger and ImpostorClient, starts the bot

### Core Classes (`classes/`)

| Class | Purpose |
|-------|---------|
| **ImpostorClient** | Main IRC client (irc-framework), message handling, queue system, tool execution, DeepSeek API calls |
| **irc_message.js** | Factory for normalized message objects (IRC events -> common shape used by all downstream code) |
| **ContextUtils** | System prompt (Isaac personality), message formatting for API calls |
| **DatabaseManager** | SQLite persistence for messages, decisions, responses, prompts |
| **MessageTracker** | Per-channel message tracking, triggers URL processing |
| **ResponseEvaluator** | AI evaluation for autonomous responses (should bot respond?) |
| **VisionService** | GPT-4o image recognition (dormant for IRC -- no attachments) |
| **UrlSummarizeService** | Kagi Universal Summarizer for shared links |
| **PythonTool** | Executes Python code via subprocess |
| **WebSearchTool** | Kagi FastGPT for current information |
| **WebFetchTool** | Mozilla Readability + Cheerio for web content extraction |
| **Logger** | Simple logging utility |

### Web Dashboard (`web/`)
- **server.js**: Express server for dashboard
- **routes/api.js**: REST API for messages, decisions, responses, prompts
- **views/dashboard.html**: Debug UI for viewing bot behavior

### Configuration
- **conf/config.json**: All settings (gitignored)
- **conf/config.json.example**: Template with all options documented

## Key Features

- **Autonomous Responses**: Bot monitors conversations and decides when to naturally respond (debounced, ratio-aware)
- **Direct Mentions**: Mentioning "Isaac" in a message triggers a direct response
- **Tool Iteration**: Up to 10 iterations with reflection for precise tasks (exact character counts, complex math)
- **URL Summarization**: Kagi summarizes shared links proactively
- **Web Tools**: Search (Kagi FastGPT) and fetch (Readability) for current information
- **Message Splitting**: Long responses are split into ~400-char lines for IRC compatibility

## Database Schema

SQLite database at `data/impostor.db`:
- **messages**: All messages with attachments, vision_descriptions, url_summaries
- **decision_log**: Autonomous response evaluations with reasoning
- **responses**: Bot responses with trigger tracking
- **prompts**: Full prompts for debugging (system + messages)

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
2. Debounce timer (default 15s) waits for conversation to settle
3. `ResponseEvaluator` asks DeepSeek if bot should respond
4. Checks bot message ratio (<40% of recent messages)
5. If yes, generates response via same pipeline as direct
6. Decision logged with reasoning

## IRC Details

- Uses `irc-framework` library with TLS, SASL auth, auto-reconnect
- Channel names (e.g. "#amiantos") serve as channel IDs throughout the codebase
- User IDs are `nick!ident@hostname` for stable identity across nick changes
- Message IDs are UUIDs (IRC has no server-assigned message IDs)
- No reply-to mechanism -- all responses go to the channel

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
