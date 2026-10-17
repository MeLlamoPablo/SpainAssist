import type { CodexLib } from '../ports';

/**
 * The Codex CLI device-code login (`@sa/agent/codex`), for development entry points only.
 * Impersonating Codex CLI is against OpenAI's terms, so a production build must not contain it:
 * `index.ts` passes it to `providerLib` only under `import.meta.env.DEV` (Vite replaces that with
 * `false` in production builds, which drops this module), and the `@sa/agent/codex` import stays
 * dynamic.
 */
export const devCodexLib: CodexLib = {
  login: async (cb) => (await import('@sa/agent/codex')).loginCodexDevice(cb),
  refresh: async (credential, onRotatedRefreshToken) =>
    (await import('@sa/agent/codex')).refreshCodexCredential(credential, {
      ...(onRotatedRefreshToken ? { onRotatedRefreshToken } : {}),
    }),
};
