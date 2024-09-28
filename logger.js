class Logger {
    constructor(debug = false) {
        this.debugMode = debug;
    }

    formatMessage(level, message, obj) {
        const timestamp = new Date().toISOString();
        let formattedMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        if (obj !== null && this.debugMode) {
            formattedMessage += `\n${JSON.stringify(obj, null, 2)}`;
        }
        return formattedMessage;
    }

    debug(message, obj = null) {
        if (this.debugMode) {
            console.log(this.formatMessage('debug', message, obj));
        }
    }

    info(message, obj = null) {
        console.log(this.formatMessage('info', message, obj));
    }

    warn(message, obj = null) {
        console.warn(this.formatMessage('warn', message, obj));
    }

    error(message, obj = null) {
        console.error(this.formatMessage('error', message, obj));
    }
}

module.exports = Logger;

module.exports = Logger;
