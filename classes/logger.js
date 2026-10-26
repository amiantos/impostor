class Logger {
  /**
   * @param {boolean} debug - Print debug lines and attached objects
   * @param {string|null} prefix - Tag for every line, e.g. a bot id
   */
  constructor(debug = false, prefix = null) {
    this.debugMode = debug;
    this.prefix = prefix;
  }

  /** A logger that tags its lines, for one bot's output among several. */
  child(prefix) {
    return new Logger(this.debugMode, prefix);
  }

  formatMessage(level, message, obj) {
    const timestamp = new Date().toISOString();
    const tag = this.prefix ? ` [${this.prefix}]` : "";
    let formattedMessage = `[${timestamp}] [${level.toUpperCase()}]${tag} ${message}`;
    if (obj !== null && this.debugMode) {
      formattedMessage += `\n${JSON.stringify(obj, null, 2)}`;
    }
    return formattedMessage;
  }

  debug(message, obj = null) {
    if (this.debugMode) {
      console.log(this.formatMessage("debug", message, obj));
    }
  }

  info(message, obj = null) {
    console.log(this.formatMessage("info", message, obj));
  }

  warn(message, obj = null) {
    console.warn(this.formatMessage("warn", message, obj));
  }

  error(message, obj = null) {
    console.error(this.formatMessage("error", message, obj));
  }
}

module.exports = Logger;
