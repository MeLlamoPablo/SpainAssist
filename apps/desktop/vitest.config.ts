import { defineConfig } from 'vitest/config';

// Default config for `vitest run` (all desktop tests). Same CSS rule as vitest.main.config.ts.
export default defineConfig({
  // `crlset/fixture.ts` imports the CRLSet fixture with `?inline`, like electron.vite.config.ts.
  assetsInclude: ['**/*.crx3'],
  // React components in renderer tests (the app build uses @vitejs/plugin-react).
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // The ChatGPT sign-in page embeds the app's colour tokens (`colors.css?raw`); Vitest blanks
    // CSS unless told to process it.
    css: { include: [/design\/colors\.css/] },
  },
});
