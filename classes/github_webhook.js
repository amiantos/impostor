const crypto = require("crypto");
const express = require("express");

// --- Signature verification ---

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = Buffer.from(
    "sha256=" +
      crypto.createHmac("sha256", secret).update(rawBody).digest("hex"),
    "utf8"
  );
  const actual = Buffer.from(signatureHeader, "utf8");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// --- Message formatters (plain text for IRC) ---

function formatFork(payload) {
  const user = payload.sender.login;
  const repo = payload.repository.full_name;
  const forkName = payload.forkee.full_name;
  const url = payload.forkee.html_url;
  return `🍴 ${user} forked ${repo} → ${url}`;
}

function formatIssue(payload) {
  const action = payload.action;
  if (!["opened", "closed", "reopened"].includes(action)) return null;
  const user = payload.sender.login;
  const repo = payload.repository.full_name;
  const issue = payload.issue;
  return `📋 ${user} ${action} issue #${issue.number}: ${issue.title} in ${repo} → ${issue.html_url}`;
}

function formatPullRequest(payload) {
  const action = payload.action;
  if (!["opened", "closed", "reopened"].includes(action)) return null;
  const user = payload.sender.login;
  const repo = payload.repository.full_name;
  const pr = payload.pull_request;
  const verb = action === "closed" && pr.merged ? "merged" : action;
  return `🔀 ${user} ${verb} PR #${pr.number}: ${pr.title} in ${repo} → ${pr.html_url}`;
}

function formatRelease(payload) {
  if (payload.action !== "published") return null;
  const user = payload.sender.login;
  const repo = payload.repository.full_name;
  const release = payload.release;
  return `🚀 ${release.tag_name} of ${repo} released by ${user} → ${release.html_url}`;
}

function formatStar(payload) {
  if (payload.action !== "started") return null;
  const user = payload.sender.login;
  const repo = payload.repository.full_name;
  return `⭐ ${user} starred ${repo} → https://github.com/${user}`;
}

const formatters = {
  fork: formatFork,
  issues: formatIssue,
  pull_request: formatPullRequest,
  release: formatRelease,
  watch: formatStar,
};

// --- Router factory ---

function createWebhookRouter(client, config, logger) {
  const router = express.Router();
  const secret = config.github_webhook.secret;
  const channel = config.github_webhook.channel;

  router.post("/", async (req, res) => {
    const signature = req.headers["x-hub-signature-256"];
    if (!verifySignature(req.rawBody, signature, secret)) {
      logger.warn("GitHub webhook: rejected invalid signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = req.headers["x-github-event"];
    if (!event) {
      return res.status(400).json({ error: "Missing X-GitHub-Event header" });
    }

    logger.info(
      `GitHub webhook: ${event}${req.body.action ? ` (${req.body.action})` : ""}`
    );

    if (event === "ping") {
      logger.info("GitHub webhook: ping received, configured correctly");
      return res.json({ message: "pong" });
    }

    const formatter = formatters[event];
    if (!formatter) {
      logger.info(`GitHub webhook: ignoring unhandled event: ${event}`);
      return res.json({ message: "ignored" });
    }

    const message = formatter(req.body);
    if (!message) {
      logger.info(`GitHub webhook: ignoring filtered action for ${event}`);
      return res.json({ message: "ignored" });
    }

    try {
      await client.sendIrcMessage(channel, message);
      logger.info(`GitHub webhook: posted to ${channel}: ${message}`);
      return res.json({ message: "posted" });
    } catch (err) {
      logger.error(`GitHub webhook: failed to send to IRC: ${err.message}`);
      return res.status(500).json({ error: "Failed to send to IRC" });
    }
  });

  return router;
}

module.exports = { createWebhookRouter };
