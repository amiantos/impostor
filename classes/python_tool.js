const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class PythonTool {
  constructor(logger) {
    this.logger = logger;
    this.tempDir = '/tmp/impostor_python';
    this.ensureTempDir();
  }

  ensureTempDir() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async executePython(code, timeout = 5000) {
    return new Promise((resolve, reject) => {
      // Create a temporary Python file
      const timestamp = Date.now();
      const fileName = `script_${timestamp}.py`;
      const filePath = path.join(this.tempDir, fileName);

      try {
        // Write the Python code to file
        fs.writeFileSync(filePath, code);

        this.logger.debug(`Executing Python code in ${fileName}:`);
        this.logger.debug(code);

        // Execute the Python script
        const pythonProcess = spawn('python3', [filePath], {
          timeout: timeout
        });

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        pythonProcess.on('close', (code) => {
          // Clean up the temporary file
          try {
            fs.unlinkSync(filePath);
          } catch (e) {
            this.logger.warn(`Failed to clean up temp file ${fileName}:`, e);
          }

          if (code === 0) {
            this.logger.debug('Python execution successful:', stdout.trim());
            resolve({
              success: true,
              output: stdout.trim(),
              error: null
            });
          } else {
            this.logger.debug('Python execution failed:', stderr.trim());
            resolve({
              success: false,
              output: stdout.trim(),
              error: stderr.trim()
            });
          }
        });

        pythonProcess.on('error', (error) => {
          // Clean up the temporary file
          try {
            fs.unlinkSync(filePath);
          } catch (e) {
            this.logger.warn(`Failed to clean up temp file ${fileName}:`, e);
          }

          this.logger.error('Failed to execute Python:', error);
          resolve({
            success: false,
            output: '',
            error: error.message
          });
        });

      } catch (error) {
        // Clean up the temporary file if it was created
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (e) {
          // Ignore cleanup errors
        }

        this.logger.error('Failed to create Python script:', error);
        reject(error);
      }
    });
  }

  // Helper method to check if Python is available
  async checkPythonAvailable() {
    try {
      const result = await this.executePython('print("Python is available")', 2000);
      return result.success;
    } catch (error) {
      return false;
    }
  }
}

module.exports = PythonTool;