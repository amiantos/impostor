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
// Supports ?includeRelations=true to include parsed JSON fields
router.get("/channels/:channelId/messages", (req, res) => {
  try {
    const { channelId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const includeRelations = req.query.includeRelations === "true";

    const messages = req.db.getRecentMessages(channelId, limit, includeRelations);
    res.json(messages);
  } catch (error) {
    req.logger.error("Error fetching channel messages:", error);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Get a single message by ID with full details
router.get("/messages/:messageId", (req, res) => {
  try {
    const { messageId } = req.params;
    const message = req.db.getMessage(messageId);

    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    res.json(message);
  } catch (error) {
    req.logger.error("Error fetching message:", error);
    res.status(500).json({ error: "Failed to fetch message" });
  }
});

// Get a message with related data
// Returns different data structure for bot vs non-bot messages
router.get("/messages/:messageId/relations", (req, res) => {
  try {
    const { messageId } = req.params;

    // First, get the message to check if it's a bot message
    const message = req.db.getMessage(messageId);
    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    if (message.is_bot_message) {
      // Bot message: return comprehensive decision/response details
      const result = req.db.getBotMessageDetails(messageId);
      if (!result) {
        return res.status(404).json({ error: "Message not found" });
      }
      res.json({ ...result, type: 'bot' });
    } else {
      // Non-bot message: return simplified view (no decision/response clutter)
      res.json({
        message,
        type: 'user'
      });
    }
  } catch (error) {
    req.logger.error("Error fetching message relations:", error);
    res.status(500).json({ error: "Failed to fetch message relations" });
  }
});

// Get stored prompt by response ID
router.get("/responses/:responseId/prompt", (req, res) => {
  try {
    const responseId = parseInt(req.params.responseId);
    const prompt = req.db.getPromptByResponse(responseId);

    if (!prompt) {
      return res.status(404).json({ error: "Prompt not found" });
    }

    res.json(prompt);
  } catch (error) {
    req.logger.error("Error fetching prompt:", error);
    res.status(500).json({ error: "Failed to fetch prompt" });
  }
});

// Get stored prompt by decision ID
router.get("/decisions/:decisionId/prompt", (req, res) => {
  try {
    const decisionId = parseInt(req.params.decisionId);
    const prompt = req.db.getPromptByDecision(decisionId);

    if (!prompt) {
      return res.status(404).json({ error: "Prompt not found" });
    }

    res.json(prompt);
  } catch (error) {
    req.logger.error("Error fetching prompt:", error);
    res.status(500).json({ error: "Failed to fetch prompt" });
  }
});

// Get a single response by ID
router.get("/responses/:responseId", (req, res) => {
  try {
    const responseId = parseInt(req.params.responseId);
    const response = req.db.getResponse(responseId);

    if (!response) {
      return res.status(404).json({ error: "Response not found" });
    }

    res.json(response);
  } catch (error) {
    req.logger.error("Error fetching response:", error);
    res.status(500).json({ error: "Failed to fetch response" });
  }
});

// Get a single decision by ID
router.get("/decisions/:decisionId", (req, res) => {
  try {
    const decisionId = parseInt(req.params.decisionId);
    const decision = req.db.getDecision(decisionId);

    if (!decision) {
      return res.status(404).json({ error: "Decision not found" });
    }

    res.json(decision);
  } catch (error) {
    req.logger.error("Error fetching decision:", error);
    res.status(500).json({ error: "Failed to fetch decision" });
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

// Get messages with bulk relations for chat view (all channels)
router.get("/chat", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const result = req.db.getMessagesWithRelations(null, limit);
    res.json(result);
  } catch (error) {
    req.logger.error("Error fetching chat data:", error);
    res.status(500).json({ error: "Failed to fetch chat data" });
  }
});

// Get messages with bulk relations for chat view (specific channel)
router.get("/channels/:channelId/chat", (req, res) => {
  try {
    const { channelId } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const result = req.db.getMessagesWithRelations(channelId, limit);
    res.json(result);
  } catch (error) {
    req.logger.error("Error fetching chat data:", error);
    res.status(500).json({ error: "Failed to fetch chat data" });
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

// ============ Bots ============

// Every bot the dashboard can show
router.get("/bots", (req, res) => {
  res.json([...req.clients.values()].map((client) => client.describe()));
});

// ============ Journals and people (the Archivist) ============

router.get("/journals", (req, res) => {
  try {
    res.json(req.db.listJournals());
  } catch (error) {
    req.logger.error("Error listing journals:", error);
    res.status(500).json({ error: "Failed to list journals" });
  }
});

router.get("/journals/:conversationId", (req, res) => {
  try {
    const { conversationId } = req.params;
    const journal = req.db.getJournal(conversationId);
    if (!journal) return res.status(404).json({ error: "No journal for that conversation" });
    res.json({
      journal,
      versions: req.db.getJournalVersions(conversationId),
      unread: req.client.archivist.unreadCount(conversationId),
    });
  } catch (error) {
    req.logger.error("Error fetching journal:", error);
    res.status(500).json({ error: "Failed to fetch journal" });
  }
});

// Edit a journal by hand; kept as a version like any other change
router.patch("/journals/:conversationId", (req, res) => {
  try {
    const { content } = req.body || {};
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content must be a string" });
    }
    req.db.setJournal(req.params.conversationId, content.trim(), { source: "edit" });
    res.json({ success: true, journal: req.db.getJournal(req.params.conversationId) });
  } catch (error) {
    req.logger.error("Error updating journal:", error);
    res.status(500).json({ error: "Failed to update journal" });
  }
});

// Forget a journal and its history; the next pass rereads the whole backlog
router.delete("/journals/:conversationId", (req, res) => {
  try {
    const removed = req.db.deleteJournal(req.params.conversationId);
    if (!removed) return res.status(404).json({ error: "No journal for that conversation" });
    res.json({ success: true });
  } catch (error) {
    req.logger.error("Error deleting journal:", error);
    res.status(500).json({ error: "Failed to delete journal" });
  }
});

// Run an Archivist pass now, without waiting for the triggers
router.post("/journals/:conversationId/run", async (req, res) => {
  try {
    const result = await req.client.archivist.runPass(req.params.conversationId);
    res.json({ success: true, ...result, journal: req.db.getJournal(req.params.conversationId) });
  } catch (error) {
    req.logger.error("Error running an Archivist pass:", error);
    res.status(500).json({ error: `Archivist pass failed: ${error.message}` });
  }
});

router.get("/people", (req, res) => {
  try {
    res.json(req.db.listPeople());
  } catch (error) {
    req.logger.error("Error listing people:", error);
    res.status(500).json({ error: "Failed to list people" });
  }
});

router.get("/people/:nick", (req, res) => {
  try {
    const person = req.db.getPerson(req.params.nick);
    if (!person) return res.status(404).json({ error: "No note for that nick" });
    res.json({ person, versions: req.db.getPersonVersions(req.params.nick) });
  } catch (error) {
    req.logger.error("Error fetching person:", error);
    res.status(500).json({ error: "Failed to fetch person" });
  }
});

router.patch("/people/:nick", (req, res) => {
  try {
    const { content } = req.body || {};
    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "content must be a non-empty string" });
    }
    const existing = req.db.getPerson(req.params.nick);
    req.db.setPerson(existing?.nick || req.params.nick, content.trim(), { source: "edit" });
    res.json({ success: true, person: req.db.getPerson(req.params.nick) });
  } catch (error) {
    req.logger.error("Error updating person:", error);
    res.status(500).json({ error: "Failed to update person" });
  }
});

router.delete("/people/:nick", (req, res) => {
  try {
    const removed = req.db.deletePerson(req.params.nick);
    if (!removed) return res.status(404).json({ error: "No note for that nick" });
    res.json({ success: true });
  } catch (error) {
    req.logger.error("Error deleting person:", error);
    res.status(500).json({ error: "Failed to delete person" });
  }
});

module.exports = router;
