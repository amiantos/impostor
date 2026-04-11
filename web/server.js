const express = require("express");
const path = require("path");
const apiRoutes = require("./routes/api");
const { createWebhookRouter } = require("../classes/github_webhook");

class WebServer {
  constructor(logger, config, database, client) {
    this.logger = logger;
    this.config = config;
    this.db = database;
    this.client = client;
    this.app = express();
    this.server = null;

    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // Serve static files
    this.app.use("/public", express.static(path.join(__dirname, "public")));

    // Parse JSON bodies (capture raw body for webhook signature verification)
    this.app.use(
      express.json({
        verify: (req, _res, buf) => {
          req.rawBody = buf;
        },
      })
    );

    // Add database to request
    this.app.use((req, res, next) => {
      req.db = this.db;
      req.logger = this.logger;
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

    // GitHub webhook
    if (this.config.github_webhook?.enabled) {
      this.app.use(
        "/webhook",
        createWebhookRouter(this.client, this.config, this.logger)
      );
    }

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
