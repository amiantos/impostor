const axios = require('axios');
const cheerio = require('cheerio');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

class WebFetchTool {
  constructor(logger) {
    this.logger = logger;
    this.timeout = 10000; // 10 second timeout
    this.maxContentLength = 50000; // Limit content to ~50KB for AI consumption
  }

  /**
   * Fetch a web page and extract its main content
   * @param {string} url - URL to fetch
   * @returns {Object} Extracted content with success status
   */
  async fetchPage(url) {
    if (!url || typeof url !== 'string' || url.trim().length === 0) {
      return {
        success: false,
        output: '',
        error: 'URL is required and must be a non-empty string'
      };
    }

    // Basic URL validation
    try {
      new URL(url);
    } catch (e) {
      return {
        success: false,
        output: '',
        error: `Invalid URL format: ${url}`
      };
    }

    try {
      this.logger.info(`Fetching web page: ${url}`);

      const response = await axios.get(url, {
        timeout: this.timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; IsaacBot/1.0; +https://github.com/amiantos/impostor)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5'
        },
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400
      });

      const contentType = response.headers['content-type'] || '';

      // Check if response is HTML
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return {
          success: false,
          output: '',
          error: `URL does not return HTML content (got: ${contentType})`
        };
      }

      const html = response.data;

      // Try to extract clean content using Readability
      const extractedContent = this.extractContent(html, url);

      if (!extractedContent) {
        // Fallback to basic text extraction
        const fallbackContent = this.extractBasicText(html);
        return {
          success: true,
          output: JSON.stringify({
            url,
            title: this.extractTitle(html),
            content: fallbackContent,
            excerpt: fallbackContent.substring(0, 300) + '...',
            extraction_method: 'fallback'
          }, null, 2),
          error: null
        };
      }

      this.logger.info(`Successfully extracted content from: ${url}`);

      return {
        success: true,
        output: JSON.stringify({
          url,
          title: extractedContent.title || 'No title',
          content: extractedContent.textContent,
          excerpt: extractedContent.excerpt || extractedContent.textContent.substring(0, 300) + '...',
          extraction_method: 'readability'
        }, null, 2),
        error: null
      };

    } catch (error) {
      this.logger.error(`Failed to fetch ${url}:`, error);

      let errorMessage = error.message;
      if (error.code === 'ECONNABORTED') {
        errorMessage = `Request timed out after ${this.timeout / 1000} seconds`;
      } else if (error.response) {
        errorMessage = `HTTP ${error.response.status}: ${error.response.statusText}`;
      } else if (error.code === 'ENOTFOUND') {
        errorMessage = `Could not resolve hostname for: ${url}`;
      }

      return {
        success: false,
        output: '',
        error: `Failed to fetch page: ${errorMessage}`
      };
    }
  }

  /**
   * Extract main content using Mozilla Readability
   * @param {string} html - Raw HTML content
   * @param {string} url - Original URL for base resolution
   * @returns {Object|null} Extracted article or null if failed
   */
  extractContent(html, url) {
    try {
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (article && article.textContent) {
        // Truncate if too long
        if (article.textContent.length > this.maxContentLength) {
          article.textContent = article.textContent.substring(0, this.maxContentLength) + '\n\n[Content truncated...]';
        }
        return article;
      }

      return null;
    } catch (error) {
      this.logger.debug('Readability extraction failed:', error.message);
      return null;
    }
  }

  /**
   * Fallback basic text extraction using cheerio
   * @param {string} html - Raw HTML content
   * @returns {string} Extracted text
   */
  extractBasicText(html) {
    try {
      const $ = cheerio.load(html);

      // Remove script and style elements
      $('script, style, nav, header, footer, aside, .ads, .advertisement').remove();

      // Try to get main content
      let content = $('main, article, .content, .post, #content, #main').text();

      if (!content || content.trim().length < 100) {
        // Fallback to body
        content = $('body').text();
      }

      // Clean up whitespace
      content = content
        .replace(/\s+/g, ' ')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();

      // Truncate if too long
      if (content.length > this.maxContentLength) {
        content = content.substring(0, this.maxContentLength) + '\n\n[Content truncated...]';
      }

      return content || 'Could not extract text content';
    } catch (error) {
      this.logger.debug('Basic text extraction failed:', error.message);
      return 'Could not extract text content';
    }
  }

  /**
   * Extract title from HTML
   * @param {string} html - Raw HTML content
   * @returns {string} Page title
   */
  extractTitle(html) {
    try {
      const $ = cheerio.load(html);
      return $('title').text().trim() || 'No title';
    } catch (error) {
      return 'No title';
    }
  }
}

module.exports = WebFetchTool;
