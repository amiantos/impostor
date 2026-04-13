const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

class ChatLogUploader {
  constructor(logger, config) {
    this.logger = logger;
    this.config = config;
    this.interval = null;
    this.lastMtime = null;

    const r2 = config.r2;
    this.s3 = new S3Client({
      region: "auto",
      endpoint: r2.endpoint,
      credentials: {
        accessKeyId: r2.access_key_id,
        secretAccessKey: r2.secret_access_key,
      },
    });
    this.bucket = r2.bucket;
    this.key = r2.key || "chat-log.txt";
    this.logFile = config.log_file;
    this.tailLines = config.tail_lines || 100;
  }

  start() {
    const intervalMs = (this.config.interval_seconds || 60) * 1000;
    this.logger.info(
      `ChatLogUploader started (every ${intervalMs / 1000}s, tailing ${this.tailLines} lines from ${this.logFile})`
    );
    // Upload immediately on start
    this.upload();
    this.interval = setInterval(() => this.upload(), intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.logger.info("ChatLogUploader stopped");
  }

  async upload() {
    try {
      // Check if file exists
      if (!fs.existsSync(this.logFile)) {
        this.logger.debug(`ChatLogUploader: log file not found: ${this.logFile}`);
        return;
      }

      // Check mtime to skip if unchanged
      const stat = fs.statSync(this.logFile);
      const mtime = stat.mtimeMs;
      if (this.lastMtime && mtime === this.lastMtime) {
        this.logger.debug("ChatLogUploader: log file unchanged, skipping upload");
        return;
      }
      this.lastMtime = mtime;

      // Read last N lines
      const content = this.tailFile(this.logFile, this.tailLines);
      if (!content) {
        this.logger.debug("ChatLogUploader: no content to upload");
        return;
      }

      // Upload to R2
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key,
          Body: content,
          ContentType: "text/plain; charset=utf-8",
          CacheControl: "public, max-age=30",
        })
      );

      this.logger.debug(`ChatLogUploader: uploaded ${this.key} (${content.length} bytes)`);
    } catch (err) {
      this.logger.error(`ChatLogUploader: upload failed: ${err.message}`);
    }
  }

  tailFile(filePath, numLines) {
    const data = fs.readFileSync(filePath, "utf-8");
    const lines = data.trimEnd().split("\n");
    // Strip IRC system messages (joins, parts, quits, mode changes, etc.)
    // which the IRC client logs with a "*** " marker after the timestamp.
    const chatOnly = lines.filter((line) => !/\] \*\*\* /.test(line));
    const tail = chatOnly.slice(-numLines);
    return tail.join("\n");
  }
}

module.exports = ChatLogUploader;
