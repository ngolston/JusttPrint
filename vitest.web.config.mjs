import { defineConfig } from 'vitest/config';

// Unit tests for the React screens' plain TypeScript (src/web/**/*.test.ts). No browser, no
// TestDriver (vitest.config.js is the TestDriver suite).
export default defineConfig({
  test: {
    include: ['src/web/**/*.test.ts'],
    environment: 'node'
  }
});
