import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type Browser, chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/types';
import { createTestService, page, sendHtml, startServer, type TestServer } from './helpers';

let server: TestServer;
const marker = `sa-test-${randomUUID()}`;
let t: ReturnType<typeof createTestService>;
/** The browser of the latest launch in the early-exit tests, which `/dies` closes. */
let latest: Browser | undefined;

beforeAll(async () => {
  server = await startServer({
    '/login': (_req, res) =>
      sendHtml(res, page('<h1>Dentro</h1>'), { 'set-cookie': 'sid=abc123; Path=/' }),
    '/me': (req, res) => sendHtml(res, page(`<p>Cookies: ${req.headers.cookie ?? ''}</p>`)),
    '/crash': page('<p>Pestaña</p>'),
    // Closes the browser before its page loads (the answer never comes).
    '/dies': () => void latest?.close(),
  });
  // A unique (ignored) switch lets the test find and kill this browser's processes.
  t = createTestService({ launchArgs: [`--sa-test-marker=${marker}`] });
});

afterAll(async () => {
  await t?.cleanup();
  await server?.close();
});

interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

/** Every process with its parent and command line: `ps` on macOS and Linux, CIM on Windows. */
function processes(): ProcessInfo[] {
  if (process.platform === 'win32') {
    const json = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    ).toString();
    const list = JSON.parse(json) as {
      ProcessId: number;
      ParentProcessId: number;
      CommandLine: string | null;
    }[];
    return list.map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      command: p.CommandLine ?? '',
    }));
  }
  return execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], {
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString()
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] as string }));
}

function processesWithMarker(): ProcessInfo[] {
  return processes().filter((p) => p.command.includes(marker));
}

/** The process's children, theirs, and so on. */
function descendants(pid: number, all = processes()): ProcessInfo[] {
  return all
    .filter((p) => p.ppid === pid)
    .flatMap((child) => [child, ...descendants(child.pid, all)]);
}

async function waitFor(condition: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('crash recovery', () => {
  it('relaunches the browser on the next call, restoring cookies and the last page', async () => {
    await t.service.open('crash', `${server.origin}/login`);
    await t.service.open('crash', `${server.origin}/me`);
    await t.service.open('other', `${server.origin}/login`);

    const pids = processesWithMarker().map((p) => p.pid);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    await waitFor(() => !t.service.isOpen('crash'));
    expect(t.service.currentUrl('crash')).toBeUndefined();

    const obs = await t.service.snapshot('crash');
    expect(obs.url).toBe(`${server.origin}/me`);
    expect(obs.snapshot).toContain('Cookies: sid=abc123');
    expect(obs.notes.join('\n')).toContain('restarted');
    expect(t.service.isOpen('crash')).toBe(true);

    // Other procedures recover lazily too.
    const other = await t.service.open('other', `${server.origin}/me`);
    expect(other.snapshot).toContain('sid=abc123');
  });

  it('reloads a crashed tab on the next action', async () => {
    await t.service.open('tab', `${server.origin}/crash`);
    // Kill the renderer processes of this test's browser. On Linux they are the zygote's
    // children, not the browser's, so look at every descendant.
    const browserPid = processesWithMarker().find((p) => !p.command.includes('--type='))?.pid;
    expect(browserPid).toBeDefined();
    let killed = 0;
    for (const { pid, command } of descendants(browserPid as number)) {
      if (command.includes('--type=renderer')) {
        process.kill(pid, 'SIGKILL');
        killed++;
      }
    }
    expect(killed).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 500));
    const obs = await t.service.snapshot('tab');
    expect(obs.url).toBe(`${server.origin}/crash`);
    expect(obs.snapshot).toContain('Pestaña');
    expect(obs.notes.join('\n')).toContain('crashed');
  });
});

describe('a browser that closes by itself right after launch', () => {
  async function withLaunches(
    test: (opts: {
      t: ReturnType<typeof createTestService>;
      launches: () => number;
      warnings: { msg: string; data?: unknown }[];
      /** Opens `/dies` and waits until its browser is gone. */
      dies: () => Promise<void>;
    }) => Promise<void>,
  ): Promise<void> {
    const launch = chromium.launch.bind(chromium);
    const spy = vi.spyOn(chromium, 'launch').mockImplementation(async (options) => {
      latest = await launch(options);
      return latest;
    });
    const warnings: { msg: string; data?: unknown }[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (msg, data) => warnings.push({ msg, data }),
      error: (msg, data) => warnings.push({ msg, data }),
    };
    const service = createTestService({ logger });
    const dies = async () => {
      // It may fail or not, depending on when the browser goes: only the browser matters here.
      await service.service.open('dies', `${server.origin}/dies`).catch(() => undefined);
      await expect.poll(() => latest?.isConnected()).toBe(false);
    };
    try {
      await test({ t: service, launches: () => spy.mock.calls.length, warnings, dies });
    } finally {
      spy.mockRestore();
      await service.cleanup();
    }
  }

  it('is relaunched once, then the service stops relaunching it', () =>
    withLaunches(async ({ t, launches, warnings, dies }) => {
      await dies();
      await dies();
      expect(launches()).toBe(2);
      const error = await t.service.open('next', `${server.origin}/crash`).catch((e) => e);
      expect(error).toMatchObject({ code: 'unavailable' });
      expect(error.message).toMatch(/Do not retry/);
      expect(launches()).toBe(2);
      expect(warnings).toContainEqual({
        msg: 'browser disconnected',
        data: { afterLaunchMs: expect.any(Number), pageLoaded: false, earlyExits: 2 },
      });
    }));

  it('counts only browsers in a row that close before loading a page', () =>
    withLaunches(async ({ t, launches, warnings, dies }) => {
      await dies();
      // This one loads a page before it closes: the count starts over.
      await t.service.open('ok', `${server.origin}/crash`);
      await latest?.close();
      await dies();
      const obs = await t.service.open('ok', `${server.origin}/crash`);
      expect(obs.snapshot).toContain('Pestaña');
      expect(launches()).toBe(4);
      expect(
        warnings
          .filter((w) => w.msg === 'browser disconnected')
          .map((w) => (w.data as { earlyExits: number }).earlyExits),
      ).toEqual([1, 0, 1]);
    }));

  it('starts over after closeAll, whose own close is not an early exit', () =>
    withLaunches(async ({ t, launches, dies }) => {
      await dies();
      await dies();
      await t.service.closeAll();
      // A browser that loaded nothing, closed by closeAll: not an early exit, so one more early
      // exit still leaves the browser one relaunch.
      await t.service.open('blank', 'about:blank');
      await t.service.closeAll();
      await dies();
      const obs = await t.service.open('fresh', `${server.origin}/crash`);
      expect(obs.snapshot).toContain('Pestaña');
      expect(launches()).toBe(5);
    }));
});
