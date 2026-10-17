/**
 * The browser factory of a run, with the real `createBrowserService` replaced by a recorder (no
 * Chromium): what the run changes in the options the app gives it.
 */
import type { BrowserServiceOptions } from '@sa/browser';
import { describe, expect, it, vi } from 'vitest';
import { NetLog } from '../../../src/net';
import { createEvalBrowserFactory } from '../../../src/run/app/browser';

const created: BrowserServiceOptions[] = [];
vi.mock('@sa/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sa/browser')>()),
  createBrowserService: (options: BrowserServiceOptions) => {
    created.push(options);
    return {} as never;
  },
}));

const network = {
  launchArgs: ['--pinned'],
  credentials: { username: 'u', password: 'p' },
} as never;

/** What `BrowserHolder` passes in the app. */
function appOptions(over: Partial<BrowserServiceOptions> = {}): BrowserServiceOptions {
  return {
    headless: false,
    startHidden: true,
    ignoreHTTPSErrors: true,
    downloadsDir: '/tmp/downloads',
    onDownload: async () => ({ downloadId: 'd', name: 'n', mimeType: 'm' }),
    ...over,
  };
}

describe('createEvalBrowserFactory', () => {
  it('puts the network layer in the slot of the TLS sidecar, headless, trusting the pinned key instead of ignoring errors', () => {
    created.length = 0;
    const log = new NetLog({ worldId: 'w' });
    const factory = createEvalBrowserFactory({ network, log });
    factory(appOptions({ certificates: { launchArgs: ['--real-sidecar'] } as never }));
    expect(created).toHaveLength(1);
    const options = created[0] as BrowserServiceOptions;
    expect(options.certificates).toBe(network);
    expect(options.ignoreHTTPSErrors).toBe(false);
    expect(options.headless).toBe(true);
    // Everything else the app asked for is kept, and no launch switch of the run's own is added.
    expect(options.startHidden).toBe(true);
    expect(options.downloadsDir).toBe('/tmp/downloads');
    expect(options.launchArgs).toBeUndefined();
    expect(options.capture).toBeUndefined();
  });

  it('records into the run directory, keeping typed secrets, only when asked', () => {
    created.length = 0;
    const log = new NetLog({ worldId: 'w' });
    createEvalBrowserFactory({
      network,
      log,
      capture: { dir: '/runs/r1/browser', scratchDir: '/runs/r1/tmp/browser-capture' },
    })(appOptions());
    const capture = (created[0] as BrowserServiceOptions).capture;
    expect(capture?.dir('p_00000000000000aa')).toBe('/runs/r1/browser/p_00000000000000aa');
    expect(capture?.scratchDir).toBe('/runs/r1/tmp/browser-capture');
    expect(capture?.scrub).toBe(false);
  });

  it("denies, and logs, the main process' own fetch of AutoFirma signing", async () => {
    created.length = 0;
    const log = new NetLog({ worldId: 'w' });
    const real = vi.fn(async () => new Response('real'));
    const context = vi.fn((procedureId: string) => ({
      approveSignature: async () => null,
      fetch: real as unknown as typeof fetch,
      procedureId,
    }));
    createEvalBrowserFactory({ network, log })(
      appOptions({
        afirma: { shimSource: 'shim', handler: {} as never, context: context as never },
      }),
    );
    const afirma = (created[0] as BrowserServiceOptions).afirma;
    expect(afirma?.shimSource).toBe('shim');
    const ctx = afirma?.context('p_00000000000000aa');
    expect(context).toHaveBeenCalledWith('p_00000000000000aa');
    await expect(
      ctx?.fetch?.('https://triphasico.example.test/sign', { method: 'POST', body: 'x' }),
    ).rejects.toThrow('fetch failed');
    expect(real).not.toHaveBeenCalled();
    expect(log.tail()).toMatchObject([
      {
        channel: expect.any(String),
        method: 'POST',
        url: 'https://triphasico.example.test/sign',
        route: 'denied',
      },
    ]);
  });
});
