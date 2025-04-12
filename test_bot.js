const ImpostorClient = require('./classes/impostor_client');
const config = require('./conf/config.json');

// Simple logger for testing
const logger = {
  info: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
  warn: (...args) => console.warn(...args)
};

// Mock Discord.js Collection-like structure
class MockCollection extends Array {
  constructor(messages) {
    super();
    messages.forEach(msg => this.push(msg));
  }
}

async function testBot() {
  const client = new ImpostorClient(logger, config);

  // Create mock messages in an array-like structure
  const mockMessages = new MockCollection([
    {
      content: 'Hello there!',
      author: {
        username: 'TestUser',
        id: '123'
      },
      id: '1'
    },
    // Add more test messages as needed
    {
      content: 'How are you today?',
      author: {
        username: 'AnotherUser',
        id: '789'
      },
      id: '2'
    }
  ]);

  try {
    const response = await client.generateResponse({
      messages: mockMessages,
      userName: 'TestUser',
      characterName: config.character.name || 'Bot',
      botUserId: '456' // Simulated bot user ID
    });

    console.log('\nBot Response:', response);
  } catch (error) {
    console.error('Error:', error);
  }
}

testBot(); 