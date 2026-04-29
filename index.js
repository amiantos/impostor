const config = require("./conf/config.json");
const Logger = require("./classes/logger");
const ImpostorClient = require("./classes/impostor_client");
const WebServer = require("./web/server");
const DiscordBridge = require("./classes/discord_bridge");

// Instantiate
const logger = new Logger(true); // Enable debug mode
const client = new ImpostorClient(logger, config);

// Start the Discord bridge if enabled (must come before WebServer so the
// webhook router can announce via EyeBridge)
let discordBridge = null;
if (config.discord?.enabled) {
  discordBridge = new DiscordBridge(logger, config, client.getDatabase());
  discordBridge.start();
}

// Start the web dashboard if enabled
let webServer = null;
if (config.web?.enabled) {
  webServer = new WebServer(
    logger,
    config,
    client.getDatabase(),
    client,
    discordBridge
  );
  webServer.start();
}

// Start the bot
client.connect();

// Handle graceful shutdown
process.on("SIGINT", () => {
  logger.info("Shutting down...");
  if (discordBridge) discordBridge.stop();
  if (webServer) webServer.stop();
  client.shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Shutting down...");
  if (discordBridge) discordBridge.stop();
  if (webServer) webServer.stop();
  client.shutdown();
  process.exit(0);
});
