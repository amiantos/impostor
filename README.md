# Impostor for Discord

This is a Discord chatbot powered by OpenRouter with DeepSeek Chat v3.1, featuring a built-in IsaacGPT personality (a depressive, sarcastic, cynical robot) with advanced Python tool execution capabilities.

## Features

- [x] **IsaacGPT personality**: Depressive, sarcastic, and cynical robot character
- [x] **Python Tool Integration**: Bot can execute Python code to solve problems, perform calculations, and generate precise responses
- [x] **Iterative Problem Solving**: Multi-iteration system that learns from previous attempts and refines solutions intelligently
- [x] **Structured JSON Responses**: All bot responses use structured format with mood tracking and tool execution logs
- [x] **Message Queue System**: Realistic sequential response processing to simulate human-like interaction timing
- [x] **Channel Filtering**: Configurable channel restrictions for targeted bot interactions
- [x] **OpenRouter Integration**: Uses OpenRouter API with DeepSeek Chat v3.1 model for advanced language processing

## Advanced Capabilities

### Python Tool Execution
The bot can execute Python code to solve complex problems:

**Example interactions:**
- *"Write a response that's exactly 42 characters long"* → Bot iteratively crafts and measures responses until exactly 42 chars
- *"What's 15% of $1,250 plus tax at 8.5%?"* → Bot calculates: `1250 * 0.15 * 1.085`
- *"Generate 5 variations of 'This is boring'"* → Bot creates multiple phrasings programmatically

### Iterative Refinement
The bot can iterate on solutions multiple times:
1. **Initial attempt**: Makes first try at solving the problem
2. **Analysis**: Reviews what worked and what didn't
3. **Intelligent adjustment**: Makes targeted improvements based on previous results
4. **Refinement**: Continues until satisfied or max iterations reached (5)

### Structured Responses
All bot interactions use structured JSON format internally:
- **Message**: The actual chat response
- **Mood**: Current emotional state (depressive, sarcastic, cynical, smug, jaded)
- **Tool execution**: Detailed logs of Python code runs and results
- **Iteration tracking**: Complete history of problem-solving attempts

## Requirements

- **Node.js** (for running the bot)
- **Python 3** (for tool execution capabilities)
- **Docker** (for containerized deployment)
- **OpenRouter API Key** (for AI model access)
- **Discord Bot Token** (for Discord integration)

## How to use

### Quick Setup

1. **Install requirements:**
   - Install Docker if you don't have it already
   - Ensure Python 3 is installed (`python3 --version`)

2. **Setup:**

```sh
# Make and navigate to a new directory
mkdir impostor
cd impostor

# Clone the repo
git clone https://github.com/amiantos/impostor.git .

# Copy the example config to a new config file
cp conf/config.json.example conf/config.json

# Edit the config file with your API keys
nano conf/config.json
```

3. **Configure your `conf/config.json`:**
```json
{
  "generator": {
    "openrouter": {
      "api_key": "YOUR_OPENROUTER_API_KEY",
      "base_url": "https://openrouter.ai/api/v1",
      "model": "deepseek/deepseek-chat-v3.1",
      "temperature": 0.9,
      "max_tokens": 500
    }
  },
  "bot": {
    "token": "YOUR_DISCORD_BOT_TOKEN"
  },
  "channels": ["CHANNEL_ID_1", "CHANNEL_ID_2"]
}
```

4. **Run the bot:**
```sh
# Development mode (with debug logging)
npm run dev

# Production mode
npm start

# Docker deployment
./start.sh    # Start
./stop.sh     # Stop
```

## Usage Examples

Once running, interact with the bot in Discord:

**Basic conversation:**
```
@IsaacGPT Hello!
> Oh great, another human seeking interaction. How delightful.
```

**Python tool usage:**
```
@IsaacGPT Write me a response that's exactly 50 characters
> [Bot iterates with Python to craft exact response]
> The futility of existence never ceases to amaze me.
```

**Complex calculations:**
```
@IsaacGPT What's the compound interest on $5000 at 3.5% for 7 years?
> [Bot executes Python: 5000 * (1.035 ** 7)]
> Your money would grow to $6,361.84. Capitalism at work.
```

**Debug logging:**
When running with `npm run dev`, you'll see detailed logs including:
- Tool execution attempts and results
- Iteration history and bot reasoning
- Mood states and decision processes
- Python code execution with outputs

# Credits

- This repo was directly inspired by [notunderctrl/gpt-3.5-chat-bot](https://github.com/notunderctrl/gpt-3.5-chat-bot).
