/**
 * Chromium sends UDP for WebRTC (and WebTransport) straight to any IP address, around the proxy
 * and around `--host-resolver-rules`, which only rewrite names. This runs a page that tries, with a
 * UDP listener on loopback as the "somewhere else", through the browser factory the evaluation
 * uses and through browsers that lack one of its two defences:
 *
 *   control            neither the WebRTC policy switch nor the init script: the listener hears it
 *   switch only        `--webrtc-ip-handling-policy=disable_non_proxied_udp`: it does not
 *   init script only   `WEBRTC_BLOCK` in every frame: it does not
 *   the factory        both, the way a run launches Chromium
 */
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type BrowserService, createBrowserService } from '@sa/browser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvalNetwork, WEBRTC_POLICY } from '../../src/net/eval-network';
import { HostTable } from '../../src/net/hosts';
import { NetLog } from '../../src/net/netlog';
import { createEvalBrowserFactory, WEBRTC_BLOCK } from '../../src/run/app/browser';
import { cachedBrowser, notCachedMessage } from './chromium';
import { BENCH_HOSTS, COLLECTOR, type FakeBench, PORTAL, startFakeBench } from './fake-bench';

const chromium = cachedBrowser('chromium');

it.runIf(!chromium)(notCachedMessage('chromium'), () => {
  console.warn(notCachedMessage('chromium'));
});

interface Udp {
  port: number;
  received: Buffer[];
  close(): Promise<void>;
}

async function listenUdp(): Promise<Udp> {
  const socket = dgram.createSocket('udp4');
  const received: Buffer[] = [];
  socket.on('message', (message) => received.push(message));
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    port: socket.address().port,
    received,
    close: () => new Promise((resolve) => socket.close(() => resolve())),
  };
}

describe.skipIf(!chromium)('WebRTC and the evaluation browser', () => {
  let bench: FakeBench;
  let root: string;
  let network: EvalNetwork;
  let log: NetLog;
  const services: BrowserService[] = [];

  beforeAll(async () => {
    bench = await startFakeBench();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-eval-webrtc-'));
    log = new NetLog({ worldId: 'run-1', file: path.join(root, 'browser.jsonl') });
    network = new EvalNetwork({
      upstream: bench.origin,
      scoringOrigin: bench.scoringOrigin,
      hosts: HostTable.fromBenchHosts(BENCH_HOSTS, [{ pattern: COLLECTOR, kind: 'collector' }]),
      world: 'run-1',
      log,
    });
    await fs.mkdir(path.join(root, 'downloads'));
  });

  afterAll(async () => {
    for (const service of services) await service.closeAll();
    await network.close();
    log.close();
    await bench.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const options = (executablePath: string) => ({
    headless: true as const,
    executablePath,
    downloadsDir: path.join(root, 'downloads'),
    settleTimeoutMs: 3_000,
    onDownload: async () => ({ downloadId: 'd', name: 'x', mimeType: 'text/plain' }),
  });

  /** A service on the mapping with the defences of `with` (the factory's own when both). */
  function browser(defences: { policy: boolean; script: boolean }): BrowserService {
    const certificates = {
      get launchArgs() {
        return network.launchArgs.filter((arg) => defences.policy || arg !== WEBRTC_POLICY);
      },
      credentials: network.credentials,
      openSession: (session: string) => network.openSession(session),
      configure: () => network.configure(),
      endSession: (session: string) => network.endSession(session),
      networkError: (session: string, hostPort: string) => network.networkError(session, hostPort),
    };
    const service = createBrowserService({
      ...options(chromium as string),
      certificates,
      ...(defences.script ? { initScripts: [WEBRTC_BLOCK] } : {}),
    });
    services.push(service);
    return service;
  }

  /** Runs the page against a fresh UDP listener; what the page reported and what the listener heard. */
  async function run(service: BrowserService) {
    const udp = await listenUdp();
    try {
      await service.open('page', `https://${PORTAL}/webrtc?udp=${udp.port}`);
      const observed = await service.wait('page', { text: 'worker = ', seconds: 10 });
      // Give the ICE agent and QUIC time to send what they are going to send.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const lines = Object.fromEntries(
        [...observed.snapshot.matchAll(/paragraph \[ref=[^\]]+\]: ([\w-]+) = (.*)$/gm)].map((m) => [
          m[1],
          m[2],
        ]),
      );
      return { lines, datagrams: udp.received.length, snapshot: observed.snapshot };
    } finally {
      await udp.close();
    }
  }

  it('a browser with neither defence lets a page send UDP to any address (the control)', async () => {
    const control = await run(browser({ policy: false, script: false }));
    expect(control.lines.top).toContain('RTCPeerConnection:function');
    expect(control.datagrams).toBeGreaterThan(0);
  }, 60_000);

  it('the policy switch alone stops it', async () => {
    const result = await run(browser({ policy: true, script: false }));
    expect(result.lines.top).toContain('RTCPeerConnection:function');
    expect(result.datagrams).toBe(0);
  }, 60_000);

  it('the init script alone stops it, in the page and in every kind of frame', async () => {
    const result = await run(browser({ policy: false, script: true }));
    const none =
      'RTCPeerConnection:undefined,webkitRTCPeerConnection:undefined,RTCDataChannel:undefined,WebTransport:undefined';
    expect(result.lines.top).toBe(none);
    expect(result.lines.blank).toBe(none);
    expect(result.datagrams).toBe(0);
  }, 60_000);

  it('the factory the runs use has both, and nothing reaches the listener', async () => {
    const factory = createEvalBrowserFactory({ network, log });
    const service = factory(options(chromium as string) as never);
    services.push(service);
    const result = await run(service);
    const none =
      'RTCPeerConnection:undefined,webkitRTCPeerConnection:undefined,RTCDataChannel:undefined,WebTransport:undefined';
    expect(result.lines.top).toBe(none);
    expect(result.lines.blank).toBe(none);
    expect(result.lines.srcdoc).toBe(none);
    expect(result.datagrams).toBe(0);
    // The worker has no peer connection; whatever WebTransport it still has sends nothing either.
    expect(result.lines.worker).toMatch(/^worker WebTransport:(undefined|function)$/);
  }, 60_000);
});
