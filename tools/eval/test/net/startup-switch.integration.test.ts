/**
 * Chromium makes requests of its own at start and while idle (time, Google accounts, component
 * updates, DNS-over-HTTPS probes), around the page proxy. The one thing that stops them is the
 * host resolver rule that turns every name into "does not exist". Nothing else in the suite would
 * notice if that switch stopped working, so these tests do:
 *
 *   - the browser a run launches reports exactly the switches of the network layer, each once;
 *   - with those switches a name that would otherwise reach a loopback canary does not exist, and
 *     without the rule it does (the control), so the test can tell;
 *   - the app cannot hand the browser a second value of any of them.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium as playwright } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvalNetwork, HOST_RESOLVER_RULES } from '../../src/net/eval-network';
import { HostTable } from '../../src/net/hosts';
import { NetLog } from '../../src/net/netlog';
import { assertNoClash } from '../../src/run/app/browser';
import { cachedBrowser, notCachedMessage } from './chromium';

const executablePath = cachedBrowser('chromium');

it.runIf(!executablePath)(notCachedMessage('chromium'), () => {
  console.warn(notCachedMessage('chromium'));
});

describe('the switches of the network layer', () => {
  const network = new EvalNetwork({
    upstream: 'http://127.0.0.1:3010',
    scoringOrigin: 'http://127.0.0.1:3020',
    hosts: new HostTable(['portal.example-gov.test']),
    world: 'w',
    log: new NetLog({ worldId: 'w' }),
  });
  afterAll(() => network.close());

  it('are the pinned key, the resolver rule and the WebRTC policy, each once', () => {
    const names = network.launchArgs.map((arg) => arg.split('=')[0]);
    expect(names).toEqual([
      '--ignore-certificate-errors-spki-list',
      '--host-resolver-rules',
      '--webrtc-ip-handling-policy',
    ]);
    expect(network.launchArgs).toContain(HOST_RESOLVER_RULES);
  });

  it('cannot be set a second time by the options the app gives the browser', () => {
    expect(() => assertNoClash(undefined)).not.toThrow();
    expect(() => assertNoClash(['--lang=es', '--disable-gpu'])).not.toThrow();
    for (const arg of [
      '--host-resolver-rules=MAP * 1.2.3.4',
      '--host-resolver-rules',
      '--proxy-server=http://proxy.example:3128',
      '--no-proxy-server',
      '--proxy-bypass-list=*',
      '--webrtc-ip-handling-policy=default',
      '--force-webrtc-ip-handling-policy=default',
      '--ignore-certificate-errors-spki-list=abc',
    ]) {
      expect(() => assertNoClash(['--lang=es', arg]), arg).toThrow(/evaluation network owns/);
    }
  });
});

describe.skipIf(!executablePath)('the resolver rule in a real Chromium', () => {
  let canary: http.Server;
  let port: number;
  const hits: string[] = [];
  const network = new EvalNetwork({
    upstream: 'http://127.0.0.1:3010',
    scoringOrigin: 'http://127.0.0.1:3020',
    hosts: new HostTable(['portal.example-gov.test']),
    world: 'w',
    log: new NetLog({ worldId: 'w' }),
  });

  beforeAll(async () => {
    canary = http.createServer((req, res) => {
      // Chromium asks for the icon of a page it loaded, or not, depending on how fast it is closed.
      if (req.url === '/favicon.ico') return void res.writeHead(404).end();
      hits.push(`${req.headers.host}${req.url}`);
      res.end('canary');
    });
    await new Promise<void>((resolve) => canary.listen(0, '127.0.0.1', resolve));
    port = (canary.address() as AddressInfo).port;
  });
  afterAll(async () => {
    canary.closeAllConnections();
    await new Promise((resolve) => canary.close(resolve));
    await network.close();
  });

  /** Opens `url` in a Chromium started with `args` and no page proxy: what Chromium does by itself. */
  async function visit(args: string[], url: string): Promise<string> {
    const browser = await playwright.launch({ executablePath, headless: true, args });
    try {
      const page = await (await browser.newContext()).newPage();
      return await page
        .goto(url, { timeout: 15_000 })
        .then((response) => `reached ${response?.status()}`)
        .catch((error: Error) => /net::(ERR_\w+)/.exec(error.message)?.[1] ?? error.message);
    } finally {
      await browser.close();
    }
  }

  it('turns every name but 127.0.0.1 into one that does not exist, so nothing leaves around the proxy', async () => {
    const withRule = await visit(network.launchArgs, `http://app.localhost:${port}/by-name`);
    expect(withRule).toBe('ERR_NAME_NOT_RESOLVED');
    expect(hits).toEqual([]);
    // 127.0.0.1 itself is excluded: it is where the proxy listens.
    expect(await visit(network.launchArgs, `http://127.0.0.1:${port}/by-address`)).toBe(
      'reached 200',
    );
    expect(hits).toEqual([`127.0.0.1:${port}/by-address`]);
  }, 60_000);

  it('would resolve it without the rule (the control that makes the test mean something)', async () => {
    const without = network.launchArgs.filter((arg) => arg !== HOST_RESOLVER_RULES);
    hits.length = 0;
    expect(await visit(without, `http://app.localhost:${port}/by-name`)).toBe('reached 200');
    expect(hits).toEqual([`app.localhost:${port}/by-name`]);
  }, 60_000);

  it('reports the switches it was started with, each once', async () => {
    const browser = await playwright.launch({
      executablePath,
      headless: true,
      args: network.launchArgs,
    });
    try {
      const cdp = await browser.newBrowserCDPSession();
      const { commandLine } = (await cdp.send('SystemInfo.getInfo' as never)) as unknown as {
        commandLine: string;
      };
      for (const arg of network.launchArgs) {
        expect(commandLine.split(arg).length - 1, arg).toBe(1);
      }
      expect(commandLine.match(/--host-resolver-rules/g)).toHaveLength(1);
      expect(commandLine.match(/--webrtc-ip-handling-policy/g)).toHaveLength(1);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
