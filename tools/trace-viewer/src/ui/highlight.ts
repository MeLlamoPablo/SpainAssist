/**
 * Syntax colors for codemode modules and tools' JSON input: Shiki with only the JavaScript and
 * JSON grammars, the JavaScript regex engine (no WASM) and GitHub's light and dark themes. Loaded on first use, so the page
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
    import('shiki/dist/langs/json.mjs'),
    import('shiki/dist/themes/github-light.mjs'),
    import('shiki/dist/themes/github-dark.mjs'),
  ]).then(([core, engine, javascript, json, light, dark]) =>
    core.createHighlighterCore({
      engine: engine.createJavaScriptRegexEngine(),
      langs: [javascript.default, json.default],
      themes: [light.default, dark.default],
    }),
  );
  return highlighter;
}

export type Lang = 'javascript' | 'json';

/** The code's lines as tokens, each with its colors in both themes. */
export async function highlight(code: string, lang: Lang): Promise<ThemedToken[][]> {
  const shiki = await load();
  return shiki.codeToTokens(code, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  }).tokens;
}
