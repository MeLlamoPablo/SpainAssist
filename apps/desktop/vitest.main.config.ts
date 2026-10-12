import { defineConfig } from 'vitest/config';

// Main-process unit tests: plain Node, no Electron (Electron APIs are injected as fakes).
export default defineConfig({
  test: {
    name: 'main',
    environment: 'node',
    include: ['src/main/**/*.test.ts'],
    testTimeout: 10_000,
    restoreMocks: true,
    // The ChatGPT sign-in page embeds the app's colour tokens (`colors.css?raw`); Vitest blanks
    // CSS unless told to process it.
    css: { include: [/design\/colors\.css/] },
  },
});
