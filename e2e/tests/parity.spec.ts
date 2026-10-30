import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { ChatItem } from '@sa/shared';
import { expect, invoke, test } from '../fixtures';
import {
  assistantRules,
  assistantSaid,
  connect,
  idle,
  PROCEDURE,
  procedureTitled,
} from '../helpers';

/**
 * The parity project (playwright.config.ts): the agent's browser as users get it, headed with
 * its windows minimized and a CRLSet, where the other projects run it headless without one. On
 * Windows and Linux headed Chromium quits when its last window closes: v0.3.2's did after every
 * launch, and only a headed run off macOS shows it. CI runs this project on Linux (xvfb-run) and
 * on Windows.
 */

const root = resolve(import.meta.dirname, '../..');

/** The main log's lines from the browser service (`[browser] <message> {data}`). */
async function browserLog(userData: string): Promise<string[]> {
  const text = await readFile(join(userData, 'logs', 'main.log'), 'utf8');
  return text.split('\n').filter((line) => line.includes(' [browser] '));
}

test('the browser outlives its windows: a procedure closes it, waits and browses again', async ({
  harness: h,
}) => {
  await connect(h);
  const url = h.sede.url;
  h.llm.setScenario({
    name: 'parity',
    rules: [
      ...assistantRules('Abrir la sede', 'Abre la sede de prueba.', 'La sede está abierta.'),
      // 4. Done, after a second tab of the same browser.
      {
        when: {
          hasTool: PROCEDURE,
          lastTool: 'browser_open',
          toolCalled: { name: 'browser_open', atLeast: 3 },
        },
        reply: { text: 'He abierto la sede de prueba.' },
      },
      // 3. A second tab.
      {
        when: {
          hasTool: PROCEDURE,
          lastTool: 'browser_open',
          toolCalled: { name: 'browser_close' },
        },
        reply: { toolCalls: [{ name: 'browser_open', arguments: { url, newTab: true } }] },
      },
      // 2. The browser is left with no session window for a while, then the site opens again.
      {
        when: { hasTool: PROCEDURE, lastTool: 'browser_close' },
        reply: { delayMs: 3_000, toolCalls: [{ name: 'browser_open', arguments: { url } }] },
      },
      // 1. The first page launches the browser (the CRLSet settles first); then its window closes.
      {
        when: { hasTool: PROCEDURE, lastTool: 'browser_open' },
        reply: { toolCalls: [{ name: 'browser_close', arguments: {} }] },
      },
      {
        when: { hasTool: PROCEDURE, turn: 0 },
        reply: { toolCalls: [{ name: 'browser_open', arguments: { url } }] },
      },
    ],
  });
  await invoke(h.page, 'chat.send', { text: 'Abre la sede de prueba' });
  const procedure = await procedureTitled(h, 'Abrir la sede');
  const log = await idle(h, procedure.id);
  const calls = log.filter(
    (i): i is Extract<ChatItem, { type: 'activity' }> =>
      i.type === 'activity' && i.tool.startsWith('browser_'),
  );
  expect(calls.map((i) => [i.tool, i.status])).toEqual([
    ['browser_open', 'done'],
    ['browser_close', 'done'],
    ['browser_open', 'done'],
    ['browser_open', 'done'],
  ]);
  await assistantSaid(h, 'La sede está abierta.');

  // One headed launch with the CRLSet, which never went away.
  let lines: string[] = [];
  await expect
    .poll(async () => {
      lines = await browserLog(h.userData);
      return lines.some((line) => line.includes('browser enforces a CRLSet'));
    })
    .toBe(true);
  const launches = lines.filter((line) => line.includes('browser launched'));
  expect(launches, lines.join('\n')).toHaveLength(1);
  expect(launches[0]).toContain('"headless":false');
  expect(lines.find((line) => line.includes('browser enforces a CRLSet'))).toContain('"10850"');
  expect(lines.filter((line) => line.includes('browser disconnected'))).toEqual([]);
});

test('the development build passes its --self-test', async () => {
  test.setTimeout(240_000);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const electron = createRequire(import.meta.url)('electron') as string;
  const child = spawn(electron, [join(root, 'apps/desktop'), '--self-test'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((done, fail) => {
    child.once('error', fail);
    child.once('exit', (exitCode) => done(exitCode));
  });
  const last = stdout.trim().split('\n').at(-1) ?? '';
  await test.info().attach('self-test.json', { body: last, contentType: 'application/json' });
  expect(code, `${stdout}\n${stderr}`).toBe(0);
  const report = JSON.parse(last) as { ok: boolean; checks: { name: string; ok: boolean }[] };
  expect(report.ok).toBe(true);
  expect(report.checks.map((c) => [c.name, c.ok])).toEqual([
    ['browser-executable', true],
    ['crlset', true],
    ['sidecar', true],
    ['browser-launch', true],
    ['browser-survives-without-windows', true],
    ['browser-second-session', true],
  ]);
});
