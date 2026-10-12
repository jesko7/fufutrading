import { defineConfig } from 'vitest/config';

// Integration tests against the real Binance API (network required).
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
