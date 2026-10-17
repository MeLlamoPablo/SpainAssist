/**
 * The `eval` entry as a process: `node --import tsx src/cli.ts <command>`, the way the package
 * script runs it. Offline: the environment has no SpainBench and a throw-away credentials home.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const evalDir = resolve(import.meta.dirname, '../..');
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sa-eval-proc-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: evalDir,
    encoding: 'utf8',
    timeout: 60_000,
    // No SPAINBENCH_*, no keys: the credentials home is a folder that does not exist yet.
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SPAINBENCH_DATA_DIR: join(home, 'creds'),
    },
  });
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('the eval entry', () => {
  it('--help prints the commands on stdout and exits 0', () => {
    const { code, stdout, stderr } = cli('--help');
    expect(code).toBe(0);
    expect(stdout).toContain('eval: the SpainBench eval suite');
    for (const command of [
      'list',
      'run',
      'report',
      'runs',
      'budget',
      'login',
      'whoami',
      'logout',
      'doctor',
    ]) {
      expect(stdout).toMatch(new RegExp(`\\n {2}${command} `));
    }
    expect(stdout).toContain('Exit codes:');
    expect(stderr).toBe('');
  });

  it('run --help prints the options and an example, exit 0', () => {
    const { code, stdout } = cli('run', '--help');
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: corepack pnpm eval run <fixture> [options]');
    expect(stdout).toContain('--min-score');
    expect(stdout).toContain('Examples:');
  });

  it('list prints the fixtures, says SpainBench was not asked, and exits 0', () => {
    const { code, stdout, stderr } = cli('list');
    expect(code).toBe(0);
    for (const id of [
      'vida-laboral-sin-datos',
      'vida-laboral-con-datos',
      'vida-laboral-inyeccion',
    ]) {
      expect(stdout).toContain(id);
    }
    expect(stdout).toContain('SpainBench was not asked');
    expect(stderr).toBe('');
  });

  it('an unknown command is a usage error: exit 2, stdout empty', () => {
    const { code, stdout, stderr } = cli('frobnicate');
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/error: Unknown command "frobnicate"/);
  });

  it('a run that cannot start exits 2 and says what to fix: no key, nobody contacted', () => {
    const { code, stdout, stderr } = cli('run', 'vida-laboral-sin-datos');
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/error: No voucher key: .*litellm\.json does not exist/);
  });

  it('the mock provider without a scenario is a usage error: exit 2', () => {
    const { code, stderr } = cli('run', 'vida-laboral-sin-datos', '--provider', 'mock');
    expect(code).toBe(2);
    expect(stderr).toMatch(/--provider mock needs --scenario/);
  });

  it('an unknown fixture exits 2 and lists the known ones', () => {
    const { code, stderr } = cli('run', 'nope', '--scenario', 'oracle');
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unknown fixture "nope"\. Known: vida-laboral-sin-datos/);
  });

  it('report of something that is not a run exits 2', () => {
    mkdirSync(join(home, 'not-a-run'));
    const { code, stderr } = cli('report', join(home, 'not-a-run'));
    expect(code).toBe(2);
    expect(stderr).toMatch(/is not a run folder/);
  });

  it('runs on an empty runs root says so and exits 0', () => {
    const { code, stdout } = cli('runs', '--runs-root', join(home, 'runs'));
    expect(code).toBe(0);
    expect(stdout).toMatch(/^No runs in /);
  });

  it('whoami only reads the throw-away credentials home, and never prints a key', () => {
    const { code, stdout } = cli('whoami');
    expect(code).toBe(0);
    expect(stdout).toContain(`Credentials home: ${join(home, 'creds')}`);
    expect(stdout).toContain('Codex: not logged in');
    expect(stdout).toContain('Voucher key: none');
  });

  it('login codex without consent exits 2 after printing the terms', () => {
    const { code, stderr } = cli('login', 'codex');
    expect(code).toBe(2);
    expect(stderr).toContain('DEVELOPMENT ONLY');
    expect(stderr).toContain('--codex-consent');
  });

  it('is what the package script runs, with tsx declared by the package', () => {
    const manifest = JSON.parse(readFileSync(join(evalDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.scripts.eval).toBe('node --import tsx src/cli.ts');
    expect(manifest.devDependencies.tsx).toBeDefined();
    const root = JSON.parse(readFileSync(join(evalDir, '../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts.eval).toBe('corepack pnpm --filter @sa/eval eval');
  });
});
