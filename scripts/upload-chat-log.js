#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// Runs on the host (not inside Docker) so reads from Weechat's log file are
// always fresh — OrbStack's bind-mount cache puts the in-container view
// minutes behind, which broke the previous in-bot uploader.

const config = require(path.join(__dirname, "..", "conf", "config.json"));
const cfg = config.chat_log_upload;
if (!cfg?.enabled) process.exit(0);

const logFile = cfg.log_file;
const tailLines = cfg.tail_lines || 100;
const r2 = cfg.r2;
const key = r2.key || "chat-log.txt";

if (!fs.existsSync(logFile)) {
  console.error(`log file not found: ${logFile}`);
  process.exit(1);
}

const SYSTEM_MARKERS = new Set(["--", "-->", "<--", " *"]);
const TS_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{3})\d*Z$/;

const lines = fs.readFileSync(logFile, "utf-8").trimEnd().split("\n");
const chatOnly = [];
for (const line of lines) {
  const cols = line.split("\t");
  if (cols.length < 3) continue;
  const [ts, nick, ...rest] = cols;
  if (SYSTEM_MARKERS.has(nick)) continue;
  const m = ts.match(TS_RE);
  if (!m) continue;
  chatOnly.push(`[${m[1]}T${m[2]}.${m[3]}Z] <${nick}> ${rest.join("\t")}`);
}
const content = chatOnly.slice(-tailLines).join("\n");
if (!content) process.exit(0);

const s3 = new S3Client({
  region: "auto",
  endpoint: r2.endpoint,
  credentials: {
    accessKeyId: r2.access_key_id,
    secretAccessKey: r2.secret_access_key,
  },
});

s3.send(
  new PutObjectCommand({
    Bucket: r2.bucket,
    Key: key,
    Body: content,
    ContentType: "text/plain; charset=utf-8",
    CacheControl: "public, max-age=30",
  })
)
  .then(() => {
    console.log(`uploaded ${key} (${content.length} bytes)`);
  })
  .catch((err) => {
    console.error(`upload failed: ${err.message}`);
    process.exit(1);
  });
