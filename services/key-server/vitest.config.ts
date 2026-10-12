import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each test file boots its own PGlite (WASM) template: ~1 s alone, several seconds when all
    // files boot in parallel.
    testTimeout: 30_000,
  },
});
