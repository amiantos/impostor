# Impostor for Discord

A Discord chatbot powered by DeepSeek API, featuring a built-in IsaacGPT personality (a depressive, sarcastic, cynical robot) with autonomous responses, vision capabilities, and Python tool execution.

## Features

- **IsaacGPT Personality**: Depressive, sarcastic, and cynical robot character
- **Autonomous Responses**: Bot naturally participates in conversations without being @mentioned
- **Conversation Dominance Detection**: Prevents bot from dominating conversations by tracking message ratios
- **Vision Capability**: Can see and describe images using OpenAI GPT-4o
- **Python Tool Integration**: Executes Python code to solve problems and perform calculations
- **Web Dashboard**: Debug interface for viewing decisions, responses, and prompts
- **SQLite Database**: Tracks all messages, responses, and AI decisions
- **Message Backfill**: Loads recent message history on startup for context

## How It Works

### Autonomous Responses
The bot monitors conversations and decides when to naturally chime in:
- Waits for conversation to settle (configurable debounce, default 15 seconds)
- Evaluates if there's something interesting to comment on
- Tracks its own message ratio to avoid dominating (backs off if >40% of recent messages)
- Direct @mentions always work regardless of ratio

### Vision
When images are posted, the bot can see and understand them:
- Uses OpenAI GPT-4o for image analysis
- Descriptions are cached in the database
- Integrated into conversation context so the bot can reference images naturally

### Python Tool Execution
The bot can execute Python code to solve problems:
- *"Write a response that's exactly 42 characters long"* → Iteratively crafts and measures
- *"What's 15% of $1,250 plus tax at 8.5%?"* → Calculates precisely
- Multi-iteration refinement with reflection on previous attempts

## Requirements

- **Node.js 20+**
- **Python 3** (for tool execution)
- **Docker** (optional, for containerized deployment)
- **DeepSeek API Key** (for chat responses)
- **OpenAI API Key** (optional, for vision capability)
- **Discord Bot Token**

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
# Edit conf/config.json with your API keys
```

3. **Run:**
```sh
# Development (with auto-restart)
npm run dev

# Production
npm start

# Docker
./start.sh    # Start
./stop.sh     # Stop
```

## Configuration

```json
{
    "generator": {
        "deepseek": {
            "api_key": "<DEEPSEEK API KEY>",
            "base_url": "https://api.deepseek.com",
            "model": "deepseek-chat",
            "temperature": 0.9,
            "max_tokens": 500
        }
    },
    "bot": {
        "token": "<DISCORD BOT TOKEN>"
    },
    "channels": ["<CHANNEL_ID>"],
    "autonomous": {
        "enabled": true,
        "debounce_seconds": 15
    },
    "vision": {
        "enabled": true,
        "supported_formats": ["png", "jpg", "jpeg", "gif", "webp"],
        "max_file_size_mb": 20
    },
    "openai": {
        "api_key": "<OPENAI API KEY>",
        "model": "gpt-4o",
        "max_tokens": 300
    },
    "web": {
        "enabled": true,
        "port": 3000
    },
    "backfill": {
        "enabled": true,
        "message_limit": 20,
        "process_vision": true,
        "max_channel_age_days": 14
    }
}
```

### Configuration Options

| Section | Option | Description |
|---------|--------|-------------|
| `generator.deepseek` | | DeepSeek API settings for chat responses |
| `bot.token` | | Discord bot token |
| `channels` | | Channel ID whitelist (empty = all channels) |
| `autonomous.enabled` | | Enable autonomous responses |
| `autonomous.debounce_seconds` | | Wait time before evaluating (default: 15) |
| `vision.enabled` | | Enable image understanding |
| `openai` | | OpenAI API settings for vision (GPT-4o) |
| `web.enabled` | | Enable web dashboard |
| `web.port` | | Dashboard port (default: 3000) |
| `backfill.enabled` | | Load message history on startup |
| `backfill.message_limit` | | Messages to load per channel (default: 20) |

## Web Dashboard

When enabled, access the dashboard at `http://localhost:3000` to view:
- Recent AI decisions (should respond? why?)
- Bot responses with full prompt history
- Message database and vision descriptions

## Data Storage

All data is stored in `data/impostor.db` (SQLite):
- Message history with attachments and vision descriptions
- Bot responses and trigger messages
- AI decision logs with reasoning
- Full prompts for debugging

## Credits

Inspired by [notunderctrl/gpt-3.5-chat-bot](https://github.com/notunderctrl/gpt-3.5-chat-bot).
