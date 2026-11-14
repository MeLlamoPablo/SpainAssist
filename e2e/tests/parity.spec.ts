import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { expect, invoke, test } from '../fixtures';
import {
  AGENT,
  agentIdle,
  assistantSaid,
  codemodeCall,
  codemodeCalls,
  connect,
  coordinatorRules,
  procedureTitled,
  theAgent,
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

test('the browser outlives its windows: an agent closes it, waits and browses again', async ({
  harness: h,
}) => {
  await connect(h);
  const url = h.sede.url;
  h.llm.setScenario({
    name: 'parity',
    rules: [
      ...coordinatorRules('Abre la sede de prueba.', 'La sede está abierta.', 'He abierto'),
      // 3. Done.
      {
        when: {
          hasTool: AGENT,
          lastTool: 'codemode',
          toolCalled: { name: 'codemode', atLeast: 2 },
        },
        reply: { text: 'He abierto la sede de prueba.' },
      },
      // 2. The browser was left with no session window for a while; the site opens again, then
      // in a second tab of the same browser.
      {
        when: { hasTool: AGENT, lastTool: 'codemode', lastToolResult: 'succeeded' },
        reply: {
          delayMs: 3_000,
          toolCalls: [
            codemodeCall({
              workflow: 'abrir-otra-vez',
              title: 'Abrir la sede otra vez',
              source: `export async function main(api) {
  const [card] = await api.procedures.list();
  await api.procedures.getOrCreate({ id: card.id, title: card.title });
  const page = await api.browser.currentPage();
  await page.goto('${url}');
  await page.goto('${url}', { newTab: true });
  return { tabs: (await page.tabs()).length };
}
`,
            }),
          ],
        },
      },
      // 1. The first page launches the browser (the CRLSet settles first); then its window closes.
      {
        when: { hasTool: AGENT, turn: 0 },
        reply: {
          toolCalls: [
            codemodeCall({
              workflow: 'abrir-sede',
              title: 'Abrir la sede',
              source: `export async function main(api) {
  await api.procedures.getOrCreate({ id: 'sede', title: 'Abrir la sede', status: 'researching' });
  const page = await api.browser.currentPage();
  await page.goto('${url}');
  await page.close();
  return { closed: true };
}
`,
            }),
          ],
        },
      },
    ],
  });
  await invoke(h.page, 'chat.send', { text: 'Abre la sede de prueba' });
  await procedureTitled(h, 'Abrir la sede');
  await assistantSaid(h, 'La sede está abierta.');
  const agent = await theAgent(h);
  const log = await agentIdle(h, agent.id);
  expect(codemodeCalls(log).map((c) => c.status)).toEqual(['done', 'done']);
  // What the workflows returned, as the agent's model read it.
  const results = new Set(
    h.llm
      .requests()
      .flatMap(
        (r) => (r.body as { messages?: { role: string; content?: unknown }[] }).messages ?? [],
      )
      .filter((m) => m.role === 'tool')
      .map((m) =>
        typeof m.content === 'string'
          ? m.content
          : (m.content as { text?: string }[]).map((part) => part.text ?? '').join(''),
      )
      .filter((text) => text.startsWith('Workflow "')),
  );
  expect([...results]).toEqual([
    expect.stringContaining('Workflow "abrir-sede" succeeded'),
    expect.stringMatching(/Workflow "abrir-otra-vez" succeeded[\s\S]*"tabs": 2/),
  ]);

  // One headed launch with the CRLSet, which never went away.
  let lines: string[] = [];
  await expect
    .poll(async () => {
      lines = await browserLog(h.userData);
      return lines.some((line) => line.includes('browser enforces a CRLSet'));
    })
    .toBe(true);
  // In CI's log even when it passes: the launch, and any slow navigation or observation (debug).
  for (const line of lines) console.log(line);
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
  const report = JSON.parse(last) as {
    ok: boolean;
    checks: { name: string; ok: boolean; ms: number; detail?: string }[];
  };
  // In CI's log even when it passes: how long the first launch and page took on that runner.
  for (const c of report.checks) console.log(`self-test ${c.name}: ${c.ms} ms, ${c.detail}`);
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
