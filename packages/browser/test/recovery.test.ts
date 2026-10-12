import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestService, page, sendHtml, startServer, type TestServer } from './helpers';

let server: TestServer;
const marker = `sa-test-${randomUUID()}`;
let t: ReturnType<typeof createTestService>;

beforeAll(async () => {
  server = await startServer({
    '/login': (_req, res) =>
      sendHtml(res, page('<h1>Dentro</h1>'), { 'set-cookie': 'sid=abc123; Path=/' }),
    '/me': (req, res) => sendHtml(res, page(`<p>Cookies: ${req.headers.cookie ?? ''}</p>`)),
    '/crash': page('<p>Pestaña</p>'),
  });
  // A unique (ignored) switch lets the test find and kill this browser's processes.
  t = createTestService({ launchArgs: [`--sa-test-marker=${marker}`] });
});

afterAll(async () => {
  await t?.cleanup();
  await server?.close();
});

function processesWithMarker(): { pid: number; command: string }[] {
  return execFileSync('pgrep', ['-f', marker])
    .toString()
    .trim()
    .split('\n')
    .map(Number)
    .map((pid) => ({ pid, command: commandOf(pid) }));
}

function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)]).toString();
  } catch {
    return ''; // exited meanwhile
  }
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
    // Kill the renderer processes (children of this test's browser process).
    const browserPid = processesWithMarker().find((p) => !p.command.includes('--type='))?.pid;
    expect(browserPid).toBeDefined();
    const children = execFileSync('pgrep', ['-P', String(browserPid)])
      .toString()
      .trim()
      .split('\n')
      .map(Number);
    let killed = 0;
    for (const pid of children) {
      if (commandOf(pid).includes('--type=renderer')) {
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
