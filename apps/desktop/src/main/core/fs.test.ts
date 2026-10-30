import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic, writeNewFile } from './fs';

// On Windows, antivirus, the search indexer and backup tools hold new files for a moment, and a
// rename or delete of them fails meanwhile. A hold makes the next `times` calls of `call` on a
// path that ends with `target` fail with `code`, and counts the attempts.
interface Hold {
  call: 'rename' | 'rm';
  target: string;
  times: number;
  code: string;
  attempts: number;
}
const holds = vi.hoisted(() => [] as Hold[]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const check = (call: Hold['call'], path: unknown) => {
    const hold = holds.find((h) => h.call === call && String(path).endsWith(h.target));
    if (!hold) return;
    hold.attempts++;
    if (hold.times <= 0) return;
    hold.times--;
    throw Object.assign(new Error(`${hold.code}: ${call}`), { code: hold.code });
  };
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      check('rename', to);
      return actual.rename(from, to);
    },
    rm: async (path: string, options?: Parameters<typeof actual.rm>[1]) => {
      check('rm', path);
      return actual.rm(path, options);
    },
  };
});

function hold(call: Hold['call'], target: string, times: number, code = 'EPERM'): Hold {
  const h = { call, target, times, code, attempts: 0 };
  holds.push(h);
  return h;
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
function runningOn(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { ...platform, value });
}

let dir: string | undefined;
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  vi.useRealTimers();
  holds.length = 0;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Settles `promise` while its retries wait on fake timers, letting real file I/O run between. */
async function settleWithFakeTimers<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  let result: PromiseSettledResult<T> | undefined;
  promise.then(
    (value) => {
      result = { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      result = { status: 'rejected', reason };
    },
  );
  while (!result) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersToNextTimerAsync();
  }
  return result;
}

describe('writeFileAtomic on Windows', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])('waits while the file is locked (%s)', async (code) => {
    dir = await mkdtemp(join(tmpdir(), 'sa-fs-'));
    const file = join(dir, 'settings.json');
    await writeFileAtomic(file, '{"v":1}');
    runningOn('win32');
    const held = hold('rename', 'settings.json', 2, code);
    await writeFileAtomic(file, '{"v":2}');
    expect(held.attempts).toBe(3);
    expect(await readFile(file, 'utf8')).toBe('{"v":2}');
    expect(await readdir(dir)).toEqual(['settings.json']);
  });

  it('gives up on a lock that outlasts the retries, keeps the old file and no temp file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sa-fs-'));
    const file = join(dir, 'transcript.json');
    await writeFileAtomic(file, '[]');
    runningOn('win32');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const held = hold('rename', 'transcript.json', Number.POSITIVE_INFINITY);
    const result = await settleWithFakeTimers(writeFileAtomic(file, '[1]'));
    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'EPERM' } });
    expect(held.attempts).toBe(9);
    expect(await readFile(file, 'utf8')).toBe('[]');
    expect(await readdir(dir)).toEqual(['transcript.json']);
  });

  it('removes its temp file after a failure even while that one is locked', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sa-fs-'));
    runningOn('win32');
    hold('rename', 'procedure.json', 1, 'EXDEV');
    const cleanup = hold('rm', '.tmp', 2, 'EBUSY');
    await expect(writeFileAtomic(join(dir, 'procedure.json'), '{}')).rejects.toMatchObject({
      code: 'EXDEV',
    });
    expect(cleanup.attempts).toBe(3);
    expect(await readdir(dir)).toEqual([]);
  });

  it.each([
    ['another error on Windows', 'win32', 'EXDEV'],
    ['a lock on macOS', 'darwin', 'EPERM'],
    ['a lock on Linux', 'linux', 'EBUSY'],
  ] as const)('fails at once on %s', async (_, os, code) => {
    dir = await mkdtemp(join(tmpdir(), 'sa-fs-'));
    runningOn(os);
    const held = hold('rename', 'settings.json', 1, code);
    await expect(writeFileAtomic(join(dir, 'settings.json'), '{}')).rejects.toMatchObject({ code });
    expect(held.attempts).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('writeNewFile on Windows', () => {
  it('removes an incomplete file even while it is locked', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sa-fs-'));
    runningOn('win32');
    const held = hold('rm', 'Informe.pdf', 2, 'EBUSY');
    await expect(
      writeNewFile(dir, 'Informe.pdf', async () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
    expect(held.attempts).toBe(3);
    expect(await readdir(dir)).toEqual([]);
  });
});
