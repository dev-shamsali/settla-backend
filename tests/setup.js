// Runs before any test file imports app code, so env.js sees test configuration.
Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGODB_URI: process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017',
  MONGODB_DB: 'settla_test',
  REDIS_URL: '',
  INTEGRATION_MODE: 'mock',
  LLM_PROVIDER: 'mock',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123456789',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef012345678',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
});
