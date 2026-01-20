const express = require("express");
const path = require("path");
const apiRoutes = require("./routes/api");

class WebServer {
  constructor(logger, config, database) {
    this.logger = logger;
    this.config = config;
    this.db = database;
    this.app = express();
    this.server = null;

    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // Serve static files
    this.app.use("/public", express.static(path.join(__dirname, "public")));

    // Parse JSON bodies
    this.app.use(express.json());

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
