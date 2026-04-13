const { Client, GatewayIntentBits } = require("discord.js");
const IRC = require("irc-framework");

class DiscordBridge {
  constructor(logger, config) {
    this.logger = logger;
    this.config = config;
    this.discordConfig = config.discord;

    this.bridgeNick = this.discordConfig.bridge_nick || "EyeBridge";
    this.ircChannel = this.discordConfig.irc_channel;
    this.discordChannelId = this.discordConfig.discord_channel;

    // Discord client
    this.discordClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // IRC client (separate connection from ImpostorClient)
    this.ircClient = new IRC.Client();

    // Cached Discord channel
    this.discordChannel = null;

    // Track readiness
    this.discordReady = false;
    this.ircReady = false;

    // Reconnect backoff state
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.shuttingDown = false;
    this.ircConnectOpts = null;
  }

  start() {
    this.logger.info(`Discord bridge starting (IRC nick: ${this.bridgeNick})`);

    this._setupDiscordHandlers();
    this._setupIrcHandlers();

    // Connect Discord
    this.discordClient.login(this.discordConfig.token);

    // Connect IRC
    const ircConnectOpts = {
      host: this.config.irc.host,
      port: this.config.irc.port || 6697,
      tls: this.config.irc.tls !== false,
      nick: this.bridgeNick,
      username: this.bridgeNick.toLowerCase(),
      gecos: "Discord-IRC Bridge",
      auto_reconnect: false, // We handle reconnection ourselves with exponential backoff
    };

    if (this.discordConfig.bridge_sasl && this.discordConfig.bridge_password) {
      ircConnectOpts.account = {
        account: this.bridgeNick,
        password: this.discordConfig.bridge_password,
      };
    }

    this.ircConnectOpts = ircConnectOpts;
    this.ircClient.connect(ircConnectOpts);
  }

  stop() {
    this.logger.info("Discord bridge stopping");
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.discordClient.destroy();
    this.ircClient.quit("Bridge shutting down");
  }

  _scheduleIrcReconnect() {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.logger.info(`Discord bridge reconnecting to IRC in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
      try {
        this.ircClient.connect(this.ircConnectOpts);
      } catch (err) {
        this.logger.error(`Discord bridge IRC reconnect failed: ${err.message}`);
        this._scheduleIrcReconnect();
      }
    }, delay);
  }

  _setupDiscordHandlers() {
    this.discordClient.on("ready", async () => {
      this.logger.info(
        `Discord bridge logged in as ${this.discordClient.user.tag}`
      );
      try {
        this.discordChannel = await this.discordClient.channels.fetch(
          this.discordChannelId
        );
        this.discordReady = true;
        this.logger.info(
          `Discord bridge linked to #${this.discordChannel.name}`
        );
      } catch (err) {
        this.logger.error(
          `Discord bridge failed to fetch channel ${this.discordChannelId}: ${err.message}`
        );
      }
    });

    this.discordClient.on("messageCreate", (message) => {
      this._onDiscordMessage(message);
    });

    this.discordClient.on("error", (err) => {
      this.logger.error(`Discord bridge error: ${err.message}`);
    });
  }

  _setupIrcHandlers() {
    this.ircClient.on("registered", () => {
      this.reconnectDelay = 1000;
      this.logger.info(
        `Discord bridge connected to IRC as ${this.bridgeNick}`
      );
      this.ircClient.join(this.ircChannel);
    });

    this.ircClient.on("join", (event) => {
      if (event.nick === this.bridgeNick) {
        this.ircReady = true;
        this.logger.info(
          `Discord bridge joined IRC channel ${event.channel}`
        );
      }
    });

    this.ircClient.on("privmsg", (event) => {
      this._onIrcMessage(event);
    });

    this.ircClient.on("action", (event) => {
      this._onIrcAction(event);
    });

    this.ircClient.on("close", () => {
      this.ircReady = false;
      this.logger.info("Discord bridge IRC connection closed");
      this._scheduleIrcReconnect();
    });
  }

  /**
   * Handle a Discord message and forward it to IRC
   */
  _onDiscordMessage(message) {
    // Ignore own messages (echo prevention)
    if (message.author.id === this.discordClient.user.id) return;

    // Ignore other bots
    if (message.author.bot) return;

    // Only bridge the configured channel
    if (message.channel.id !== this.discordChannelId) return;

    // Don't forward if IRC isn't ready
    if (!this.ircReady) return;

    const username = message.member?.displayName || message.author.displayName || message.author.username;
    const content = this._cleanDiscordContent(message);

    // Build lines to send
    const lines = [];

    if (content) {
      // Split multiline Discord messages
      for (const paragraph of content.split("\n")) {
        if (paragraph.trim()) {
          lines.push(`[discord] ${username}: ${paragraph}`);
        }
      }
    }

    // Append attachment URLs
    for (const attachment of message.attachments.values()) {
      lines.push(`[discord] ${username}: ${attachment.url}`);
    }

    if (lines.length === 0) return;

    // Split and send each line respecting IRC length limits
    const maxLen = this.config.irc.max_line_length || 400;
    for (const line of lines) {
      const splitLines = this._splitMessage(line, maxLen);
      for (const splitLine of splitLines) {
        this.ircClient.say(this.ircChannel, splitLine);
      }
    }
  }

  /**
   * Handle an IRC message and forward it to Discord
   */
  _onIrcMessage(event) {
    // Ignore own messages (echo prevention)
    if (event.nick.toLowerCase() === this.bridgeNick.toLowerCase()) return;

    // Only bridge the configured channel
    if (
      !event.target ||
      event.target.toLowerCase() !== this.ircChannel.toLowerCase()
    )
      return;

    // Don't forward if Discord isn't ready
    if (!this.discordReady || !this.discordChannel) return;

    const formatted = `[irc] **${event.nick}:** ${event.message}`;
    this._sendToDiscord(formatted);
  }

  /**
   * Handle an IRC /me action and forward it to Discord
   */
  _onIrcAction(event) {
    // Ignore own actions
    if (event.nick.toLowerCase() === this.bridgeNick.toLowerCase()) return;

    // Only bridge the configured channel
    if (
      !event.target ||
      event.target.toLowerCase() !== this.ircChannel.toLowerCase()
    )
      return;

    // Don't forward if Discord isn't ready
    if (!this.discordReady || !this.discordChannel) return;

    const formatted = `*\\*[irc] ${event.nick} ${event.message}*`;
    this._sendToDiscord(formatted);
  }

  /**
   * Announce a first-party message to both IRC and Discord.
   * Used for things like GitHub webhook events.
   */
  announce(message) {
    if (!message) return;

    if (this.ircReady) {
      const maxLen = this.config.irc.max_line_length || 400;
      for (const line of this._splitMessage(message, maxLen)) {
        this.ircClient.say(this.ircChannel, line);
      }
    } else {
      this.logger.warn(
        `Discord bridge announce: IRC not ready, skipping IRC side: ${message}`
      );
    }

    if (this.discordReady && this.discordChannel) {
      this._sendToDiscord(message);
    } else {
      this.logger.warn(
        `Discord bridge announce: Discord not ready, skipping Discord side: ${message}`
      );
    }
  }

  /**
   * Send a message to Discord, truncating if needed
   */
  _sendToDiscord(text) {
    // Discord has a 2000 character limit
    if (text.length > 2000) {
      text = text.substring(0, 1997) + "...";
    }

    this.discordChannel.send(text).catch((err) => {
      this.logger.error(`Discord bridge failed to send to Discord: ${err.message}`);
    });
  }

  /**
   * Clean Discord message content for IRC display
   * Resolves mentions, channels, roles, and custom emoji
   */
  _cleanDiscordContent(message) {
    let content = message.content;

    // Replace user mentions <@123> or <@!123> with display names
    content = content.replace(/<@!?(\d+)>/g, (match, id) => {
      const user = message.mentions.users.get(id);
      if (user) {
        const member = message.mentions.members?.get(id);
        return `@${member?.displayName || user.displayName || user.username}`;
      }
      return match;
    });

    // Replace channel mentions <#123> with channel names
    content = content.replace(/<#(\d+)>/g, (match, id) => {
      const channel = message.mentions.channels.get(id);
      return channel ? `#${channel.name}` : match;
    });

    // Replace role mentions <@&123> with role names
    content = content.replace(/<@&(\d+)>/g, (match, id) => {
      const role = message.mentions.roles.get(id);
      return role ? `@${role.name}` : match;
    });

    // Replace custom emoji <:name:123> or <a:name:123> with :name:
    content = content.replace(/<a?:(\w+):\d+>/g, ":$1:");

    return content;
  }

  /**
   * Split a message into IRC-friendly lines (copied from ImpostorClient)
   */
  _splitMessage(text, maxLen) {
    const urlRegex = /https?:\/\/\S+/g;
    const lines = [];
    for (const paragraph of text.split("\n")) {
      if (paragraph.length === 0) continue;
      if (paragraph.length <= maxLen) {
        lines.push(paragraph);
      } else {
        let remaining = paragraph;
        while (remaining.length > maxLen) {
          let splitAt = remaining.lastIndexOf(" ", maxLen);
          if (splitAt === -1) splitAt = maxLen;

          const urlMatches = [...remaining.matchAll(urlRegex)];
          for (const match of urlMatches) {
            const urlStart = match.index;
            const urlEnd = urlStart + match[0].length;
            if (splitAt > urlStart && splitAt < urlEnd) {
              const beforeUrl = remaining.lastIndexOf(" ", urlStart);
              if (beforeUrl > 0) {
                splitAt = beforeUrl;
              } else if (urlEnd <= maxLen + 50) {
                splitAt = urlEnd;
              }
              break;
            }
          }

          lines.push(remaining.substring(0, splitAt));
          remaining = remaining.substring(splitAt).trimStart();
        }
        if (remaining) lines.push(remaining);
      }
    }
    return lines.length > 0 ? lines : [""];
  }
}

module.exports = DiscordBridge;
