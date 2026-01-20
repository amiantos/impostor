const express = require("express");
const router = express.Router();

// Get overall stats
router.get("/stats", (req, res) => {
  try {
    const stats = req.db.getStats();
    res.json(stats);
  } catch (error) {
    req.logger.error("Error fetching stats:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Get list of active channels
router.get("/channels", (req, res) => {
  try {
    const channels = req.db.getActiveChannels();
    res.json(channels);
  } catch (error) {
    req.logger.error("Error fetching channels:", error);
    res.status(500).json({ error: "Failed to fetch channels" });
  }
});

// Get messages for a specific channel
router.get("/channels/:channelId/messages", (req, res) => {
  try {
    const { channelId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const messages = req.db.getRecentMessages(channelId, limit);
    res.json(messages);
  } catch (error) {
    req.logger.error("Error fetching channel messages:", error);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Get decisions for a specific channel
router.get("/channels/:channelId/decisions", (req, res) => {
  try {
    const { channelId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const decisions = req.db.getDecisionsByChannel(channelId, limit);
    res.json(decisions);
  } catch (error) {
    req.logger.error("Error fetching channel decisions:", error);
    res.status(500).json({ error: "Failed to fetch decisions" });
  }
});

// Get responses for a specific channel
router.get("/channels/:channelId/responses", (req, res) => {
  try {
    const { channelId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const responses = req.db.getResponsesByChannel(channelId, limit);
    res.json(responses);
  } catch (error) {
    req.logger.error("Error fetching channel responses:", error);
    res.status(500).json({ error: "Failed to fetch responses" });
  }
});

// Get recent decisions (all channels)
router.get("/decisions", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const decisions = req.db.getRecentDecisions(limit);
    res.json(decisions);
  } catch (error) {
    req.logger.error("Error fetching decisions:", error);
    res.status(500).json({ error: "Failed to fetch decisions" });
  }
});

// Get recent responses (all channels)
router.get("/responses", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const responses = req.db.getRecentResponses(limit);
    res.json(responses);
  } catch (error) {
    req.logger.error("Error fetching responses:", error);
    res.status(500).json({ error: "Failed to fetch responses" });
  }
});

module.exports = router;
