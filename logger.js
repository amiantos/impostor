class Logger {
    constructor(debug = false) {
        this.debugMode = debug;
    }

    debug(message) {
        if (this.debugMode) {
            console.log(`[DEBUG] ${new Date().toISOString()}: ${message}`);
        }
    }

    info(message) {
        console.log(`[INFO] ${new Date().toISOString()}: ${message}`);
    }

    error(message) {
        console.error(`[ERROR] ${new Date().toISOString()}: ${message}`);
    }
}

module.exports = Logger;
