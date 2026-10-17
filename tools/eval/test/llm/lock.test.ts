import './helpers/no-network';
import { type ChildProcess, fork, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockTimeoutError, withFileLock } from '../../src/llm/lock';
import type { RoundReport } from './helpers/lock-child';
import { makeHome, type TestHome } from './helpers/tmp-home';

const here = dirname(fileURLToPath(import.meta.url));
const evalDir = join(here, '..', '..');

describe('file lock', () => {
  let t: TestHome;
  let lock: string;
  beforeEach(() => {
    t = makeHome();
    lock = join(t.home, 'x.lock');
  });
  afterEach(() => t.cleanup());

  it('runs one critical section at a time, in order, and removes the lock', async () => {
    const trace: string[] = [];
    const task = (name: string, ms: number) =>
      withFileLock(lock, async () => {
        trace.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        trace.push(`end ${name}`);
        return name;
      });
    const results = await Promise.all([task('a', 30), task('b', 5), task('c', 5)]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(trace).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(existsSync(lock)).toBe(false);
  });

  it('releases the lock when the section throws', async () => {
    await expect(
      withFileLock(lock, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(lock)).toBe(false);
    expect(await withFileLock(lock, () => 'again')).toBe('again');
  });

  it('writes its owner while held', async () => {
    await withFileLock(lock, () => {
      const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
      expect(owner.pid).toBe(process.pid);
    });
  });

  it('claims a lock whose owner process is gone', async () => {
    mkdirSync(lock);
    writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ id: 'dead', pid: 2 ** 22 + 12345, startedAt: Date.now() }),
    );
    expect(await withFileLock(lock, () => 'claimed', { timeoutMs: 2000 })).toBe('claimed');
  });

  it('claims a lock that is older than staleMs even if its pid looks alive', async () => {
    mkdirSync(lock);
    writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ id: 'old', pid: process.pid, startedAt: Date.now() - 120_000 }),
    );
    expect(await withFileLock(lock, () => 'claimed', { staleMs: 60_000, timeoutMs: 2000 })).toBe(
      'claimed',
    );
  });

  it('treats an empty lock directory as free and an unreadable owner as held until it is stale', async () => {
    mkdirSync(lock);
    expect(await withFileLock(lock, () => 'free', { timeoutMs: 2000 })).toBe('free');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), '{ half a file');
    await expect(
      withFileLock(lock, () => 'x', { timeoutMs: 150, pollMs: 10 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(lock, 'owner.json'), old, old);
    expect(await withFileLock(lock, () => 'claimed', { timeoutMs: 2000 })).toBe('claimed');
  });

  it('times out while another live owner holds it, and leaves that lock alone', async () => {
    mkdirSync(lock);
    writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ id: 'live', pid: process.pid, startedAt: Date.now() }),
    );
    await expect(
      withFileLock(lock, () => 'x', { timeoutMs: 120, pollMs: 10 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).id).toBe('live');
  });

  it('does not remove a lock that was claimed by someone else meanwhile', async () => {
    await withFileLock(lock, () => {
      writeFileSync(
        join(lock, 'owner.json'),
        JSON.stringify({ id: 'other', pid: process.pid, startedAt: Date.now() }),
      );
    });
    expect(existsSync(lock)).toBe(true);
    expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).id).toBe('other');
  });
});

/** The parent side of `helpers/lock-child.ts`: contenders that are separate processes. */
class Contenders {
  private readonly children: ChildProcess[] = [];

  static async start(count: number): Promise<Contenders> {
    const group = new Contenders();
    await Promise.all(
      Array.from({ length: count }, () => {
        const child = fork(join(here, 'helpers', 'lock-child.ts'), [], {
          cwd: evalDir,
          execArgv: ['--import', 'tsx'],
          silent: true,
        });
        group.children.push(child);
        return new Promise<void>((resolve, reject) => {
          child.once('message', () => resolve());
          child.once('error', reject);
          child.once('exit', (code) => reject(new Error(`a contender exited early (${code})`)));
        });
      }),
    );
    return group;
  }

  /** Every contender takes `lockDir` at `startAt`; resolves with what each one saw. */
  async round(lockDir: string, probeDir: string, options: object): Promise<RoundReport[]> {
    const startAt = Date.now() + 60;
    return await Promise.all(
      this.children.map(
        (child) =>
          new Promise<RoundReport>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('a contender never finished')), 20_000);
            child.once('message', (message: RoundReport) => {
              clearTimeout(timer);
              resolve(message);
            });
            child.send({ type: 'round', lockDir, probeDir, startAt, options });
          }),
      ),
    );
  }

  stop(): void {
    for (const child of this.children) child.kill('SIGKILL');
  }
}

/** The pid of a process that has already exited: an owner that is really gone. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '']);
  return result.pid;
}

describe('file lock across processes, with locks left behind', () => {
  let t: TestHome;
  let contenders: Contenders | undefined;
  beforeEach(() => {
    t = makeHome();
  });
  afterEach(() => {
    contenders?.stop();
    contenders = undefined;
    t.cleanup();
  });

  /** Plants the kinds of lock a crashed holder leaves: dead pid, old timestamp, garbage. */
  function plantStale(lockDir: string, kind: number): void {
    mkdirSync(lockDir, { recursive: true });
    const owner = join(lockDir, 'owner.json');
    if (kind % 3 === 0) {
      writeFileSync(owner, JSON.stringify({ id: 'dead', pid: deadPid(), startedAt: Date.now() }));
    } else if (kind % 3 === 1) {
      // The pid looks alive (it was reused, say), only the age gives the lock away.
      writeFileSync(
        owner,
        JSON.stringify({ id: 'old', pid: process.pid, startedAt: Date.now() - 120_000 }),
      );
    } else {
      writeFileSync(owner, '{ torn');
      const old = new Date(Date.now() - 120_000);
      utimesSync(owner, old, old);
    }
  }

  it('lets exactly one of many processes take over a stale lock, round after round', async () => {
    contenders = await Contenders.start(6);
    const rounds = 40;
    const totals = { entries: 0, overlaps: 0, errors: [] as string[] };
    for (let n = 0; n < rounds; n++) {
      const lockDir = join(t.home, `lock-${n}`);
      plantStale(lockDir, n);
      for (const report of await contenders.round(lockDir, join(t.home, `probe-${n}`), {
        pollMs: 4,
        timeoutMs: 15_000,
        staleMs: 60_000,
      })) {
        totals.entries += report.entries;
        totals.overlaps += report.overlaps;
        totals.errors.push(...report.errors);
      }
    }
    expect(totals.errors).toEqual([]);
    expect(totals.overlaps).toBe(0);
    expect(totals.entries).toBe(6 * rounds);
    // Every lock was released and no break claim or temp file was left in the home.
    expect(
      readdirSync(t.home).filter((name) => name.startsWith('lock-') && !/^lock-\d+$/.test(name)),
    ).toEqual([]);
  }, 60_000);

  it('takes over the lock of a holder that was SIGKILLed while holding it', async () => {
    const lockDir = join(t.home, 'killed.lock');
    const holder = fork(join(here, 'helpers', 'lock-child.ts'), [], {
      cwd: evalDir,
      execArgv: ['--import', 'tsx'],
      silent: true,
    });
    await new Promise<void>((resolve) => holder.once('message', () => resolve()));
    const held = new Promise<void>((resolve) => holder.once('message', () => resolve()));
    holder.send({ type: 'hold', lockDir });
    await held;
    expect(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).pid).toBe(holder.pid);
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));

    contenders = await Contenders.start(4);
    const reports = await contenders.round(lockDir, join(t.home, 'probe'), {
      pollMs: 4,
      timeoutMs: 15_000,
    });
    expect(reports.flatMap((report) => report.errors)).toEqual([]);
    expect(reports.reduce((sum, report) => sum + report.overlaps, 0)).toBe(0);
    expect(reports.reduce((sum, report) => sum + report.entries, 0)).toBe(4);
  }, 60_000);

  it('does not wait for ever behind the claim of a contender that died while breaking a lock', async () => {
    const lockDir = join(t.home, 'x.lock');
    plantStale(lockDir, 0);
    // A contender that judged owner "dead" stale, took the claim and was killed before it finished.
    const claim = `${lockDir}.break-dead`;
    mkdirSync(claim);
    await expect(
      withFileLock(lockDir, () => 'x', { timeoutMs: 150, pollMs: 10 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    const old = new Date(Date.now() - 120_000);
    utimesSync(claim, old, old);
    expect(await withFileLock(lockDir, () => 'claimed', { timeoutMs: 5000, pollMs: 10 })).toBe(
      'claimed',
    );
    expect(existsSync(claim)).toBe(false);
  });

  it('keeps the section error when the lock cannot be released, and never throws from the release', async () => {
    const lockDir = join(t.home, 'locked.lock');
    try {
      await expect(
        withFileLock(lockDir, () => {
          chmodSync(lockDir, 0o500); // the owner file can no longer be removed
          throw new Error('the real error');
        }),
      ).rejects.toThrow('the real error');
      // The result of a section that worked is not lost either.
      expect(
        await withFileLock(join(t.home, 'other.lock'), () => {
          chmodSync(join(t.home, 'other.lock'), 0o500);
          return 'result';
        }),
      ).toBe('result');
    } finally {
      for (const name of ['locked.lock', 'other.lock']) {
        if (existsSync(join(t.home, name))) chmodSync(join(t.home, name), 0o700);
      }
    }
  });
});
