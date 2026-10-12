import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Browser tests launch Chromium and walk multi-page flows.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
