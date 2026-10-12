import type { SaApi, SaArgs, SaEvent, SaMethod, SaResult } from '@sa/shared';

/**
 * The only door to the main process. In Electron the preload exposes `window.sa`; in a plain
 * browser (standalone preview, design work) we fall back to an in-memory mock. The mock lives in
 * its own lazily-loaded chunk, so it is never executed when `window.sa` exists.
 * `?mock=1` forces the mock (handy inside Electron while main is still being built).
 */

let impl: SaApi | null = null;
let mocked = false;

export async function initApi(): Promise<SaApi> {
  if (impl) return impl;
  const params = new URLSearchParams(window.location.search);
  if (window.sa && !params.has('mock') && !params.has('playground')) {
    impl = window.sa;
    return impl;
  }
  const { createMockApi } = await import('../mock/mock-api');
  impl = createMockApi(params);
  mocked = true;
  return impl;
}

/** True when running against the in-memory mock (demo data). */
export function isMockApi(): boolean {
  return mocked;
}

function current(): SaApi {
  if (!impl) throw new Error('API used before initApi()');
  return impl;
}

export const api = {
  invoke<M extends SaMethod>(method: M, ...args: SaArgs<M>): Promise<SaResult<M>> {
    return current().invoke(method, ...args);
  },
  on(listener: (event: SaEvent) => void): () => void {
    return current().on(listener);
  },
};

/** Best-effort message for errors coming back over IPC ("Error invoking remote method…"). */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').trim();
}
