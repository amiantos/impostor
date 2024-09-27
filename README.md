# Impostor for Discord

This is a simple Discord chatbot that can utilize Tavern-compatible character cards to influence the personalities of GPT-powered chatbots on your server.

## Features

- [x] Use character files to power Discord chatbots
  - [x] Supports generic character JSON files
  - [ ] Supports Tavern character card PNGs
- [x] Chatbots respond to replies and @mentions on your Discord server
- [x] Limit which channels chatbots will interact in
- [x] Open AI API support (only)
- [ ] Run multiple chatbots at once
- [ ] Pre-populate chatbots with info about your users

## How to use

1. Clone and install dependencies

```sh
git clone https://github.com/amiantos/impostor.git .
npm install
```

2. Create a new file called `config.json` and copy the format from `config.json.example`

3. Update `config.json` with your own credentials and configuration options.

   1. You may have to Google how to create a Discord bot if you don't already know how.

5. Start your bot

```sh
npm run start
```

## How to use (Docker)

1. Clone and install dependencies

```sh
mkdir impostor
cd impostor
git clone https://github.com/amiantos/impostor.git .
npm install
```

2. Create a new file called `config.json` and copy the format from `config.json.example`

3. Update `config.json` with your own credentials and configuration options.

   1. You may have to Google how to create a Discord bot if you don't already know how.

5. Build your docker container

```sh
docker build -t impostor .
```

6. Run the container

```sh
# Basic run
docker run -d --name impostor impostor
# Run with automatic restarts (recommended)
docker run -d --name impostor --restart unless-stopped impostor
```

# Credits

- This repo contains code pilfered directly from and inspired by [SillyTavern](https://github.com/Cohee1207/SillyTavern)
- This repo was direclty inspired by [notunderctrl/gpt-3.5-chat-bot](https://github.com/notunderctrl/gpt-3.5-chat-bot).
