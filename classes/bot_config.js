/**
 * One config file runs several bots. Top-level sections are shared; each
 * entry in `bots` names a bot and may override `irc`, `generator`,
 * `autonomous`, `url_summarize`, `journal`, `context`, `presence` and `spontaneous` key by key. The result for a
 * bot has the same shape the single-bot code always read (`config.irc.nick`,
 * `config.generator.deepseek.model`, ...), plus a `bot` block with its id and
 * persona path.
 */

const REQUIRED = ["id", "nick", "persona"];

function listBots(config) {
  const bots = config?.bots;
  if (!Array.isArray(bots) || bots.length === 0) {
    throw new Error('config.bots must be a non-empty list; see conf/config.json.example');
  }
  const ids = new Set();
  const nicks = new Set();
  for (const bot of bots) {
    for (const key of REQUIRED) {
      if (!bot?.[key] || typeof bot[key] !== "string") {
        throw new Error(`Every bot needs a string "${key}" (got ${JSON.stringify(bot?.[key])})`);
      }
    }
    if (!/^[a-z0-9_-]+$/i.test(bot.id)) {
      throw new Error(`Bot id "${bot.id}" may only contain letters, digits, "-" and "_" (it names a directory)`);
    }
    for (const key of ["nick", "username", "realname", "channels", "pm_allowed_users", "watchword", "password", "sasl", "account", "avatar_url", "display_name"]) {
      if (bot.irc?.[key] !== undefined) {
        throw new Error(`Bot "${bot.id}": irc.${key} belongs at the bot's top level, not under irc`);
      }
    }
    if (bot.display_name !== undefined && (typeof bot.display_name !== "string" || !bot.display_name.trim())) {
      throw new Error(`Bot "${bot.id}": display_name must be a non-empty string`);
    }
    if (bot.avatar_url !== undefined && !/^https?:\/\/\S+$/.test(bot.avatar_url)) {
      throw new Error(`Bot "${bot.id}": avatar_url must be an http(s) URL`);
    }
    for (const key of ["api_key", "base_url"]) {
      if (bot.generator?.[key] !== undefined) {
        throw new Error(`Bot "${bot.id}": generator.${key} is shared by every bot; set it at the top level`);
      }
    }
    for (const key of ["channels", "pm_allowed_users", "bridge_tags"]) {
      const value = key === "bridge_tags" ? bot.irc?.[key] : bot[key];
      if (value !== undefined && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) {
        throw new Error(`Bot "${bot.id}": "${key}" must be a list of strings`);
      }
    }
    const id = bot.id.toLowerCase();
    const nick = bot.nick.toLowerCase();
    if (ids.has(id)) throw new Error(`Two bots share the id "${bot.id}"`);
    if (nicks.has(nick)) throw new Error(`Two bots share the nick "${bot.nick}"`);
    ids.add(id);
    nicks.add(nick);
  }
  return bots;
}

function resolveBotConfig(shared, bot) {
  const sharedIrc = shared.irc || {};
  const irc = {
    ...sharedIrc,
    ...(bot.irc || {}),
    nick: bot.nick,
    username: bot.username || bot.nick.toLowerCase(),
    realname: bot.realname || bot.nick,
    channels: bot.channels || [],
    pm_allowed_users: bot.pm_allowed_users || [],
    // What people call the bot in chat; the persona's name fills it in later
    // when unset (see ImpostorClient).
    watchword: bot.watchword || null,
    // Shown by clients that render IRCv3 metadata (Lurker): sent as the
    // `avatar` key after every registration. Must be a public URL.
    avatar_url: bot.avatar_url || null,
    // The `display-name` key; nothing is sent when unset.
    display_name: bot.display_name || null,
  };

  if (bot.account?.password) {
    irc.sasl = true;
    irc.account = bot.account.name || bot.nick;
    irc.password = bot.account.password;
  } else {
    irc.sasl = false;
    delete irc.account;
    delete irc.password;
  }

  const generator = {
    ...(shared.generator || {}),
    deepseek: { ...(shared.generator?.deepseek || {}), ...(bot.generator || {}) },
  };

  return {
    ...shared,
    irc,
    generator,
    autonomous: { ...(shared.autonomous || {}), ...(bot.autonomous || {}) },
    url_summarize: { ...(shared.url_summarize || {}), ...(bot.url_summarize || {}) },
    journal: { ...(shared.journal || {}), ...(bot.journal || {}) },
    context: { ...(shared.context || {}), ...(bot.context || {}) },
    presence: { ...(shared.presence || {}), ...(bot.presence || {}) },
    spontaneous: { ...(shared.spontaneous || {}), ...(bot.spontaneous || {}) },
    // The zone every timestamp the bot sees is rendered in; a bot may live
    // somewhere else than the others.
    timezone: bot.timezone || shared.timezone || undefined,
    // Lowercased: it names the data directory and the dashboard's ?bot= key.
    bot: { id: bot.id.toLowerCase(), persona: bot.persona },
    bots: undefined,
  };
}

module.exports = { listBots, resolveBotConfig };
