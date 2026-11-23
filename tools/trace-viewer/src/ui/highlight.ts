/**
 * Syntax colors for codemode modules: Shiki with only the JavaScript grammar, the JavaScript
 * regex engine (no WASM) and GitHub's light and dark themes. Loaded on first use, so the page
 * doesn't wait for it. Each token carries both themes' colors as CSS variables (`--shiki-light`,
 * `--shiki-dark`); styles.css picks one by the page's theme.
 */
import type { HighlighterCore, ThemedToken } from 'shiki/core';

let highlighter: Promise<HighlighterCore> | undefined;

function load(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
    import('shiki/dist/langs/javascript.mjs'),
    import('shiki/dist/themes/github-light.mjs'),
    import('shiki/dist/themes/github-dark.mjs'),
  ]).then(([core, engine, javascript, light, dark]) =>
    core.createHighlighterCore({
      engine: engine.createJavaScriptRegexEngine(),
      langs: [javascript.default],
      themes: [light.default, dark.default],
    }),
  );
  return highlighter;
}

/** The module's lines as tokens, each with its colors in both themes. */
export async function highlightJs(code: string): Promise<ThemedToken[][]> {
  const shiki = await load();
  return shiki.codeToTokens(code, {
    lang: 'javascript',
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  }).tokens;
}
