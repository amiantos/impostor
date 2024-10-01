const config = require("./conf/config.json");
const Logger = require("./classes/logger");
const ImpostorClient = require("./classes/impostor_client");

// Instantiate
const logger = new Logger((debug = false));
const client = new ImpostorClient(logger, config);

// Start the bot
client.login();
