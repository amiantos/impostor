# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Impostor is a Discord chatbot that uses Tavern-compatible character cards to create personality-driven chatbots powered by OpenAI. The bot responds to @mentions and replies in Discord channels, using character definitions to maintain consistent personalities.

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

### Core Components

- **index.js**: Entry point that initializes logger and ImpostorClient
- **ImpostorClient** (`classes/impostor_client.js`): Main Discord client handling message events and OpenAI integration
- **ContextUtils** (`classes/context_utils.js`): Builds conversation context from character cards and chat history
- **Logger** (`classes/logger.js`): Simple logging utility

### Key Features

- **Dual API Support**: Uses OpenAI Responses API (primary) with web search support, fallback to Chat Completions API
- **Character System**: Tavern-format JSON character cards with personality, description, and example dialogue
- **Channel Filtering**: Configurable channel restrictions via `config.channels` array
- **Message Processing**: Handles @mentions and replies, truncates messages over 2000 characters

### Configuration

Configuration is managed through `conf/config.json`:
- OpenAI API settings (key, model, temperature, etc.)
- Discord bot token and character file reference
- Channel ID whitelist (empty array = all channels)
- NSFW content toggle

### Character Cards

Character definitions use Tavern format in JSON files (`characters/` directory):
- `name`: Character name
- `description`: Physical and behavioral description
- `personality`: Personality traits
- `scenario`: Context and circumstances
- `example_dialogue`: Sample conversations using `<START>` delimiters

The system substitutes `{{char}}` and `{{user}}` placeholders with actual names during context building.

### Message Flow

1. Discord message triggers `handleMessageCreate`
2. Channel and mention validation
3. Fetch recent messages (40 limit)
4. Build character context using ContextUtils
5. Generate response via OpenAI Responses API (with web search) or Chat Completions
6. Reply with truncated response if needed