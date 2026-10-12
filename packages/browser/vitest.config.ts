import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Real (headless) Chromium: launching and navigating takes longer than unit tests.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each test file launches its own browser; a few in parallel is fine.
    maxWorkers: 4,
    // Like the app, every test browser goes through the TLS sidecar (test/sidecar.ts).
    globalSetup: ['test/sidecar.global.ts'],
    setupFiles: ['test/sidecar.ts'],
  },
});
