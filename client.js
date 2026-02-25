// Mission Control Client - Mac mini Optimized
// Efficient resource management for lower-power systems

const API_BASE = 'http://localhost:8899/mc';
const RETRY_ATTEMPTS = 3;
const TIMEOUT_MS = 5000;

// Connection pool for efficient HTTP reuse
class ApiClient {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 60000; // 1 minute cache
    this.lastRequestTime = 0;
    this.minRequestInterval = 100; // Throttle requests
  }

  async request(endpoint, options = {}) {
    // Check cache first
    const cacheKey = `${endpoint}:${JSON.stringify(options)}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }
    }

    // Throttle requests to reduce Mac mini load
    const timeSinceLastRequest = Date.now() - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      await new Promise(resolve =>
        setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest)
      );
    }

    this.lastRequestTime = Date.now();

    // Retry logic for reliability
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await fetch(`${API_BASE}${endpoint}`, {
          ...options,
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...options.headers
          }
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        // Cache successful responses
        this.cache.set(cacheKey, {
          data,
          timestamp: Date.now()
        });

        return data;
      } catch (error) {
        if (attempt === RETRY_ATTEMPTS - 1) {
          console.error(`Failed after ${RETRY_ATTEMPTS} attempts:`, error.message);
          throw error;
        }
        // Exponential backoff
        await new Promise(resolve =>
          setTimeout(resolve, Math.pow(2, attempt) * 1000)
        );
      }
    }
  }

  clearCache() {
    this.cache.clear();
  }
}

const client = new ApiClient();

// Status Check - Lightweight health monitoring
async function checkServerStatus() {
  try {
    const status = await client.request('/status');
    console.log('✓ Server Status:', status.online ? 'Online' : 'Offline');
    return status;
  } catch (error) {
    console.error('✗ Status check failed:', error.message);
    return { online: false, error: error.message };
  }
}

// Weather - Cached API calls
async function getWeather(city) {
  try {
    const weather = await client.request(`/weather?city=${encodeURIComponent(city)}`);
    console.log(`Weather in ${city}:`, {
      temp: weather.temperature,
      condition: weather.condition,
      humidity: weather.humidity
    });
    return weather;
  } catch (error) {
    console.error(`Failed to fetch weather for ${city}:`, error.message);
    return null;
  }
}

// Dashboard State Backup - Efficient streaming
async function backupDashboardState(dashboardState) {
  try {
    const response = await client.request('/data', {
      method: 'POST',
      body: JSON.stringify(dashboardState)
    });
    console.log('✓ Dashboard backed up successfully');
    return response;
  } catch (error) {
    console.error('✗ Backup failed:', error.message);
    return null;
  }
}

// Batch operations for efficiency
async function performBatchOperations(operations) {
  try {
    const results = [];
    for (const op of operations) {
      const result = await client.request(op.endpoint, op.options);
      results.push(result);
    }
    return results;
  } catch (error) {
    console.error('Batch operation failed:', error.message);
    return [];
  }
}

// Memory cleanup utility
function cleanupMemory() {
  client.clearCache();
  console.log('✓ Memory cleaned up');
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    client,
    checkServerStatus,
    getWeather,
    backupDashboardState,
    performBatchOperations,
    cleanupMemory
  };
}

// Example usage
async function main() {
  console.log('🚀 Mission Control Client Started\n');

  // Check server
  await checkServerStatus();

  // Get weather for multiple cities (batched)
  await performBatchOperations([
    { endpoint: '/weather?city=New%20York', options: {} },
    { endpoint: '/weather?city=San%20Francisco', options: {} },
    { endpoint: '/weather?city=London', options: {} }
  ]);

  // Backup dashboard state
  const dashboardState = {
    widgets: ['weather', 'status', 'logs'],
    theme: 'dark',
    refreshInterval: 300000 // 5 minutes
  };
  await backupDashboardState(dashboardState);

  // Cleanup
  setTimeout(cleanupMemory, 10000);
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
