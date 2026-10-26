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
const WebServer = require("./web/server");

const logger = new Logger(true);
const dataDir = path.join(__dirname, "data");

// One model client and one set of tools for every bot.
const openai = new OpenAI({
  apiKey: config.generator.deepseek.api_key,
  baseURL: config.generator.deepseek.base_url,
});
const tools = {
  pythonTool: new PythonTool(logger),
  webSearchTool: new WebSearchTool(logger, config),
  webFetchTool: new WebFetchTool(logger),
};

const clients = new Map();
for (const bot of listBots(config)) {
  const botConfig = resolveBotConfig(config, bot);
  const persona = loadPersona(path.resolve(__dirname, bot.persona));
  const client = new ImpostorClient(logger.child(bot.id), botConfig, {
    openai,
    persona,
    tools,
    dataDir,
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

function shutdown() {
  logger.info("Shutting down...");
  if (webServer) webServer.stop();
  for (const client of clients.values()) client.shutdown();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
