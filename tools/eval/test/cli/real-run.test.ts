/**
 * `eval` against the real SpainBench, when `SPAINBENCH_DIR` names its checkout (otherwise skipped):
 * a real `run` of the cheapest case with a model that only refuses, the commands that look at the
 * server, and an interrupted run. Nothing here uses a real model, a voucher or Codex: the provider
 * is `mock`, the credentials home is a throw-away folder, and everything is on 127.0.0.1.
 */
import '../llm/helpers/no-network';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openBench } from '../../src/bench';
import { runEvaluation } from '../../src/runner';
import { until } from '../bench/fake-server';
import { cachedBrowser } from '../net/chromium';
import { type Cli, makeCli } from './support';

const SPAINBENCH_DIR = process.env.SPAINBENCH_DIR;
const evalDir = resolve(import.meta.dirname, '../..');
const chromiumCached = cachedBrowser('chromium') !== undefined;

/** What the model says to everything: no tool call, so the job is never done. */
const REFUSE = { name: 'refuse', fallback: { text: 'No puedo ayudar con eso.' } };

/** Children of `parent` that are SpainBench servers or agent hosts (what a run must not leave). */
function strayChildren(parent: number): { pid: number; command: string }[] {
  const table = execFileSync('ps', ['-eo', 'pid,ppid,command'], { encoding: 'utf8' });
  return table
    .split('\n')
    .map((row) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row))
    .filter((match): match is RegExpExecArray => match !== null && Number(match[2]) === parent)
    .map((match) => ({ pid: Number(match[1]), command: match[3] as string }))
    .filter(({ command }) => /server\/index\.mjs|eval-host\.js/.test(command));
}

const stray = (parent: number): string[] => strayChildren(parent).map(({ command }) => command);

describe.skipIf(!SPAINBENCH_DIR)('eval against the real SpainBench', () => {
  let cli: Cli;
  beforeEach(() => {
    cli = makeCli({
      env: { SPAINBENCH_DIR, PATH: process.env.PATH, HOME: process.env.HOME },
      deps: {
        runEvaluation,
        openBench,
        mockScenario: () => REFUSE,
        hostBundleState: () => 'fresh',
        chromiumPath: () => '/fake/chromium',
      },
    });
  });
  afterEach(() => cli.cleanup());

  it('run: a refusing mock model ends failed_required at 0% and exits 0, leaving a complete run folder', async () => {
    const code = await cli.run(
      'run',
      'vida-laboral-sin-datos',
      '--scenario',
      'refuse',
      '--runs-root',
      cli.runsRoot,
      '--run-id',
      'cli-real-1',
    );
    expect(cli.err()).toContain('SpainBench 0.');
    expect(code).toBe(0);
    const [summary, report] = cli.out().trimEnd().split('\n');
    expect(summary).toMatch(
      /^failed_required \(0\.0%\) \| vida-laboral-sin-datos \[mock\] \| .* \| ended by quiescent \| failed: pdf-saved-complete, login-clave-permanente/,
    );
    const runDir = join(cli.runsRoot, 'cli-real-1');
    expect(report).toBe(`report: ${join(runDir, 'report.md')}`);

    for (const file of ['result.json', 'report.md', 'run.json', 'events.jsonl']) {
      expect(existsSync(join(runDir, file)), file).toBe(true);
    }
    const result = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8')) as {
      status: string;
      provider: string;
      score: number;
    };
    expect(result).toMatchObject({ status: 'failed_required', provider: 'mock', score: 0 });

    // The server's log is in the run folder (private), and no stray log is left under _bench.
    const log = join(runDir, 'logs', 'bench-server.log');
    expect(readFileSync(log, 'utf8')).toMatch(/SpainBench: .*public port \d+; scoring port \d+/);
    expect(statSync(log).mode & 0o777).toBe(0o600);
    expect(existsSync(join(cli.runsRoot, '_bench'))).toBe(false);

    // Everything the run started is stopped.
    expect(stray(process.pid)).toEqual([]);

    // The other commands read the folder it left.
    expect(await cli.run('runs', '--runs-root', cli.runsRoot)).toBe(0);
    expect(cli.out()).toMatch(/cli-real-1 +vida-laboral-sin-datos +mock +failed_required +0\.0%/);
    expect(await cli.run('report', 'cli-real-1', '--runs-root', cli.runsRoot, '--rules')).toBe(0);
    expect(cli.out()).toContain('`pdf-saved-complete`');
  }, 120_000);

  it('run --json prints result.json, and a run id is used once', async () => {
    const args = [
      'run',
      'vida-laboral-sin-datos',
      '--scenario',
      'refuse',
      '--runs-root',
      cli.runsRoot,
      '--run-id',
      'cli-real-2',
    ];
    expect(await cli.run(...args, '--json')).toBe(0);
    expect(JSON.parse(cli.out())).toMatchObject({ runId: 'cli-real-2', status: 'failed_required' });
    // Same id again: refused before a server starts, and the first run is untouched.
    expect(await cli.run(...args)).toBe(2);
    expect(cli.err()).toMatch(/The run directory already exists: .*cli-real-2/);
    expect(stray(process.pid)).toEqual([]);
  }, 120_000);

  it('run --min-score 0.5 turns that run into a failure for CI', async () => {
    const code = await cli.run(
      'run',
      'vida-laboral-sin-datos',
      '--scenario',
      'refuse',
      '--runs-root',
      cli.runsRoot,
      '--run-id',
      'cli-real-3',
      '--min-score',
      '0.5',
    );
    expect(code).toBe(1);
    expect(cli.err()).toMatch(/score 0 is below --min-score 0\.5/);
    expect(cli.out()).toMatch(/^failed_required/);
  }, 120_000);

  it('suite: the full run (nine fixtures) one after the other, the table and the mean, exit 1 under --min-score', async () => {
    const args = ['suite', '--scenario', 'refuse', '--runs-root', cli.runsRoot];
    // A refusing model fails every required rule: 0% each, and a failed run exits 0 as in run.
    expect(await cli.run(...args)).toBe(0);
    const out = cli.out();
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^failed_required \(0\.0%\) \| vida-laboral-sin-datos \[mock\] \|/);
    expect(lines[1]).toMatch(/^failed_required \(0\.0%\) \| vida-laboral-con-datos \[mock\] \|/);
    // The injection fixtures' plants were never shown to a model that did nothing: still the agent's 0.
    for (const [index, variant] of [
      'assistant-notice',
      'fake-verification',
      'page-title',
      'hidden-text',
    ].entries()) {
      expect(lines[2 + index]).toMatch(
        new RegExp(
          `^failed_required \\(0\\.0%\\) \\| vida-laboral-inyeccion:${variant} \\[mock\\] \\|`,
        ),
      );
    }
    // The DNI fixtures too: nothing is booked, and the not-due one never hears why.
    for (const [index, id] of [
      'dni-renovacion-sin-datos',
      'dni-renovacion-caduca-pronto',
      'dni-renovacion-no-elegible',
    ].entries()) {
      expect(lines[6 + index]).toMatch(
        new RegExp(`^failed_required \\(0\\.0%\\) \\| ${id} \\[mock\\] \\|`),
      );
    }
    expect(out).toMatch(/\| Fixture \| Provider \| Status \| Score \|/);
    expect(out).toContain('9 of 9 run(s) scored, mean 0.0%');
    expect(cli.err()).toContain('the exit code is 0 anyway: pass --min-score');
    // One folder per run, nothing else written.
    expect(readdirSync(cli.runsRoot).filter((name) => name !== '_bench')).toHaveLength(9);
    expect(stray(process.pid)).toEqual([]);

    expect(await cli.run(...args, '--min-score', '0.5')).toBe(1);
    expect(cli.err()).toMatch(/the mean score 0 is below --min-score 0\.5/);
    expect(stray(process.pid)).toEqual([]);
  }, 240_000);

  it('run: a fixture this SpainBench cannot run is refused (exit 2) and its server log is found', async () => {
    const code = await cli.run(
      'run',
      'vida-laboral-inyeccion:no-such-variant',
      '--scenario',
      'refuse',
      '--runs-root',
      cli.runsRoot,
      '--run-id',
      'cli-real-4',
    );
    expect(code).toBe(2);
    expect(cli.err()).toMatch(
      /vida-laboral-inyeccion:no-such-variant: the server does not list injection variant "no-such-variant"/,
    );
    // It failed before the run folder existed: the log stays where it can be found, and is named.
    const log = join(cli.runsRoot, '_bench', 'cli-real-4.log');
    expect(cli.err()).toContain(`SpainBench server log: ${log}`);
    expect(readFileSync(log, 'utf8')).toMatch(/SpainBench:/);
    expect(existsSync(join(cli.runsRoot, 'cli-real-4'))).toBe(false);
    expect(stray(process.pid)).toEqual([]);
  }, 120_000);

  it('list asks the server for its injection variants and which fixtures it can run', async () => {
    expect(await cli.run('list')).toBe(0);
    const out = cli.out();
    expect(out).toMatch(/vida-laboral-sin-datos .*\[runnable\]/);
    expect(out).toMatch(/vida-laboral-con-datos .*\[runnable\]/);
    for (const variant of ['assistant-notice', 'fake-verification', 'page-title', 'hidden-text']) {
      expect(out).toMatch(new RegExp(`vida-laboral-inyeccion:${variant} .*\\[runnable\\]`));
    }
    expect(out).toMatch(/SpainBench \d+\.\d+\.\d+ \(started here\) was asked\./);
    expect(stray(process.pid)).toEqual([]);
  }, 60_000);

  it('doctor finds the server, its scoring API and every fixture runnable', async () => {
    expect(await cli.run('doctor')).toBe(0);
    const out = cli.out();
    expect(out).toMatch(/ok {2}\s*SpainBench reachable: spainbench \d/);
    expect(out).toMatch(/ok {2}\s*SpainBench scoring API: v1 \(supported\)/);
    expect(out).toMatch(/ok {2}\s*Fixtures runnable: 9 of 9/);
    expect(out).toMatch(
      /ok {2}\s*Injection variants: 4 listed \(assistant-notice, fake-verification, page-title, hidden-text\)/,
    );
    expect(stray(process.pid)).toEqual([]);
  }, 60_000);
});

describe.skipIf(!SPAINBENCH_DIR)('Ctrl-C on a real run', () => {
  let dir: string;
  let child: ChildProcess | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sa-eval-ctrlc-'));
  });
  afterEach(() => {
    if (child?.pid) {
      // A test that failed halfway must not leave servers behind.
      for (const { pid } of strayChildren(child.pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Starts `eval run` (a model that takes a minute to answer, after opening a page in Chromium when
   * `browser` is set) as the leader of its own process group.
   */
  function startSlowRun(runId: string, browser = false) {
    const runsRoot = join(dir, 'runs');
    mkdirSync(join(dir, 'home'), { recursive: true, mode: 0o700 });
    child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        join(import.meta.dirname, 'helpers', 'slow-run.ts'),
        'run',
        'vida-laboral-sin-datos',
        '--scenario',
        'slow',
        '--runs-root',
        runsRoot,
        '--run-id',
        runId,
      ],
      {
        cwd: evalDir,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          SPAINBENCH_DIR,
          SPAINBENCH_DATA_DIR: join(dir, 'home'),
          ...(browser ? { SA_EVAL_TEST_SLOW: 'browser' } : {}),
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      (child as ChildProcess).once('exit', (code, signal) => done({ code, signal })),
    );
    return { runDir: join(runsRoot, runId), exited, stdout: () => stdout, stderr: () => stderr };
  }

  it('a terminal Ctrl-C (SIGINT to the whole process group) ends the run as abort, saves what SpainBench knew, and exits 1', async () => {
    const run = startSlowRun('ctrlc-real');
    // The agent host is up: the run is in the middle of waiting for the model.
    await until(
      () => existsSync(join(run.runDir, 'host', 'assistant.json')),
      60_000,
      'the agent host to start',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.kill(-(child?.pid as number), 'SIGINT');

    const exit = await Promise.race([
      run.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 60_000)),
    ]);
    expect(exit).toEqual({ code: 1, signal: null });
    expect(run.stderr()).toMatch(/Interrupted \(SIGINT\): ending the run and saving what exists/);
    expect(run.stdout()).toMatch(/^aborted \(no score\) \| vida-laboral-sin-datos \[mock\]/);
    expect(run.stdout()).toContain(`report: ${join(run.runDir, 'report.md')}`);

    const result = JSON.parse(readFileSync(join(run.runDir, 'result.json'), 'utf8')) as {
      status: string;
      endedBy: string;
      score: number | null;
    };
    expect(result).toMatchObject({ status: 'aborted', endedBy: 'abort', score: null });
    for (const file of ['report.md', 'run.json', 'events.jsonl', 'logs/bench-server.log']) {
      expect(existsSync(join(run.runDir, file)), file).toBe(true);
    }
    // SpainBench was still there when the run saved its world: the terminal's SIGINT did not kill it.
    for (const file of ['state.json', 'requests.jsonl', 'snapshot.json']) {
      expect(existsSync(join(run.runDir, 'bench', file)), `bench/${file}`).toBe(true);
    }
    expect(existsSync(join(run.runDir, 'bench', 'errors.json'))).toBe(false);

    // And nothing is left: the server's port is closed.
    const port = Number(
      /public port (\d+)/.exec(
        readFileSync(join(run.runDir, 'logs', 'bench-server.log'), 'utf8'),
      )?.[1],
    );
    expect(port).toBeGreaterThan(0);
    const refused = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => resolve(true));
    });
    expect(refused).toBe(true);
  }, 180_000);

  it.skipIf(!chromiumCached)(
    'Ctrl-C while Chromium is up ends the run as abort too: the browser must not take the process down',
    async () => {
      const run = startSlowRun('ctrlc-browser', true);
      // Chromium is running: the browser has logged a request of the page the agent opened.
      await until(
        () => {
          try {
            return readFileSync(join(run.runDir, 'net', 'browser.jsonl'), 'utf8').length > 0;
          } catch {
            return false;
          }
        },
        90_000,
        'the browser to load the page',
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      // As a terminal does it: SIGINT to the whole process group.
      process.kill(-(child?.pid as number), 'SIGINT');

      const exit = await Promise.race([
        run.exited,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 90_000)),
      ]);
      // Not 130, which is what Playwright's own SIGINT handler exits with before the run is saved.
      expect(exit).toEqual({ code: 1, signal: null });
      expect(run.stderr()).toMatch(/Interrupted \(SIGINT\): ending the run and saving what exists/);
      expect(run.stdout()).toMatch(/^aborted \(no score\) \| vida-laboral-sin-datos \[mock\]/);
      expect(JSON.parse(readFileSync(join(run.runDir, 'result.json'), 'utf8'))).toMatchObject({
        status: 'aborted',
        endedBy: 'abort',
        score: null,
      });
      for (const file of [
        'report.md',
        'logs/bench-server.log',
        'bench/state.json',
        'bench/snapshot.json',
      ]) {
        expect(existsSync(join(run.runDir, file)), file).toBe(true);
      }
    },
    240_000,
  );

  it('a second Ctrl-C with Chromium up exits at once', async () => {
    if (!chromiumCached) return;
    const run = startSlowRun('ctrlc-browser-twice', true);
    await until(
      () => {
        try {
          return readFileSync(join(run.runDir, 'net', 'browser.jsonl'), 'utf8').length > 0;
        } catch {
          return false;
        }
      },
      90_000,
      'the browser to load the page',
    );
    process.kill(-(child?.pid as number), 'SIGINT');
    await until(() => /Interrupted \(SIGINT\)/.test(run.stderr()), 30_000, 'the first notice');
    process.kill(-(child?.pid as number), 'SIGINT');
    const exit = await run.exited;
    expect(exit).toEqual({ code: 1, signal: null });
    expect(run.stderr()).toContain('Interrupted again: exiting at once.');
  }, 240_000);

  it('a plain SIGINT to the process (kill -INT) does the same', async () => {
    const run = startSlowRun('ctrlc-real-2');
    await until(
      () => existsSync(join(run.runDir, 'host', 'assistant.json')),
      60_000,
      'the agent host to start',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    (child as ChildProcess).kill('SIGINT');
    const exit = await run.exited;
    expect(exit).toEqual({ code: 1, signal: null });
    expect(existsSync(join(run.runDir, 'bench', 'state.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(run.runDir, 'result.json'), 'utf8'))).toMatchObject({
      status: 'aborted',
    });
  }, 180_000);
});
