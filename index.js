const config = require("./conf/config.json");
const Logger = require("./classes/logger");
const ImpostorClient = require("./classes/impostor_client");
const WebServer = require("./web/server");

const logger = new Logger(true);
const client = new ImpostorClient(logger, config);

let webServer = null;
if (config.web?.enabled) {
  webServer = new WebServer(logger, config, client.getDatabase(), client);
  webServer.start();
}

client.connect();

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
