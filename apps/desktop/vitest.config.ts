import { defineConfig } from 'vitest/config';

// Default config for `vitest run` (all desktop tests). Same CSS rule as vitest.main.config.ts.
export default defineConfig({
  // React components in renderer tests (the app build uses @vitejs/plugin-react).
  esbuild: { jsx: 'automatic' },
  test: {
    // The ChatGPT sign-in page embeds the app's colour tokens (`colors.css?raw`); Vitest blanks
    // CSS unless told to process it.
    css: { include: [/design\/colors\.css/] },
  },
});
