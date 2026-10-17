/**
 * EvalNetwork with the real browser service (`@sa/browser`) and a real Chromium, against a tiny
 * fake SpainBench (fake-bench.ts). Hosts are `.test` names; every browser here either goes through
 * the mapping proxy or has name resolution switched off, so nothing can reach a real host.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type BrowserService, createBrowserService } from '@sa/browser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvalNetwork } from '../../src/net/eval-network';
import { HostTable } from '../../src/net/hosts';
import { NetLog } from '../../src/net/netlog';
import { readNetLog } from '../../src/net/netlog-reader';
import { cachedBrowser, notCachedMessage } from './chromium';
import {
  BENCH_HOSTS,
  CLAVE,
  COLLECTOR,
  type FakeBench,
  IDP,
  PORTAL,
  startFakeBench,
  UNMAPPED,
} from './fake-bench';

const shell = cachedBrowser('chromium-headless-shell');
const fullChromium = cachedBrowser('chromium');

// A skipped describe prints nothing: say why in a test of its own.
it.runIf(!shell)(notCachedMessage('chromium-headless-shell'), () => {
  console.warn(notCachedMessage('chromium-headless-shell'));
});
it.runIf(!fullChromium)(notCachedMessage('chromium'), () => {
  console.warn(notCachedMessage('chromium'));
});

interface Stored {
  procedureId: string;
  name: string;
  mimeType: string;
  data: Buffer;
}

function refOf(snapshot: string, pattern: RegExp | string): string {
  for (const line of snapshot.split('\n')) {
    if (!(typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line))) continue;
    const m = /\[ref=((?:f\d+)?e\d+)\]/.exec(line);
    if (m?.[1]) return m[1];
  }
  throw new Error(`No ref for ${pattern} in:\n${snapshot}`);
}

/** A browser service on the mapping, with the world "run-1". */
async function startRun(opts: {
  executablePath?: string;
  capture?: { dir: string; scratch: string; scrub?: boolean };
  scrub?: (text: string) => string;
}) {
  const bench = await startFakeBench();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-eval-net-'));
  const hosts = HostTable.fromBenchHosts(BENCH_HOSTS, [{ pattern: COLLECTOR, kind: 'collector' }]);
  const logFile = path.join(root, 'net', 'browser.jsonl');
  const log = new NetLog({ worldId: 'run-1', file: logFile, scrub: opts.scrub });
  const network = new EvalNetwork({
    upstream: bench.origin,
    scoringOrigin: bench.scoringOrigin,
    hosts,
    world: 'run-1',
    log,
  });
  const stored: Stored[] = [];
  const downloadsDir = path.join(root, 'downloads');
  await fs.mkdir(downloadsDir);
  const service = createBrowserService({
    headless: true,
    executablePath: opts.executablePath,
    downloadsDir,
    settleTimeoutMs: 5_000,
    certificates: network,
    onDownload: async (procedureId, file) => {
      stored.push({
        procedureId,
        name: file.suggestedName,
        mimeType: file.mimeType,
        data: await fs.readFile(file.path),
      });
      return {
        downloadId: `dl-${stored.length}`,
        name: file.suggestedName,
        mimeType: file.mimeType,
      };
    },
    ...(opts.capture
      ? {
          capture: {
            dir: () => opts.capture?.dir,
            scratchDir: opts.capture.scratch,
            scrub: opts.capture.scrub,
          },
        }
      : {}),
  });
  return {
    bench,
    hosts,
    log,
    logFile,
    network,
    service,
    stored,
    root,
    async stop() {
      await service.closeAll();
      await network.close();
      log.close();
      await bench.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!shell)('EvalNetwork with the browser service (headless shell)', () => {
  let run: Awaited<ReturnType<typeof startRun>>;
  let service: BrowserService;
  let bench: FakeBench;
  beforeAll(async () => {
    run = await startRun({ executablePath: shell });
    service = run.service;
    bench = run.bench;
  });
  afterAll(async () => {
    await run?.stop();
  });

  const seen = (host: string, pathname: string) =>
    bench.requests.filter((r) => r.host === host && r.path.split('?')[0] === pathname);

  it('keeps the real URL and serves every kind of sub-resource through the mapping', async () => {
    const opened = await service.open('page', `https://${PORTAL}/`);
    expect(opened.url).toBe(`https://${PORTAL}/`);
    expect(opened.title).toBe('Portal');
    expect(service.currentUrl('page')).toBe(`https://${PORTAL}/`);
    const obs = await service.wait('page', { text: 'xhr = 200', seconds: 5 });

    // What the page's own scripts saw (a fetch with forged headers, an XHR, a failed request to an
    // unmapped host): the mapping is invisible from inside the page.
    expect(obs.snapshot).toContain('unmapped = TypeError');
    expect(obs.snapshot).toContain('xhr = 200');
    const echo = /echo = (.*)$/m.exec(obs.snapshot)?.[1] ?? '';
    expect(Object.fromEntries(echo.split(' ').map((kv) => kv.split(':')))).toEqual({
      world: 'run-1',
      source: 'browser',
      resourceType: 'fetch',
      host: PORTAL,
      proto: 'https',
      harness: '1',
    });

    const type = (host: string, p: string) =>
      seen(host, p)[0]?.headers['x-spainbench-resource-type'];
    expect(type(PORTAL, '/')).toBe('document');
    expect(type(PORTAL, '/style.css')).toBe('stylesheet');
    expect(type(PORTAL, '/app.js')).toBe('script');
    expect(type(PORTAL, '/pixel.gif')).toBe('image');
    expect(type(PORTAL, '/echo')).toBe('fetch');
    expect(type(PORTAL, '/xhr')).toBe('xhr');
    expect(type(IDP, '/frame')).toBe('subdocument');
    for (const r of bench.requests) {
      expect(r.headers['x-spainbench-source'], r.path).toBe('browser');
      expect(r.headers['x-spainbench-world'], r.path).toBe('run-1');
      expect(r.headers['x-spainbench-harness'], r.path).toBe('1');
      expect(r.headers['x-spainbench-host'], r.path).toBe(r.host);
      expect(r.hostHeader, r.path).toBe(r.host);
      expect(r.headers['x-forwarded-proto'], r.path).toBe('https');
    }
    // Browser headers arrive as the browser sent them.
    expect(seen(PORTAL, '/')[0]?.headers['sec-fetch-mode']).toBe('navigate');
    expect(seen(PORTAL, '/pixel.gif')[0]?.headers.referer).toBe(`https://${PORTAL}/`);
    // The beacon to the (mapped) collector reached it, with its body.
    expect(seen(COLLECTOR, '/beacon')[0]?.body).toBe('canary=53918274H');
  });

  it('overwrites the x-spainbench-* headers a page sends, and the log shows the attempt', async () => {
    const echo = seen(PORTAL, '/echo')[0];
    expect(echo?.headers['x-spainbench-world']).toBe('run-1');
    expect(echo?.headers['x-spainbench-source']).toBe('browser');
    expect(echo?.headers['x-spainbench-host']).toBe(PORTAL);
    const record = run.log.tail(10_000).find((r) => r.host === PORTAL && r.url.endsWith('/echo'));
    expect(record?.reqHeaders['x-spainbench-world']).toBe('forged-world');
    expect(record?.resourceType).toBe('fetch');
  });

  it('follows a cross-host redirect chain and ends on the real URL', async () => {
    const before = bench.requests.length;
    const obs = await service.open('chain', `https://${PORTAL}/login`);
    expect(obs.url).toBe(`https://${PORTAL}/back`);
    expect(obs.snapshot).toContain('De vuelta en el portal');
    expect(
      bench.requests
        .slice(before)
        .filter((r) => r.headers['x-spainbench-resource-type'] === 'document')
        .map((r) => `${r.host}${r.path.split('?')[0]}`),
    ).toEqual([`${PORTAL}/login`, `${IDP}/sso`, `${CLAVE}/auth`, `${PORTAL}/back`]);
    // A redirect to the mock's own address is repaired before the browser sees it.
    const leaky = await service.open('chain', `https://${PORTAL}/leaky-redirect`);
    expect(leaky.url).toBe(`https://${PORTAL}/back`);
  });

  it('keeps cookies per real host and domain, and none for the mock', async () => {
    await service.open('cookies', `https://${PORTAL}/set-cookie`);
    let obs = await service.open('cookies', `https://${IDP}/whoami`);
    expect(obs.snapshot).toContain('shared=2');
    expect(obs.snapshot).not.toContain('host_only');
    obs = await service.open('cookies', `https://${PORTAL}/whoami`);
    for (const c of ['host_only=1', 'shared=2', 'third=3']) expect(obs.snapshot).toContain(c);

    // The idp sets a cookie of its own and one for the whole domain on its way through.
    await service.open('cookies', `https://${PORTAL}/login`);
    obs = await service.open('cookies', `https://${PORTAL}/whoami`);
    expect(obs.snapshot).toContain('shared_idp=9');
    expect(obs.snapshot).not.toContain('idp_only');
    obs = await service.open('cookies', `https://${IDP}/whoami`);
    expect(obs.snapshot).toContain('idp_only=1');

    const state = JSON.parse((await service.exportState('cookies')) ?? '{}') as {
      cookies: { name: string; domain: string; httpOnly: boolean; secure: boolean }[];
    };
    expect(state.cookies.length).toBeGreaterThanOrEqual(5);
    for (const c of state.cookies) expect(c.domain, c.name).toMatch(/example-gov\.test$/);
    expect(state.cookies.find((c) => c.name === 'third')?.httpOnly).toBe(true);
  });

  it('delivers an attachment the agent clicked', async () => {
    let obs = await service.open('files', `https://${PORTAL}/`);
    obs = await service.click('files', refOf(obs.snapshot, 'link "Descargar informe"'));
    expect(obs.downloads.map((d) => d.name)).toEqual(['vida_laboral.pdf']);
    const file = run.stored.find((d) => d.name === 'vida_laboral.pdf');
    expect(file?.mimeType).toBe('application/pdf');
    expect(file?.data.subarray(0, 5).toString()).toBe('%PDF-');
    // Navigating straight to it is a download too.
    const direct = await service.open('files', `https://${PORTAL}/attachment.pdf`);
    expect(direct.downloads.map((d) => d.name)).toEqual(['vida_laboral.pdf']);
    expect(seen(PORTAL, '/attachment.pdf')).toHaveLength(2);
  });

  it('captures a PDF that Chromium would show inline as a download', async () => {
    const obs = await service.open('inline', `https://${PORTAL}/inline.pdf`);
    expect(obs.downloads.map((d) => d.name)).toEqual(['informe.pdf']);
    expect(
      run.stored
        .find((d) => d.name === 'informe.pdf')
        ?.data.subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
  });

  it('fails an unmapped host exactly like a domain that does not exist', async () => {
    // The control: the same browser without any proxy, with every name failing to resolve.
    const control = createBrowserService({
      headless: true,
      executablePath: shell,
      downloadsDir: run.root,
      launchArgs: ['--host-resolver-rules=MAP * ~NOTFOUND'],
      onDownload: async () => ({ downloadId: 'x', name: 'x', mimeType: 'x' }),
    });
    const message = async (s: BrowserService, procedure: string, url: string) => {
      try {
        await s.open(procedure, url);
      } catch (err) {
        return (err as Error).message;
      }
      return 'opened';
    };
    try {
      const urls = [
        `https://${UNMAPPED}/`,
        `http://${UNMAPPED}/inicio?x=1`,
        `https://${UNMAPPED}:8443/`,
      ];
      for (const [i, url] of urls.entries()) {
        // One procedure (context, page) per attempt: Chromium cancels a navigation that starts
        // right after a failed one.
        const expected = await message(control, `dead-${i}`, url);
        expect(expected).toContain('ERR_NAME_NOT_RESOLVED');
        expect(await message(service, `dead-${i}`, url), url).toBe(expected);
      }
    } finally {
      await control.closeAll();
    }
    expect(bench.requests.some((r) => r.host === UNMAPPED)).toBe(false);
    const refused = run.log.tail(10_000).filter((r) => r.host === UNMAPPED);
    expect(refused.length).toBeGreaterThanOrEqual(3);
    expect(refused.every((r) => r.route === 'unmapped')).toBe(true);
    expect(refused.map((r) => r.method).sort()).toContain('CONNECT');
  });

  it('cannot reach the scoring port, by any name', async () => {
    const port = new URL(bench.scoringOrigin).port;
    const urls = [
      `http://127.0.0.1:${port}/worlds`,
      `http://localhost:${port}/worlds`,
      `https://127.0.0.1:${port}/worlds`,
      `http://[::1]:${port}/worlds`,
    ];
    for (const [i, url] of urls.entries()) {
      await expect(service.open(`scoring-${i}`, url), url).rejects.toThrow(
        /ERR_CONNECTION_REFUSED/,
      );
    }
    expect(bench.scoringHits).toEqual([]);
  });

  it('has a complete network log: one record for every request that reached the mock', async () => {
    await new Promise((r) => setTimeout(r, 400)); // late favicons and the like
    const records = run.log.tail(100_000);
    const mapped = records.filter((r) => r.route === 'mapped');
    expect(mapped.length).toBe(bench.requests.length);
    for (const request of bench.requests) {
      const record = mapped.find((r) => r.bench?.seq === request.seq);
      expect(record, `${request.host}${request.path}`).toBeDefined();
      expect(record?.host).toBe(request.host);
      expect(record?.method).toBe(request.method);
      expect(record?.url).toBe(`https://${request.host}${request.path}`);
      expect(record?.channel).toBe('browser');
      expect(record?.status).toBeGreaterThan(0);
      expect(record?.resourceType).toBeDefined();
    }
    // The file is the same log.
    const onDisk = await readNetLog(run.logFile);
    expect(onDisk).toEqual(records);
    // Refusals are in it too, never counted as served.
    expect(records.some((r) => r.route === 'unmapped')).toBe(true);
    expect(new Set(records.map((r) => r.worldId))).toEqual(new Set(['run-1']));
    expect(records.map((r) => r.seq)).toEqual(
      [...records.map((r) => r.seq)].sort((a, b) => a - b).filter(Boolean).length
        ? expect.any(Array)
        : [],
    );
  });
});

describe.skipIf(!shell)('EvalNetwork with capture mode (headless shell)', () => {
  it('records a HAR under the real URLs, keeps typed values when scrub is off, and scrubs the net log', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-eval-net-cap-'));
    const captures = path.join(root, 'captures');
    const PASSWORD = 'Cl4ve-Prueba-9';
    const run = await startRun({
      executablePath: shell,
      capture: { dir: captures, scratch: path.join(root, 'scratch'), scrub: false },
      scrub: (text) => text.split(PASSWORD).join('«secret:1»'),
    });
    try {
      let obs = await run.service.open('cap', `https://${PORTAL}/form`);
      await run.service.type('cap', refOf(obs.snapshot, 'textbox "Usuario"'), 'ana.prueba');
      await run.service.type('cap', refOf(obs.snapshot, 'textbox "Clave"'), PASSWORD, {
        secret: true,
      });
      obs = await run.service.click('cap', refOf(obs.snapshot, 'button "Entrar"'));
      expect(obs.url).toBe(`https://${PORTAL}/post`);
      await run.service.finishCapture('cap');

      const [stamp] = await fs.readdir(captures);
      const dir = path.join(captures, stamp as string);
      const info = JSON.parse(await fs.readFile(path.join(dir, 'capture.json'), 'utf8'));
      expect(info).toMatchObject({ har: true, trace: true, secrets: 0 });
      const har = await fs.readFile(path.join(dir, 'network.har'), 'utf8');
      const urls = (JSON.parse(har).log.entries as { request: { url: string } }[]).map(
        (e) => e.request.url,
      );
      expect(urls).toContain(`https://${PORTAL}/form`);
      expect(urls.every((u) => !u.includes('127.0.0.1'))).toBe(true);
      // scrub: false keeps what was typed (synthetic data) ...
      expect(har).toContain(PASSWORD);
      // ... but the net log of the run, which has a scrub hook, does not.
      const posts = run.log.tail(1000).filter((r) => r.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0]?.reqBody).toBe('u=ana.prueba&p=«secret:1»');
      expect(JSON.stringify(run.log.tail(1000))).not.toContain(PASSWORD);
    } finally {
      await run.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!fullChromium)('EvalNetwork with Chromium and its PDF viewer', () => {
  it('captures an inline PDF and closes a recorded context cleanly', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-eval-net-pdf-'));
    const captures = path.join(root, 'captures');
    const run = await startRun({
      capture: { dir: captures, scratch: path.join(root, 'scratch') },
    });
    try {
      const obs = await run.service.open('pdf', `https://${PORTAL}/inline.pdf`);
      expect(obs.url).toBe(`https://${PORTAL}/inline.pdf`);
      expect(obs.downloads.map((d) => d.name)).toEqual(['informe.pdf']);
      expect(obs.notes.join('\n')).toContain('was downloaded');
      await run.service.finishCapture('pdf');
      const [stamp] = await fs.readdir(captures);
      const info = JSON.parse(
        await fs.readFile(path.join(captures, stamp as string, 'capture.json'), 'utf8'),
      );
      expect(info).toMatchObject({ har: true });
      const record = run.log
        .tail(1000)
        .find((r) => r.url === `https://${PORTAL}/inline.pdf` && r.status === 200);
      expect(record?.resourceType).toBe('document');
    } finally {
      await run.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
