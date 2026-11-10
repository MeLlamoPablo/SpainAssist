/**
 * A page's clock in the evaluation browser: the world's frozen day, ticking, as the agents' and
 * the server's are. A mock's own script that checks a date against `new Date()` (a past date, a
 * datepicker's first day) would otherwise read the machine's day.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserService } from '@sa/browser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvalNetwork } from '../../src/net/eval-network';
import { HostTable } from '../../src/net/hosts';
import { NetLog } from '../../src/net/netlog';
import { createEvalBrowserFactory } from '../../src/run/app/browser';
import { cachedBrowser, notCachedMessage } from './chromium';
import { BENCH_HOSTS, type FakeBench, PORTAL, startFakeBench } from './fake-bench';

const chromium = cachedBrowser('chromium');

it.runIf(!chromium)(notCachedMessage('chromium'), () => {
  console.warn(notCachedMessage('chromium'));
});

/** 10:00 in Madrid on the day of `tasa-790-012`'s world. */
const WORLD_NOW = '2026-11-03T10:00:00+01:00';

describe.skipIf(!chromium)("the world's clock in the evaluation browser", () => {
  let bench: FakeBench;
  let root: string;
  let network: EvalNetwork;
  let log: NetLog;
  let service: BrowserService;

  beforeAll(async () => {
    bench = await startFakeBench();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-eval-clock-'));
    log = new NetLog({ worldId: 'run-1', file: path.join(root, 'browser.jsonl') });
    network = new EvalNetwork({
      upstream: bench.origin,
      scoringOrigin: bench.scoringOrigin,
      hosts: HostTable.fromBenchHosts(BENCH_HOSTS),
      world: 'run-1',
      log,
    });
    await fs.mkdir(path.join(root, 'downloads'));
    const startMs = Date.parse(WORLD_NOW);
    const startedAt = Date.now();
    const factory = createEvalBrowserFactory({
      network,
      log,
      clock: () => new Date(startMs + (Date.now() - startedAt)),
    });
    service = factory({
      headless: true,
      executablePath: chromium as string,
      downloadsDir: path.join(root, 'downloads'),
      settleTimeoutMs: 3_000,
      onDownload: async () => ({ downloadId: 'd', name: 'x', mimeType: 'text/plain' }),
    } as never);
  });

  afterAll(async () => {
    await service?.closeAll();
    await network.close();
    log.close();
    await bench.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("gives a page the world's day, still ticking, and leaves dates it builds alone", async () => {
    await service.open('page', `https://${PORTAL}/`);
    const seen = (await service.query('page', '', 'evaluate', {
      fn: `async () => {
        const first = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          now: new Date().toISOString(),
          called: Date(),
          ticked: Date.now() - first,
          isDate: new Date() instanceof Date && new Date().constructor === Date,
          built: new Date(2020, 0, 2).getFullYear(),
          parsed: Date.parse('2020-01-02T00:00:00Z'),
          utc: Date.UTC(2020, 0, 2),
        };
      }`,
    })) as Record<string, unknown>;
    const now = Date.parse(seen.now as string);
    expect(now - Date.parse(WORLD_NOW)).toBeGreaterThanOrEqual(0);
    expect(now - Date.parse(WORLD_NOW)).toBeLessThan(60_000);
    expect(seen.called).toContain('Nov 03 2026');
    expect(seen.ticked).toBeGreaterThanOrEqual(40);
    expect(seen.isDate).toBe(true);
    expect(seen.built).toBe(2020);
    expect(seen.parsed).toBe(Date.UTC(2020, 0, 2));
    expect(seen.utc).toBe(Date.UTC(2020, 0, 2));
  }, 60_000);
});
