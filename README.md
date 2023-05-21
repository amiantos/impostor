# Impostor for Discord

This is a simple Discord chatbot that can utilize Tavern-compatible character cards to influence the personalities of GPT-3.5 Turbo powered chatbots on your server.

## Features

- [x] Use character files to power Discord chatbots
  - [x] Supports generic character JSON files
  - [ ] Supports Tavern character card PNGs
- [x] Chatbots respond to replies and @mentions on your Discord server
- [x] Limit which channels chatbots will interact in
- [x] GPT 3.5 Turbo support (only)
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

5. Start your bot

```sh
npm run start
```

# Credits

- This repo contains code pilfered directly from and inspired by [SillyTavern](https://github.com/Cohee1207/SillyTavern)
- This repo was direclty inspired by [notunderctrl/gpt-3.5-chat-bot](https://github.com/notunderctrl/gpt-3.5-chat-bot).