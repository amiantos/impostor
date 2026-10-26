const express = require("express");
const path = require("path");
const apiRoutes = require("./routes/api");

/**
 * One dashboard for every bot. Each API request names a bot with `?bot=<id>`
 * (the first bot when omitted) and reads that bot's database.
 */
class WebServer {
  /**
   * @param {Object} logger
   * @param {Object} config - The shared config
   * @param {Map<string, Object>} clients - Bot id -> ImpostorClient
   */
  constructor(logger, config, clients) {
    this.logger = logger;
    this.config = config;
    this.clients = clients;
    this.app = express();
    this.server = null;

    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(express.json());

    // Basic auth for dashboard (skip for health endpoint)
    const authConfig = this.config.web?.auth;
    if (authConfig?.username && authConfig?.password) {
      this.app.use((req, res, next) => {
        if (req.path === "/health") return next();

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Basic ")) {
          res.setHeader("WWW-Authenticate", 'Basic realm="Impostor Dashboard"');
          return res.status(401).send("Authentication required");
        }

        const credentials = Buffer.from(authHeader.slice(6), "base64").toString();
        const [username, password] = credentials.split(":");
        if (username === authConfig.username && password === authConfig.password) {
          return next();
        }

        res.setHeader("WWW-Authenticate", 'Basic realm="Impostor Dashboard"');
        return res.status(401).send("Invalid credentials");
      });
    }

    // Serve static files
    this.app.use("/public", express.static(path.join(__dirname, "public")));

    // Serve cached images
    this.app.use("/images", express.static(path.join(__dirname, "..", "data", "images")));

    // Resolve the bot a request is about, and hand its database to the route.
    this.app.use("/api", (req, res, next) => {
      req.logger = this.logger;
      req.clients = this.clients;
      if (req.path === "/bots") return next();
      const id = typeof req.query.bot === "string" ? req.query.bot.toLowerCase() : null;
      const client = id ? this.clients.get(id) : this.clients.values().next().value;
      if (!client) {
        return res.status(404).json({ error: id ? `No bot "${id}"` : "No bots configured" });
      }
      req.client = client;
      req.db = client.getDatabase();
      next();
    });
  }

  setupRoutes() {
    // API routes
    this.app.use("/api", apiRoutes);

    // Dashboard page
    this.app.get("/", (req, res) => {
      res.sendFile(path.join(__dirname, "views", "dashboard.html"));
    });

    // Health check
    this.app.get("/health", (req, res) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    });
  }

  start() {
    const port = this.config.web?.port || 3000;

    this.server = this.app.listen(port, () => {
      this.logger.info(`Web dashboard running at http://localhost:${port}`);
    });

    return this.server;
  }

  stop() {
    if (this.server) {
      this.server.close(() => {
        this.logger.info("Web server stopped");
      });
    }
  }
}

module.exports = WebServer;
