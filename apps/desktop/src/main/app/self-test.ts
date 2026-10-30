/**
 * `--self-test`: the app checks what only a build installed on its own OS can show, prints a JSON
 * report on stdout and exits 0 when every check passed, 1 otherwise. release.yml runs it on each
 * build runner after installing the build (the NSIS installer, the .deb, the macOS app); the e2e
 * parity project runs it on the development build (docs/ARCHITECTURE.md, "Shipping").
 *
 * - The browser: the bundled Chromium (Playwright's in development) starts through the real
 *   BrowserService as the app starts it, headed with its windows minimized, and enforces a CRLSet
 *   (the bundled fixture, which CrlSetStore installs from memory). Once the CRLSet settled and
 *   the session's window closed, it must still be running, and serve a second session and a
 *   second tab without a relaunch: v0.3.2's quit there on Windows and Linux, on every launch.
 * - sa-sidecar starts and proxies a request, and every page the browser loads.
 *
 * Small and safe in shipped builds: index.ts runs it on a new temporary profile, never the
 * user's, with no single-instance lock (it runs next to the app) and no error reports. It reads
 * no user data and talks to no running instance; its server, the sidecar and the browser's pages
 * are on 127.0.0.1, and the CRLSet comes from memory.
 */
import { once } from 'node:events';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Logger as BrowserLogger } from '@sa/browser';
import { Sidecar } from '@sa/sidecar';
import { createLogger } from '../core/logger';
import { errorMessage } from '../core/util';
import { crlSetFixture, fixtureCrlSetFetch } from '../crlset/fixture';
import { CrlSetStore } from '../crlset/store';
import type { BrowserFactory, BrowserPort } from '../ports';

export const SELF_TEST_FLAG = '--self-test';

/** The version of the fixture CRLSet (`crlset/fixtures/crlset-10850.crx3`). */
const FIXTURE_VERSION = '10850';
/**
 * How long the browser runs with no session window before the second session opens. The launch
 * itself already waited out the CRLSet's settle; v0.3.2's browser quit at once.
 */
const WITHOUT_WINDOWS_MS = 3_000;
/** The whole run's limit: a browser that never starts must not hang a release job. */
export const SELF_TEST_TIMEOUT_MS = 180_000;

/** One check: passed or not, how long it took, what it found or why it failed. */
interface SelfTestCheck {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
  error?: string;
}

export interface SelfTestReport {
  ok: boolean;
  checks: SelfTestCheck[];
  /** The run's log lines (there is no user data in them to hide). */
  log: string[];
}

export interface SelfTestOptions {
  /** An empty directory for the run's files (the CRLSet, the browser's downloads). */
  dir: string;
  /**
   * The bundled Chromium (`bundledChromiumPath`) in packaged builds, its `reason` when it is
   * missing; undefined for Playwright's own (development).
   */
  chromium?: { executable: string; version: string } | { reason: string };
  sidecarBinary: string;
  browserFactory: BrowserFactory;
  /** Tests only, where there is no display: the app always runs the browser headed. */
  headless?: boolean;
}

/** The checks, in order: the report fails when one is missing. */
const CHECKS = [
  'browser-executable',
  'crlset',
  'sidecar',
  'browser-launch',
  'browser-survives-without-windows',
  'browser-second-session',
] as const;

/** What the browser service logged (`packages/browser/src/service.ts`), as given. */
interface BrowserEvent {
  msg: string;
  data?: unknown;
}

export async function runSelfTest(opts: SelfTestOptions): Promise<SelfTestReport> {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', sinks: [(line) => lines.push(line)] });
  const checks: SelfTestCheck[] = [];
  const cleanup: (() => Promise<unknown>)[] = [];
  const check = async (name: (typeof CHECKS)[number], run: () => Promise<string | undefined>) => {
    const started = Date.now();
    try {
      const detail = await run();
      checks.push({ name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) });
      return true;
    } catch (err) {
      checks.push({ name, ok: false, ms: Date.now() - started, error: errorMessage(err) });
      return false;
    }
  };

  try {
    const chromium = opts.chromium;
    const found = await check('browser-executable', async () => {
      if (!chromium) return "Playwright's Chromium (development)";
      if ('reason' in chromium)
        throw new Error(`the bundled browser is missing: ${chromium.reason}`);
      return `bundled Chromium ${chromium.version}`;
    });
    if (!found) return report(checks, lines);
    const executablePath = chromium && 'executable' in chromium ? chromium.executable : undefined;
    const server = await startServer();
    cleanup.unshift(() => server.close());

    const crlSets = new CrlSetStore({
      dir: join(opts.dir, 'crlset'),
      fetch: fixtureCrlSetFetch(crlSetFixture()),
      logger: logger.child('crlset'),
    });
    const component = await crlSets.refresh().then(() => crlSets.component());
    await check('crlset', async () => {
      if (component?.version !== FIXTURE_VERSION)
        throw new Error(`CRLSet ${component?.version ?? 'none'} installed, not ${FIXTURE_VERSION}`);
      return `CRLSet ${component.version}, ${crlSets.blockedKeys().size} blocked keys`;
    });

    let sidecar: Sidecar | undefined;
    await check('sidecar', async () => {
      sidecar = await Sidecar.start({
        binaryPath: opts.sidecarBinary,
        logger: logger.child('sidecar'),
      });
      const proxy = await sidecar.openSession('self-test');
      const target = `${server.origin}/sidecar`;
      const denied = await viaProxy(proxy, target);
      if (denied.status !== 407) throw new Error(`without its password: HTTP ${denied.status}`);
      const res = await viaProxy(proxy, target, sidecar.credentials);
      if (res.status !== 200 || res.body !== SIDECAR_BODY)
        throw new Error(`through the proxy: HTTP ${res.status}`);
      return `proxied ${target}`;
    });
    if (sidecar) cleanup.unshift(() => (sidecar as Sidecar).close());
    if (!component) return report(checks, lines);

    const events: BrowserEvent[] = [];
    const browserLog = logger.child('browser');
    const record =
      (level: keyof BrowserLogger): BrowserLogger[typeof level] =>
      (msg, data) => {
        events.push({ msg, data });
        browserLog[level](msg, data);
      };
    const service: BrowserPort = opts.browserFactory({
      // As the app's BrowserHolder launches it.
      headless: opts.headless ?? false,
      startHidden: true,
      executablePath,
      crlSet: async () => component,
      ...(sidecar ? { certificates: sidecar } : {}),
      handleSignals: false,
      downloadsDir: join(opts.dir, 'downloads'),
      onDownload: async () => {
        throw new Error('The self-test downloads nothing');
      },
      logger: {
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
      },
    });
    cleanup.unshift(() => service.closeAll());
    const named = (msg: string) => events.filter((e) => e.msg === msg);

    const launched = await check('browser-launch', async () => {
      const obs = await service.open('self-test-1', `${server.origin}/one`);
      if (obs.title !== 'Uno') throw new Error(`the page's title is "${obs.title}", not "Uno"`);
      const crlSet = named('browser enforces a CRLSet')[0]?.data as
        | { version?: string }
        | undefined;
      if (crlSet?.version !== FIXTURE_VERSION) throw new Error('the browser enforces no CRLSet');
      const version = (named('browser launched')[0]?.data as { version?: string } | undefined)
        ?.version;
      return `Chromium ${version ?? '?'} with CRLSet ${crlSet.version}`;
    });
    if (!launched) return report(checks, lines);

    await check('browser-survives-without-windows', async () => {
      await service.close('self-test-1');
      await new Promise((resolve) => setTimeout(resolve, WITHOUT_WINDOWS_MS));
      const gone = named('browser disconnected')[0];
      if (gone)
        throw new Error(
          `the browser quit once the session's window closed: ${JSON.stringify(gone.data ?? {})}`,
        );
      return `still running ${WITHOUT_WINDOWS_MS} ms after its last session window closed`;
    });

    await check('browser-second-session', async () => {
      const first = await service.open('self-test-2', `${server.origin}/two`);
      if (first.title !== 'Dos') throw new Error(`the page's title is "${first.title}", not "Dos"`);
      const second = await service.open('self-test-2', `${server.origin}/one`, { newTab: true });
      if (second.title !== 'Uno' || second.tabs.length !== 2)
        throw new Error(`the new tab shows "${second.title}" of ${second.tabs.length} tabs`);
      if (!service.isOpen('self-test-2')) throw new Error('the session closed');
      const launches = named('browser launched').length;
      if (launches !== 1) throw new Error(`the browser was launched ${launches} times`);
      if (named('browser disconnected').length) throw new Error('the browser disconnected');
      return 'a new session and a second tab in the same browser';
    });
  } catch (err) {
    lines.push(`self-test failed: ${errorMessage(err)}`);
  } finally {
    for (const close of cleanup) await close().catch(() => {});
  }
  return report(checks, lines);
}

function report(checks: SelfTestCheck[], log: string[]): SelfTestReport {
  const ok = CHECKS.every((name) => checks.some((c) => c.name === name && c.ok));
  return { ok, checks, log };
}

const SIDECAR_BODY = 'sa-sidecar';

/** The pages the browser loads, and the response the sidecar check expects, on 127.0.0.1. */
async function startServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const page = (title: string) =>
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
  const routes: Record<string, [string, string]> = {
    '/one': ['text/html; charset=utf-8', page('Uno')],
    '/two': ['text/html; charset=utf-8', page('Dos')],
    '/sidecar': ['text/plain', SIDECAR_BODY],
  };
  const server = http.createServer((req, res) => {
    const route = routes[new URL(req.url ?? '/', 'http://x').pathname];
    res.writeHead(route ? 200 : 404, { 'content-type': route?.[0] ?? 'text/plain' });
    res.end(route?.[1] ?? 'not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A plain-http request through an HTTP proxy (`proxy`: `http://127.0.0.1:<port>`). */
function viaProxy(
  proxy: string,
  target: string,
  credentials?: { username: string; password: string },
): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(proxy);
  const auth = credentials
    ? Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')
    : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: hostname,
        port,
        path: target,
        headers: {
          host: new URL(target).host,
          ...(auth ? { 'proxy-authorization': `Basic ${auth}` } : {}),
        },
        timeout: 10_000,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('the proxy did not answer')));
    req.on('error', reject);
    req.end();
  });
}
