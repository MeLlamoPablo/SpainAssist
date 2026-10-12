import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The integration tests spawn real agent host processes.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
