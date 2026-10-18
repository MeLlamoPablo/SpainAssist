import type { ProviderStatus, SaEvent } from '@sa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './app';
import { startSync } from './sync';

const mock = vi.hoisted(() => ({
  listener: undefined as ((event: SaEvent) => void) | undefined,
  results: {} as Record<string, unknown>,
}));
vi.mock('../lib/api', () => ({
  api: {
    invoke: (method: string) => Promise.resolve(mock.results[method]),
    on: (listener: (event: SaEvent) => void) => {
      mock.listener = listener;
      return () => {};
    },
  },
}));

const status = (configured: boolean) => ({ configured }) as ProviderStatus;

describe('startSync', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('applies events that arrive during the initial load after its older snapshot', async () => {
    vi.stubGlobal('document', { documentElement: { dataset: {} } });
    let resolveStatus: (value: ProviderStatus) => void = () => {};
    mock.results = {
      'app.info': { platform: 'linux', features: {} },
      'providers.status': new Promise<ProviderStatus>((r) => {
        resolveStatus = r;
      }),
      'procedures.list': [],
      'chat.transcript': [],
    };

    const started = startSync();
    // Main configures a provider (a redeemed voucher) after the renderer read the status…
    mock.listener?.({ type: 'providers.status', status: status(true) });
    // …and the read answers with the state from before.
    resolveStatus(status(false));
    await started;

    expect(useAppStore.getState().provider?.configured).toBe(true);
    expect(useAppStore.getState().ready).toBe(true);
    // Once loaded, events apply straight away.
    mock.listener?.({ type: 'providers.status', status: status(false) });
    expect(useAppStore.getState().provider?.configured).toBe(false);
  });
});
