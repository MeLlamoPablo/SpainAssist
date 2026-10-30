import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestKeyProvider, retryWhileLocked, Vault, VaultError } from '../src/index';
import { tempVaultDir } from './helpers/tmp';

// On Windows, antivirus, the search indexer and backup tools hold new files for a moment, and a
// rename or delete of them fails meanwhile. This makes the next `times` renames or unlinks of a
// file whose path ends with `target` fail with `code`, and counts the attempts.
const lock = vi.hoisted(() => ({
  call: 'rename' as 'rename' | 'unlink',
  target: '',
  times: 0,
  code: 'EPERM',
  attempts: 0,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const check = (call: 'rename' | 'unlink', path: unknown) => {
    if (!lock.target || lock.call !== call || !String(path).endsWith(lock.target)) return;
    lock.attempts++;
    if (lock.times <= 0) return;
    lock.times--;
    throw Object.assign(new Error(`${lock.code}: operation not permitted, ${call}`), {
      code: lock.code,
    });
  };
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      check('rename', to);
      return actual.rename(from, to);
    },
    unlink: async (path: string) => {
      check('unlink', path);
      return actual.unlink(path);
    },
  };
});

function holdFile(call: 'rename' | 'unlink', target: string, times: number, code = 'EPERM') {
  Object.assign(lock, { call, target, times, code, attempts: 0 });
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
function runningOn(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { ...platform, value });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.useRealTimers();
  holdFile('rename', '', 0);
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

const keys = () => createTestKeyProvider('windows-locks');

async function tempFiles(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir)).filter((name) => name.includes('.tmp-'));
}

describe('retryWhileLocked', () => {
  const failing = (times: number, code: string) => {
    let calls = 0;
    const operation = async () => {
      calls++;
      if (calls <= times) throw Object.assign(new Error(code), { code });
      return 'done';
    };
    return { operation, calls: () => calls };
  };

  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'retries %s on Windows until the file is free',
    async (code) => {
      runningOn('win32');
      const op = failing(3, code);
      await expect(retryWhileLocked(op.operation)).resolves.toBe('done');
      expect(op.calls()).toBe(4);
    },
  );

  it.each([
    ['other errors on Windows', 'win32', 'EIO'],
    ['other errors on Windows', 'win32', 'ENOENT'],
    ['other errors on Windows', 'win32', 'EXDEV'],
    ['locks off Windows', 'darwin', 'EPERM'],
    ['locks off Windows', 'linux', 'EBUSY'],
  ] as const)('never retries %s (%s, %s)', async (_, os, code) => {
    runningOn(os);
    const op = failing(1, code);
    await expect(retryWhileLocked(op.operation)).rejects.toMatchObject({ code });
    expect(op.calls()).toBe(1);
  });

  it('gives up on a lock that lasts over 3 seconds, with its error', async () => {
    runningOn('win32');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const start = Date.now();
    const op = failing(Number.POSITIVE_INFINITY, 'EBUSY');
    const result = await settleWithFakeTimers(retryWhileLocked(op.operation));
    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'EBUSY' } });
    expect(op.calls()).toBe(9);
    expect(Date.now() - start).toBe(3260);
  });
});

describe('vault files on Windows', () => {
  it('a save waits for a file that antivirus holds for a moment', async () => {
    const dir = await tempVaultDir();
    const vault = await Vault.open(dir, keys());
    runningOn('win32');
    holdFile('rename', 'vault.bin', 3);
    await vault.setPersonal([{ key: 'givenName', value: 'José' }], 'manual');
    expect(lock.attempts).toBe(4);
    expect((await Vault.open(dir, keys())).getPersonal('givenName')?.value).toBe('José');
    expect(await tempFiles(dir)).toEqual([]);
  });

  it('a lock that outlasts the retries fails the save, keeps the last state and no temp file', async () => {
    const dir = await tempVaultDir();
    const vault = await Vault.open(dir, keys());
    await vault.setPersonal([{ key: 'givenName', value: 'Carmen' }], 'manual');
    runningOn('win32');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    holdFile('rename', 'vault.bin', Number.POSITIVE_INFINITY, 'EBUSY');
    const result = await settleWithFakeTimers(
      vault.setPersonal([{ key: 'givenName', value: 'Ana' }], 'manual'),
    );
    expect(result.status).toBe('rejected');
    const error = (result as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(VaultError);
    expect(error).toMatchObject({ code: 'io', message: expect.stringContaining('EBUSY') });
    expect(lock.attempts).toBe(9);
    expect(await tempFiles(dir)).toEqual([]);
    vi.useRealTimers();
    holdFile('rename', '', 0);
    expect(vault.getPersonal('givenName')?.value).toBe('Carmen');
    expect((await Vault.open(dir, keys())).getPersonal('givenName')?.value).toBe('Carmen');
  });

  it('deleting a document waits for its file', async () => {
    const dir = await tempVaultDir();
    const vault = await Vault.open(dir, keys());
    const doc = await vault.addDocument({
      name: 'Informe de vida laboral - 2026-10-12.pdf',
      mimeType: 'application/pdf',
      source: 'download',
      bytes: Buffer.from('%PDF-1.7'),
    });
    runningOn('win32');
    holdFile('unlink', `${doc.id}.bin`, 2, 'EBUSY');
    await vault.deleteDocument(doc.id);
    expect(lock.attempts).toBe(3);
    expect(await fsp.readdir(join(dir, 'documents'))).toEqual([]);
  });

  it('off Windows, a failed rename fails at once', async () => {
    const dir = await tempVaultDir();
    const vault = await Vault.open(dir, keys());
    runningOn('linux');
    holdFile('rename', 'vault.bin', 1);
    await expect(
      vault.setPersonal([{ key: 'givenName', value: 'Ana' }], 'manual'),
    ).rejects.toMatchObject({ code: 'io' });
    expect(lock.attempts).toBe(1);
    expect(await tempFiles(dir)).toEqual([]);
  });
});
