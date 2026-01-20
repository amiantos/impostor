const axios = require('axios');

class WebSearchTool {
  constructor(logger, config) {
    this.logger = logger;
    this.apiKey = config?.kagi?.api_key;
    this.baseUrl = 'https://kagi.com/api/v0/fastgpt';
    this.timeout = 30000; // 30 second timeout for FastGPT
  }

  /**
   * Search the web using Kagi FastGPT
   * Returns an AI-generated answer with source references
   * @param {string} query - Search query / question
   * @returns {Object} Answer with success status
   */
  async searchWeb(query) {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return {
        success: false,
        output: '',
        error: 'Search query is required and must be a non-empty string'
      };
    }

    if (!this.apiKey) {
      return {
        success: false,
        output: '',
        error: 'Kagi API key not configured. Add kagi.api_key to config.json'
      };
    }

    try {
      this.logger.info(`Querying Kagi FastGPT: "${query}"`);

      const response = await axios.post(
        this.baseUrl,
        {
          query: query,
          web_search: true,
          cache: true
        },
        {
          headers: {
            'Authorization': `Bot ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: this.timeout
        }
      );

      const data = response.data?.data;

      if (!data || !data.output) {
        return {
          success: false,
          output: '',
          error: 'No answer returned from Kagi FastGPT'
        };
      }

      // Format references if available
      const references = (data.references || []).map(ref => ({
        title: ref.title || 'No title',
        url: ref.url || '',
        snippet: ref.snippet || ''
      }));

      this.logger.info(`Kagi FastGPT answered query with ${references.length} references`);

      return {
        success: true,
        output: JSON.stringify({
          query,
          answer: data.output,
          references,
          tokens_used: data.tokens || 0
        }, null, 2),
        error: null
      };

    } catch (error) {
      this.logger.error(`Kagi FastGPT failed for "${query}":`, error);

      let errorMessage = error.message;
      if (error.response) {
        const status = error.response.status;
        if (status === 401) {
          errorMessage = 'Invalid Kagi API key';
        } else if (status === 402) {
          errorMessage = 'Insufficient Kagi API credits';
        } else {
          errorMessage = `Kagi API error: ${status} ${error.response.statusText}`;
        }
      }

      return {
        success: false,
        output: '',
        error: `Search failed: ${errorMessage}`
      };
    }
  }
}

module.exports = WebSearchTool;
