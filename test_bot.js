const ImpostorClient = require('./classes/impostor_client');
const config = require('./conf/config.json');
const Logger = require('./classes/logger');

// Initialize proper logger with debug mode off
const logger = new Logger(true);

// Mock Discord.js Collection-like structure
class MockCollection extends Array {
  constructor(messages) {
    super();
    messages.forEach(msg => this.push(msg));
  }
}

// Test scenarios for different types of interactions
const TEST_SCENARIOS = {
  friendly_chat: [
    {
      content: 'Hey there! How are you doing today?',
      author: {
        username: 'amiantos',
        id: '123'
      },
      id: '1'
    }
  ],
  factual_query: [
    {
      content: 'What is your favorite book and why do you like it so much?',
      author: {
        username: 'amiantos',
        id: '123'
      },
      id: '2'
    }
  ],
  complex_query: [
    {
      content: 'What do you think about the current state of AI and its impact on society?',
      author: {
        username: 'amiantos',
        id: '123'
      },
      id: '3'
    }
  ]
};

async function runTest(scenarioName, client) {
  console.log(`\n=== Testing Scenario: ${scenarioName} ===`);
  console.log('Input:', TEST_SCENARIOS[scenarioName][0].content);
  
  const mockMessages = new MockCollection(TEST_SCENARIOS[scenarioName]);
  
  try {
    const response = await client.generateResponseWithResponsesAPI({
      messages: mockMessages,
      userName: 'amiantos',
      characterName: config.character.name || 'Bot',
      botUserId: '456'
    });

    console.log('Response:', response);
  } catch (error) {
    console.error('Error:', error);
  }
}

async function testBot() {
  const client = new ImpostorClient(logger, config);

  // Get scenario from command line argument
  const requestedScenario = process.argv[2];
  
  if (requestedScenario) {
    if (TEST_SCENARIOS[requestedScenario]) {
      await runTest(requestedScenario, client);
    } else {
      console.log('\nAvailable scenarios:');
      Object.keys(TEST_SCENARIOS).forEach(scenario => {
        console.log(`- ${scenario}`);
      });
      console.log('\nUsage: node test_bot.js [scenario_name]');
    }
  } else {
    // Run all scenarios if no specific one requested
    console.log('Running all scenarios...\n');
    for (const scenario of Object.keys(TEST_SCENARIOS)) {
      await runTest(scenario, client);
    }
  }
}

// Run the tests
testBot(); 