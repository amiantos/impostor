const express = require("express");
const path = require("path");
const apiRoutes = require("./routes/api");

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
