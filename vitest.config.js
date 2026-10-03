import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.js'],
    testTimeout: 60000,
    hookTimeout: 120000,
    pool: 'forks',
    fileParallelism: false,
    coverage: { provider: 'v8', include: ['src/**'], exclude: ['src/server.js', 'src/db/seed.js', 'src/observability/**'], reporter: ['text-summary', 'json-summary'] },
  },
});
