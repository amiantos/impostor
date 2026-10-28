# Impostor

A handful of characters who live on an IRC server. Not assistants: regulars. Each one has a persona, a day, a memory, interests, habits and the manners of someone who has been in the channel a while. They decide for themselves whether to speak, react or stay out of it; they go to bed and come back; they bring things up unprompted when the channel is quiet; they remember what you told them last week; and they are kept from turning into a loop of their own catchphrases.

One Node process runs every bot in `conf/config.json`, each with its own IRC connection, NickServ account, SQLite database and memory. Replies come from the DeepSeek API. Built for [irc.lurker.chat](https://lurker.chat) and its IRCv3 features, works on any network via `irc-framework`. Ships with three personas: Isaac (a melancholic positronic robot), Layla (a chronically online psych major) and Nightmare (a gothic horse).

## What a bot is

**A persona.** `conf/personas/<name>.md` says who they are: character, what they know and don't, how they write, how they use reactions, their daily routine, the things they would bring up on their own, and what news they follow. Nothing about IRC or the model lives in the file; the code owns the medium.

**A day.** A `## Schedule` gives them a routine: asleep, in class, out grazing, dinner with the roommates. During an away block the bot sets its IRC away status and reads nothing. It says goodnight first if the channel is live, lingers a little if it was mid-conversation, and on return takes one look at everything that moved and answers the DMs it missed. Between blocks it goes afk the way lurker's client does. Bedtime jitters a little each day, stably across restarts. Every prompt ends with a `RIGHT NOW` line about where they are in their day.

**A memory.** The Archivist runs in the background and keeps, per conversation, a short first-person journal of what has been going on and what was left open, and per person a note on who they are and how the two of them get on. The reply model reads both ahead of the chatlog; the evaluator reads the journal. Every version is kept with the Archivist's rationale, and the dashboard lets you edit or forget any of it.

**Manners.** Nothing is answered reflexively. Mentioning a bot's name gets a reply. Anything else goes through an evaluator that knows the persona and decides between a reply, a reaction and silence, with "one turn per thought" as the rule: a correction to something it already answered gets nothing, but the person it is talking with picking the thread back up gets a hearing however recently it spoke. Nothing in code gates that call; whether a bot is talking too much is the evaluator's judgement from the conversation and the persona. The evaluator sees the same clock the bot does, so "it's 3 AM for her" is only said at 3 AM.

**Who's here.** Both prompts get the channel's member list with away status (IRCv3 away-notify and WHO) and whether someone is typing, so a bot doesn't ask things of someone asleep, and a lurker who is merely auto-afk still counts as company.

**Things to say.** A shared director watches every channel. When one has been quiet past a threshold drawn fresh each time, someone is around and nobody is typing, it offers the floor to one bot, by weighted draw, and the channel is then closed to all of them for a while. The bot gets material: a few of its persona's seeds for the day (a roommate incident, a headstone it noticed, a Three Laws clause), sometimes the answer to one of its news queries looked up through a shared cache, its day, and its notes on everyone present so it can ask after someone. Saying nothing is allowed. The same seeds ride along in every reply prompt as "on your mind today", so a bot in a DM has something of its own to bring up instead of only bouncing your line back.

**A voice that doesn't loop.** A model at temperature copies whatever is on its own screen, so a pet name used three times becomes every line. Before each reply the bot's last thirty lines in that conversation are scanned for what recurs: phrases, words, emoji, the same opener, lines that end by telling the other person what to do, reactions that are all one thing. What recurs is named in the prompt ("old man" 15 times, 💀 in 18 lines, 11 lines ending on an order) and the bot is told to rest it. The Archivist paraphrases rather than quoting, so a catchphrase that scrolls off the screen doesn't come back as memory. A mild frequency penalty does the rest.

**The medium, properly.** IRCv3 reactions (`+draft/react`) as TAGMSGs, sent and seen, shown inline on the lines they belong to; threaded replies (`+draft/reply`) when the line being answered is far enough back; typing indicators; `draft/multiline` so a long reply arrives as one message with one msgid, and other people's multi-paragraph messages arrive whole; `echo-message` to learn its own msgids; `display-name` and `avatar` metadata; the server's bot mode. Timestamps everywhere are in the bot's timezone.

**Tools.** Web search (Kagi FastGPT) and page fetch (Readability) for things the character wouldn't know, Python for arithmetic that has to be right, and automatic summaries of shared links (Kagi Universal Summarizer) so the bot can discuss an article without fetching it again. The personas say when they'd use them: Layla looks things up and relays them in her own voice; Isaac just reads the facts.

**Many bots, one process.** Bots see each other as ordinary users. There is no special handling for bot-on-bot conversation, by decision; personas and the evaluator are the brake. One dashboard with a bot picker shows each one's decisions, prompts, responses, journals and people.

## How it works

### Deciding to speak
Every line in a configured channel is stored. A debounce waits for the conversation to settle (each new line pushes it back, up to a deadline; a line naming the bot pulls the deadline in). Then the evaluator is asked. There is no gate in code before it: an earlier version held back unaddressed lines until a few messages and seconds had passed since the bot last spoke, and in a slow channel that gagged a bot for hours on the very person it was talking to. The evaluator is told the bot's share of recent lines as information, not as a limit, and that someone continuing a conversation with the bot without typing its name is still talking to it.

The evaluator picks `respond`, `react` or `ignore` with a reason, which lands in the decision log. A `react` names the line and the reaction; reactions have their own cooldown and never go on a bot's own line or one it already reacted to. Replies are generated from the screen: the last 50 lines however old, reaching further back to anything the journal hasn't read yet, with lulls marked rather than cut.

### The journal (memory)
Nothing about memory happens on the reply path. The Archivist runs per conversation once there are 40 new lines, or 20 quiet minutes with at least 5. It reads the lines since its last pass with the current journal and notes, and rewrites both whole: the journal in the bot's own attitude but in plain words, under about 1,500 characters, condensing the older part as it grows; each person's note under about 600. The watermark is stored with the journal, so a restart or a long backlog picks up exactly where it left off, in passes of 200 lines.

### Schedules
One block per line in the persona's `## Schedule`:

```
away weekdays 01:00-09:15 ~45m: asleep | zzz
away mon wed 10:00-11:20 ~10m: in class | in class 💀
here daily 18:30-19:30 ~20m: eating with your roommates
```

`<away|here> [days] HH:MM-HH:MM [~jitter]: activity [| away message]`. Days are `daily` (default), `weekdays`, `weekends`, names or ranges (`mon-fri`); a block belongs to the day it starts on. The jitter moves each edge by up to that much, differently each day but stable across restarts. Times are in the bot's `timezone`.

An `away` block makes the bot gone: away status set to the message, nothing read or answered (lines are still stored and journaled), and on return one look at every conversation that moved, with DMs answered. Before going, each channel with a recent human line gets an evaluator pass asking only whether vanishing silently would be odd; if so the bot says goodbye through the normal pipeline. A `here` block changes nothing mechanically; it tells the bot what it's doing (Isaac is docked and sluggish at 3:30 AM). Between blocks, `afk_minutes` after the bot's own last line its status becomes `afk since …`, cleared the moment it speaks.

### Unprompted lines
The shared `SilenceDirector` ticks each minute. For each channel it draws a quiet threshold between `quiet_min_minutes` and `quiet_max_minutes`, fresh after every attempt. When the channel has been quiet that long, someone reachable is present and nobody is typing, it picks one bot: candidates are those in the channel, not away, not busy, under their `max_per_day` and past their `min_gap_minutes`; weights are the bot's `weight`, cut to 0.3 if it filled the last silence there and divided by one plus the lines it has spoken unprompted today. The pick gets the floor through the reply model directly, with no evaluator, and whatever happens the channel is closed to every bot for `channel_gap_minutes`. A bot coming back from an away block gets one early look with a short threshold.

Material comes from the persona. `## Seeds` is a bulleted list of things the character would bring up; `seeds_per_day` of them are drawn per day in an order fixed by bot and date, and the window slides by one each time the bot speaks unprompted, so a used seed drops off. `## News` is a list of search queries; with probability `news_chance` one is looked up through a cache shared by all bots and handed to the bot as something it came across. The decision log shows `[spontaneous] spoke` or `stayed quiet`, with the query if one was used.

### Personas
`conf/personas/<name>.md`: a `# Name` heading and the character; then optional sections `## Evaluator` (who they are and what topics are theirs, for the should-I-speak model), `## Reactions` (which emoji or words, how often), `## Schedule`, `## Seeds` and `## News`. The evaluator is told that a topic outside the bot's subjects is a reason for silence only when the bot has no angle on it either: a question, or a view from their own corner, is in character; faking knowledge is not. The personas themselves say that tics expire and that a line needn't be shaped like the last one.

### Several bots
`bots` in `conf/config.json` lists them. Each entry names an `id` (its data directory and dashboard tab), a `nick`, a `persona` file, its `channels` and its NickServ `account`; any key under a bot's `irc`, `generator`, `autonomous`, `url_summarize`, `journal`, `context`, `presence` or `spontaneous` overrides the shared section. On irc.lurker.chat an oper registers each account with `/msg NickServ SAREGISTER <nick> <password>`; the bot sets `+B` on itself once connected.

### Bridged messages
Optional. If a bridge bot from [snitch](../snitch) sits in the channel, set `irc.bridge_nick` and `irc.bridge_tags` (the tags that are relayed humans, e.g. `["Discord", "libera", "mansion"]`). Its lines look like `[libera] <nick> text`; `classes/bridge_parser.js` unwraps the listed tags so responses address the human. Lines with any other tag (`[github] <user> opened …`) are announcements and are left alone unless someone asks. Without `irc.bridge_nick` nothing is unwrapped.

## Requirements

- **Node.js 20+**
- **Python 3** (for tool execution)
- **Docker** (optional)
- **DeepSeek API key**
- **Kagi API key** (optional: web search, news, link summaries)
- **OpenAI API key** (optional: vision, dormant on IRC)

## Setup

```sh
git clone https://github.com/amiantos/impostor.git
cd impostor
npm install
cp conf/config.json.example conf/config.json   # then fill in keys, server, bots

npm run dev      # development, auto-restart
npm start        # production
docker compose up -d --build
npm test
```

## Configuration

See `conf/config.json.example` for every option. The ones that shape behaviour:

| Section | Description |
|---------|-------------|
| `generator.deepseek` | Model, `temperature`, `max_tokens`; `thinking` (default `true`) and `evaluator_thinking` (`false`); `timeout_seconds` (300) and `max_retries` (1) |
| `generator.deepseek.frequency_penalty` / `presence_penalty` | On the reply call (0.3 / 0 unless set); the frequency penalty leans against echoing the screen, keep it under about 0.5 so the JSON envelope isn't penalised |
| `timezone` | IANA zone the bots live in; every timestamp they see is in it (default `America/Los_Angeles`, per-bot override allowed) |
| `irc` | Host, port, TLS; `max_line_length` (340); `multiline` (true: long replies go out as one IRCv3 message where the server supports it); `reactions` (true), `reaction_max_length` (24), `reply_min_distance` (5: a reply tag only when the line answered is at least this far back); `dm_delay_min_seconds`/`dm_delay_max_seconds` (2 to 6) before a DM reply; `typing_notifications`; optional `bridge_nick` and `bridge_tags` |
| `bots` | One entry per bot: `id`, `nick`, `persona`, `account`, `channels`, `pm_allowed_users`, optional `watchword` (what people call it, when it differs from the persona name), `display_name` and `avatar_url` (IRCv3 metadata, set or deleted on every connect), and per-bot overrides of the shared sections |
| `autonomous` | `debounce_seconds` (20), `max_wait_seconds` (60), `address_wait_seconds` (5); `react_cooldown_messages` (3) and `react_cooldown_seconds` (30) |
| `context` | `screen_lines` (50), `max_lines` (150), `lull_minutes` (30), `max_link_summaries` (5); `tic_lines` (30): how many of the bot's own lines the tic ledger reads, 0 disables it |
| `journal` | When the Archivist runs (`messages_per_pass` 40, `quiet_minutes` 20, `min_messages` 5) and how long a journal (`journal_max_chars` 1500) and a note (`note_max_chars` 600) may get |
| `presence` | `enabled`; `afk_minutes` (15) before the status becomes `afk_message` (`afk since {time}`; 0 disables); `linger_minutes` (15) past the start of an away block when mid-conversation; `goodbye_window_minutes` (10) |
| `spontaneous` | Shared: `quiet_min_minutes`/`quiet_max_minutes` (15/45), `channel_gap_minutes` (30), `typing_wait_seconds` (30), `news_cache_minutes` (360). Per bot (overridable in `bots[].spontaneous`): `max_per_day` (5), `min_gap_minutes` (60), `weight` (1), `seeds_per_day` (3), `news` (true), `news_chance` (0.35), `return_delay_min/max_minutes` (1 to 5) and `return_quiet_minutes` (5) for the look after coming back |
| `web` | Dashboard port and enablement |
| `kagi`, `url_summarize` | Kagi key; automatic link summaries |
| `vision`, `openai` | Image understanding (dormant on IRC) |

## Web dashboard

At `http://localhost:3000` when enabled, with a picker for the bot. Per bot: recent decisions with the evaluator's reason (including `[spontaneous] …`), responses with the full prompt that produced them (the `SAY IT DIFFERENTLY` block and the `ON YOUR MIND TODAY` line are visible there), the message database, and the journals and people notes with every version and the Archivist's rationale, editable, with a pass on demand.

## Data

Each bot's data is in `data/<bot id>/impostor.db` (SQLite): messages with link summaries, the server msgids they were sent under, every reaction seen, decisions with reasoning, responses, the full prompts, and the journals and notes with their history. Upgrading from the single-bot version moves `data/impostor.db` into the first bot's directory on first start.
