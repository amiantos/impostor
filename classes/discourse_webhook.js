const crypto = require("crypto");
const express = require("express");

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

function stripPostContent(raw) {
  if (!raw) return "";
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^>.*$/gm, " ")
    .replace(/[*_~#>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateByBytes(str, maxBytes) {
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.substring(0, mid), "utf8") <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return str.substring(0, lo);
}

function formatPost(payload, baseUrl, maxLen) {
  const post = payload.post;
  if (!post) return null;

  const username = post.username;
  const title = post.topic_title || "";
  const slug = post.topic_slug;
  const topicId = post.topic_id;
  const postNumber = post.post_number;

  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const url = `${trimmedBase}/t/${slug}/${topicId}/${postNumber}`;

  const content = stripPostContent(post.raw);

  const prefix = `[eye] ${title} <${username}> `;
  // Wrap URL in <> so Discord skips the link preview embed.
  const suffix = ` <${url}>`;

  // irc-framework reserves room under max_line_length for the IRC line
  // prefix (:nick!user@host PRIVMSG #chan :), so the real payload is
  // ~60-80 bytes smaller. Cap aggressively so the URL stays on one line.
  const budget = Math.min(maxLen, 400) - 90;
  const fixedBytes =
    Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
  const room = budget - fixedBytes;

  if (room <= 0) {
    return `${prefix.trim()}${suffix}`;
  }

  let body = content;
  if (Buffer.byteLength(body, "utf8") > room) {
    body = truncateByBytes(body, Math.max(0, room - 3)).trimEnd() + "...";
  }

  return `${prefix}${body}${suffix}`;
}

function createDiscourseWebhookRouter(bridge, config, logger) {
  const router = express.Router();
  const secret = config.discourse_webhook.secret;
  const baseUrl = config.discourse_webhook.base_url;
  const maxLen = config.irc?.max_line_length || 400;

  router.post("/", async (req, res) => {
    const signature = req.headers["x-discourse-event-signature"];
    if (!verifySignature(req.rawBody, signature, secret)) {
      logger.warn("Discourse webhook: rejected invalid signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const eventType = req.headers["x-discourse-event-type"];
    const event = req.headers["x-discourse-event"];

    logger.info(`Discourse webhook: ${eventType}/${event}`);

    if (eventType === "ping" || event === "ping") {
      return res.json({ message: "pong" });
    }

    if (eventType !== "post" || event !== "post_created") {
      logger.info(
        `Discourse webhook: ignoring unhandled event: ${eventType}/${event}`
      );
      return res.json({ message: "ignored" });
    }

    const message = formatPost(req.body, baseUrl, maxLen);
    if (!message) {
      logger.info("Discourse webhook: could not format payload, ignoring");
      return res.json({ message: "ignored" });
    }

    try {
      bridge.announce(message);
      logger.info(`Discourse webhook: announced via EyeBridge: ${message}`);
      return res.json({ message: "posted" });
    } catch (err) {
      logger.error(`Discourse webhook: failed to announce: ${err.message}`);
      return res.status(500).json({ error: "Failed to announce" });
    }
  });

  return router;
}

module.exports = { createDiscourseWebhookRouter };
