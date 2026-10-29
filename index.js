const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
const config = require("./conf/config.json");
const Logger = require("./classes/logger");
const ImpostorClient = require("./classes/impostor_client");
const PythonTool = require("./classes/python_tool");
const WebSearchTool = require("./classes/web_search_tool");
const WebFetchTool = require("./classes/web_fetch_tool");
const { listBots, resolveBotConfig } = require("./classes/bot_config");
const { loadPersona } = require("./classes/persona");
const { SilenceDirector, NewsDesk } = require("./classes/spontaneity");
const { WeatherDesk } = require("./classes/weather");
const WebServer = require("./web/server");

const logger = new Logger(true);
const dataDir = path.join(__dirname, "data");

// One model client and one set of tools for every bot. The SDK's defaults
// (a ten-minute timeout, two silent retries) let a slow answer keep a bot
// "typing" for half an hour; a chat reply that takes longer than this is
// better given up on.
const openai = new OpenAI({
  apiKey: config.generator.deepseek.api_key,
  baseURL: config.generator.deepseek.base_url,
  timeout: (config.generator.deepseek.timeout_seconds ?? 300) * 1000,
  maxRetries: config.generator.deepseek.max_retries ?? 1,
});
const tools = {
  pythonTool: new PythonTool(logger),
  webSearchTool: new WebSearchTool(logger, config),
  webFetchTool: new WebFetchTool(logger),
};

const bots = listBots(config);

// One director for every bot, so one of them at a time is offered a quiet
// channel, and one news cache so they don't all run the same search.
const director = new SilenceDirector({ logger: logger.child("silence"), config: config.spontaneous || {} });
const newsDesk = new NewsDesk({ search: tools.webSearchTool, ttlMinutes: config.spontaneous?.news_cache_minutes ?? 360 });
// One weather cache: bots at the same place share a lookup.
const weatherDesk = new WeatherDesk({ logger: logger.child("weather"), ttlMinutes: config.weather_cache_minutes ?? 60 });

// Before bots had ids the one database lived at data/impostor.db. Move it
// under the first bot once, so a deployment keeps its history.
const legacyDb = path.join(dataDir, "impostor.db");
const firstDir = path.join(dataDir, bots[0].id.toLowerCase());
if (fs.existsSync(legacyDb) && !fs.existsSync(path.join(firstDir, "impostor.db"))) {
  fs.mkdirSync(firstDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(legacyDb + suffix)) {
      fs.renameSync(legacyDb + suffix, path.join(firstDir, "impostor.db" + suffix));
    }
  }
  logger.info(`Moved data/impostor.db to data/${bots[0].id.toLowerCase()}/impostor.db`);
}

const clients = new Map();
for (const bot of bots) {
  const botConfig = resolveBotConfig(config, bot);
  const persona = loadPersona(path.resolve(__dirname, bot.persona));
  const client = new ImpostorClient(logger.child(bot.id), botConfig, {
    openai,
    persona,
    tools,
    dataDir,
    director,
    newsDesk,
    weatherDesk,
  });
  clients.set(client.id, client);
  logger.info(`Bot "${client.id}" is ${persona.name} as ${bot.nick} in ${(bot.channels || []).join(", ") || "no channels"}`);
}

let webServer = null;
if (config.web?.enabled) {
  webServer = new WebServer(logger, config, clients);
  webServer.start();
}

for (const client of clients.values()) {
  client.connect();
}
director.start();

function shutdown() {
  logger.info("Shutting down...");
  if (webServer) webServer.stop();
  director.stop();
  for (const client of clients.values()) client.shutdown();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
