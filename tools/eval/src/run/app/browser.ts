/**
 * The browser of a run: the app's real `BrowserService` (Playwright and Chromium, accessibility
 * snapshots, downloads, the AutoFirma shim) with every request going through `EvalNetwork`, which
 * serves the real hostnames from SpainBench and refuses everything else.
 *
 * The app builds its browser service lazily through a factory (`BrowserHolder`); this factory
 * wraps the real one and changes only what the world needs:
 *   - `certificates` is the `EvalNetwork` (the slot of the TLS sidecar, which is never started:
 *     it would dial the real hosts). Its `launchArgs` (the pinned key, the host resolver rule that
 *     fails every lookup but loopback, the WebRTC policy) are the only Chromium switches added,
 *     and the app's own `launchArgs` may not set any of them (`assertNoClash`): Chromium keeps one
 *     value of each, so a second one would silently undo the first.
 *   - `initScripts`: `WEBRTC_BLOCK` runs in every frame of every context. The proxy carries TCP
 *     only, and a page can send UDP to any IP address through WebRTC; no resolver rule stops that.
 *   - `ignoreHTTPSErrors` is off: the pinned key is what makes the certificates trusted, and
 *     ignoring errors would also keep service workers from registering.
 *   - capture (HAR, trace, the HTML after each step) goes to `<runDir>/browser/<procedure>/`
 *     when the run asks for it, with typed secrets kept (`scrub: false`: only synthetic accounts).
 *   - Playwright's handlers for SIGINT, SIGTERM and SIGHUP are off (`handleSignals`): the process
 *     that runs an evaluation decides what a signal does, and ends the browser through the app.
 *   - the main process' own fetch of AutoFirma's triphase signing is denied (and logged): it would
 *     leave the network layer. Certificate signing is not available in evaluation runs.
 */
import { join } from 'node:path';
import { createBrowserService } from '@sa/browser';
import type { HeadlessOptions } from '@sa/desktop/headless';
import { z } from 'zod';
import { createEgressGuard, type EvalNetwork, type NetLog } from '../../net';

type BrowserFactory = NonNullable<HeadlessOptions['browserFactory']>;
type BrowserOptions = Parameters<BrowserFactory>[0];

/**
 * Removes the browser's ways to open UDP sockets from a page: WebRTC (a peer connection, a data
 * channel, ICE servers that are IP literals) and WebTransport. Runs before the page's own scripts
 * in every frame, `about:blank` and `srcdoc` ones included.
 */
export const WEBRTC_BLOCK = `(() => {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'WebTransport']) {
    try { delete globalThis[name]; } catch (e) {}
    if (name in globalThis) {
      try { Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true }); } catch (e) {}
    }
  }
})();`;

/** The switches the network layer sets: nobody else may. */
const OWNED_SWITCHES = [
  '--ignore-certificate-errors-spki-list',
  '--host-resolver-rules',
  '--webrtc-ip-handling-policy',
  '--force-webrtc-ip-handling-policy',
  '--proxy-server',
  '--proxy-pac-url',
  '--proxy-bypass-list',
  '--no-proxy-server',
];

/** Throws when `launchArgs` sets a switch of the network layer. */
export function assertNoClash(launchArgs: readonly string[] | undefined): void {
  const clash = (launchArgs ?? []).filter((arg) =>
    OWNED_SWITCHES.some((name) => arg === name || arg.startsWith(`${name}=`)),
  );
  if (clash.length > 0) {
    throw new Error(
      `The browser options set switches that the evaluation network owns (${clash.join(' ')}): Chromium keeps one value of each, so the mapping would silently stop being the only way out`,
    );
  }
}

interface EvalBrowserOptions {
  network: EvalNetwork;
  /** The browser's net log: the main process' own requests that are denied go there too. */
  log: NetLog;
  /** Where the recording goes (`<runDir>/browser`), when the run records. */
  capture?: { dir: string; scratchDir: string };
}

export function createEvalBrowserFactory(options: EvalBrowserOptions): BrowserFactory {
  // No origin is allowed: every request of the main process that asks for the network fails like
  // a dead one, and leaves a `denied` record.
  const denied = createEgressGuard({ allowOrigins: [], log: options.log }).fetch;
  const { capture } = options;
  return (opts: BrowserOptions) => {
    const afirma = opts.afirma;
    assertNoClash(opts.launchArgs);
    return createBrowserService({
      ...opts,
      certificates: options.network,
      ignoreHTTPSErrors: false,
      headless: true,
      initScripts: [...(opts.initScripts ?? []), WEBRTC_BLOCK],
      // The CLI saves the run when it is interrupted: Playwright's own SIGINT handler would exit
      // the process (130) as soon as Chromium has closed, before anything is written.
      handleSignals: false,
      ...(capture
        ? {
            capture: {
              dir: (procedureId: string) => join(capture.dir, procedureId),
              scratchDir: capture.scratchDir,
              scrub: false,
            },
          }
        : {}),
      ...(afirma
        ? {
            afirma: {
              ...afirma,
              context: (procedureId: string) => ({ ...afirma.context(procedureId), fetch: denied }),
            },
          }
        : {}),
    });
  };
}

// ---------------------------------------------------------------------------------------------
// Browser state of a checkpoint
// ---------------------------------------------------------------------------------------------

export const BROWSER_STATE_FORMAT = 'sa-eval-browser-state/1';

/**
 * What a checkpoint keeps of the browser: Playwright's storage state (cookies and local storage)
 * of each procedure's context, by procedure id. Open pages are not kept: a restored agent opens
 * what it needs, still logged in.
 */
const StorageState = z.looseObject({
  cookies: z.array(z.unknown()).default([]),
  origins: z.array(z.unknown()).default([]),
});

const BrowserStateFile = z.object({
  format: z.literal(BROWSER_STATE_FORMAT),
  procedures: z.record(z.string(), StorageState),
});

/** The file of a checkpoint, from the storage states `exportState` gave (JSON texts) by procedure id. */
export function serializeBrowserState(states: Record<string, string>): string {
  const procedures: Record<string, unknown> = {};
  for (const [procedureId, state] of Object.entries(states)) {
    procedures[procedureId] = JSON.parse(state);
  }
  return `${JSON.stringify({ format: BROWSER_STATE_FORMAT, procedures }, null, 2)}\n`;
}

/** The storage states (JSON texts, as `importState` takes them) by procedure id. Throws on a file that is not one. */
export function parseBrowserState(text: string): Record<string, string> {
  const parsed = BrowserStateFile.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`Invalid browser state file:\n${z.prettifyError(parsed.error)}`);
  }
  return Object.fromEntries(
    Object.entries(parsed.data.procedures).map(([id, state]) => [id, JSON.stringify(state)]),
  );
}

/** A storage state with nothing in it (no cookie, no local storage) is not worth keeping. */
export function hasBrowserState(state: string): boolean {
  try {
    const parsed = JSON.parse(state) as { cookies?: unknown[]; origins?: unknown[] };
    return (parsed.cookies?.length ?? 0) > 0 || (parsed.origins?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
