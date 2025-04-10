# Impostor for Discord

This is a simple Discord chatbot that can utilize Tavern-compatible character cards to influence the personalities of GPT-powered chatbots on your server.

## Features

- [x] Use Tavern-format characters to power Discord chatbots
- [x] Chatbots respond to replies and @mentions on your Discord server
- [x] Limit which channels chatbots will interact in
- [x] OpenAI API support with Responses API integration
- [x] Web search capability to provide current information

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

## Web Search Configuration

The bot now supports web search capability through OpenAI's Responses API. To use this feature:

1. Ensure the `web_search.enabled` option is set to `true` in your `config.json`
2. For best results, use a model that supports web search, such as `gpt-4o`
3. Optional: If you want to provide your own Bing Search API key, add it to the `web_search.bing_search_key` field

# Credits

- This repo contains code pilfered directly from and inspired by [SillyTavern](https://github.com/Cohee1207/SillyTavern)
- This repo was direclty inspired by [notunderctrl/gpt-3.5-chat-bot](https://github.com/notunderctrl/gpt-3.5-chat-bot).
