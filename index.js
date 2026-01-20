const config = require("./conf/config.json");
const Logger = require("./classes/logger");
const ImpostorClient = require("./classes/impostor_client");
const WebServer = require("./web/server");

// Instantiate
const logger = new Logger(true); // Enable debug mode
const client = new ImpostorClient(logger, config);

// Start the web dashboard if enabled
let webServer = null;
if (config.web?.enabled) {
  webServer = new WebServer(logger, config, client.getDatabase());
  webServer.start();
}

// Start the bot
client.login();

// Handle graceful shutdown
process.on("SIGINT", () => {
  logger.info("Shutting down...");
  if (webServer) webServer.stop();
  client.shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Shutting down...");
  if (webServer) webServer.stop();
  client.shutdown();
  process.exit(0);
});
