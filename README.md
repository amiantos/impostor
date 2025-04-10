# Impostor for Discord

This is a simple Discord chatbot that can utilize Tavern-compatible character cards to influence the personalities of GPT-powered chatbots on your server.

## Features

- [x] Use Tavern-format characters to power Discord chatbots
- [x] Chatbots respond to replies and @mentions on your Discord server
- [x] Limit which channels chatbots will interact in
- [x] OpenAI API support (only)
- [x] Web search capability using OpenAI Responses API

## How to use

1. Install Docker if you don't have it already.

1. Open up Terminal

```sh
# Make and navigate to to a new directory
mkdir impostor
cd impostor

# Clone the repo
git clone https://github.com/amiantos/impostor.git .

# Copy the example config to a new config file
cp conf/config.json.example conf/config.json

# Edit the new config file to insert your information
nano conf/config.json

# Start the bot
./start.sh

# Stop the bot
./stop.sh
```

## Web Search Capability

The bot now supports web search functionality through the OpenAI Responses API. To enable this feature:

1. Make sure you're using a model that supports the Responses API (like gpt-4o or other newer models)
2. Set `use_web_search` to `true` in your config.json:

```json
"openai": {
    "api_key": "<OPENAI API KEY>",
    "model": "gpt-4o",
    "temperature": 0.9,
    "frequency_penalty": 0.7,
    "presence_penalty": 0.7,
    "top_p": 1,
    "max_tokens": 256,
    "use_web_search": true
}
```

When web search is enabled, the bot will be able to search the internet to provide more up-to-date and accurate responses.

# Credits

- This repo contains code pilfered directly from and inspired by [SillyTavern](https://github.com/Cohee1207/SillyTavern)
- This repo was direclty inspired by [notunderctrl/gpt-3.5-chat-bot](https://github.com/notunderctrl/gpt-3.5-chat-bot).
