# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Impostor is a Discord chatbot powered by OpenRouter with DeepSeek Chat v3.1 model, featuring a built-in IsaacGPT personality (depressive, sarcastic, cynical robot). The bot responds to @mentions and replies in Discord channels.

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
- **ImpostorClient** (`classes/impostor_client.js`): Main Discord client handling message events and OpenRouter integration
- **ContextUtils** (`classes/context_utils.js`): Simple context builder with hardcoded system prompt for IsaacGPT personality
- **Logger** (`classes/logger.js`): Simple logging utility

### Key Features

- **OpenRouter Integration**: Uses OpenRouter API with DeepSeek Chat v3.1 model
- **Message Queue System**: Processes messages sequentially to simulate realistic response timing
- **Hardcoded System Prompt**: Simple implementation with IsaacGPT personality built-in (depressive, sarcastic robot)
- **Channel Filtering**: Configurable channel restrictions via `config.channels` array
- **Message Processing**: Handles @mentions and replies, truncates messages over 2000 characters

### Configuration

Configuration is managed through `conf/config.json`:
- OpenRouter API settings (key, model, temperature, etc.) in `generator.openrouter`
- Discord bot token in `bot.token` field
- Channel ID whitelist in `channels` array (empty array = all channels)

### System Prompt

The bot uses a hardcoded system prompt in `ContextUtils.system_prompt` that defines IsaacGPT as a depressive, sarcastic, cynical robot. The prompt includes personality traits, behavioral guidelines, and response formatting rules.

### Message Flow

1. Discord message triggers `handleMessageCreate`
2. Channel and mention validation
3. Message added to queue for sequential processing
4. Queue processor fetches recent messages (40 limit)
5. Build simple message context using ContextUtils
6. Generate response via OpenRouter Chat Completions API with system prompt
7. Reply with truncated response if needed
8. Process next message in queue after 1-second delay