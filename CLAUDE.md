# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Impostor is a Discord chatbot powered by DeepSeek API with an Isaac personality (melancholic, sarcastic, cynical robot). Features include autonomous responses, vision (GPT-4o), URL summarization, web search/fetch, and Python code execution.

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
| **ImpostorClient** | Main Discord client, message handling, queue system, tool execution, DeepSeek API calls |
| **ContextUtils** | System prompt (Isaac personality), message formatting for API calls |
| **DatabaseManager** | SQLite persistence for messages, decisions, responses, prompts |
| **MessageTracker** | Per-channel message tracking, triggers vision/URL processing |
| **ResponseEvaluator** | AI evaluation for autonomous responses (should bot respond?) |
| **VisionService** | GPT-4o image recognition, caches descriptions in DB |
| **UrlSummarizeService** | Kagi Universal Summarizer for shared links |
| **BackfillService** | Loads Discord message history on startup |
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
- **Direct Mentions**: @mentions and replies always trigger responses
- **Tool Iteration**: Up to 10 iterations with reflection for precise tasks (exact character counts, complex math)
- **Vision**: GPT-4o describes images, cached in DB, included in conversation context
- **URL Summarization**: Kagi summarizes shared links proactively
- **Web Tools**: Search (Kagi FastGPT) and fetch (Readability) for current information

## Database Schema

SQLite database at `data/impostor.db`:
- **messages**: All messages with attachments, vision_descriptions, url_summaries
- **decision_log**: Autonomous response evaluations with reasoning
- **responses**: Bot responses with trigger tracking
- **prompts**: Full prompts for debugging (system + messages)

## Message Flow

### Direct Response (mention/reply)
1. `handleMessageCreate` detects mention or reply to bot
2. Message tracked in DB with vision/URL processing
3. Added to queue for sequential processing
4. Build context from recent DB messages via `ContextUtils`
5. Call DeepSeek with JSON response format
6. Execute tools if requested, iterate with reflection (max 10 times)
7. Reply with truncated response (max 2000 chars)

### Autonomous Response
1. All messages tracked in configured channels
2. Debounce timer (default 15s) waits for conversation to settle
3. `ResponseEvaluator` asks DeepSeek if bot should respond
4. Checks bot message ratio (<40% of recent messages)
5. If yes, generates response via same pipeline as direct
6. Decision logged with reasoning

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
