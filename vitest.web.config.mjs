import { defineConfig } from 'vitest/config';

// Unit tests for the React screens' plain TypeScript (src/web/**/*.test.ts). No browser.
export default defineConfig({
  test: {
    include: ['src/web/**/*.test.ts', 'src/web/**/*.test.tsx'],
    environment: 'node'
  }
});
