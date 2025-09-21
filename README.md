# Impostor for Discord

This is a simple Discord chatbot powered by OpenRouter with DeepSeek Chat v3.1, featuring a built-in IsaacGPT personality (a depressive, sarcastic, cynical robot).

## Features

- [x] IsaacGPT personality: depressive, sarcastic, and cynical robot character
- [x] Message queue system for realistic sequential response processing
- [x] Responds to replies and @mentions on your Discord server
- [x] Limit which channels the bot will interact in
- [x] Uses OpenRouter API with DeepSeek Chat v3.1 model

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

# Credits

- This repo was directly inspired by [notunderctrl/gpt-3.5-chat-bot](https://github.com/notunderctrl/gpt-3.5-chat-bot).
