import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestKeyProvider, Vault, VaultError } from '../src/index';
import { tempVaultDir } from './helpers/tmp';

// Lets a test make the next rename onto a given file fail, as if the process died right
// after writing the temp file and before replacing the target.
const crash = vi.hoisted(() => ({ target: undefined as string | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (crash.target && String(to).endsWith(crash.target)) {
        crash.target = undefined;
        throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
      }
      return actual.rename(from, to);
    },
  };
});

afterEach(() => {
  crash.target = undefined;
});

const keys = () => createTestKeyProvider('atomicity');

describe('atomic writes', () => {
  it('a write interrupted before the rename leaves the previous state readable', async () => {
    const dir = await tempVaultDir();
    const vault = await Vault.open(dir, keys());
    await vault.setPersonal([{ key: 'givenName', value: 'Carmen' }], 'manual');

    crash.target = 'vault.bin';
    const error = await vault
      .setPersonal([{ key: 'givenName', value: 'Ana' }], 'manual')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe('io');

    // Memory and disk both still hold the last committed state, and no temp file is left.
    expect(vault.getPersonal('givenName')?.value).toBe('Carmen');
    expect((await Vault.open(dir, keys())).getPersonal('givenName')?.value).toBe('Carmen');
    expect((await fsp.readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);

    // The vault keeps working afterwards.
    await vault.setPersonal([{ key: 'givenName', value: 'Ana' }], 'manual');
    expect((await Vault.open(dir, keys())).getPersonal('givenName')?.value).toBe('Ana');
  });

  it('a failed state commit does not leave the new document behind', async () => {
    const dir = await tempVaultDir();
    const vault = await Vault.open(dir, keys());
    crash.target = 'vault.bin';
    await expect(
      vault.addDocument({
        name: 'a.txt',
        mimeType: 'text/plain',
        kind: 'other',
        source: 'user',
        bytes: Buffer.from('a'),
      }),
    ).rejects.toMatchObject({ code: 'io' });
    expect(vault.listDocuments()).toEqual([]);
    expect(await fsp.readdir(join(dir, 'documents'))).toEqual([]);
  });

  it('cleans up leftovers of a crash (temp files, orphan documents) on open', async () => {
    const dir = await tempVaultDir();
    const vault = await Vault.open(dir, keys());
    await vault.setPersonal([{ key: 'givenName', value: 'Carmen' }], 'manual');
    const doc = await vault.addDocument({
      name: 'keep.txt',
      mimeType: 'text/plain',
      kind: 'other',
      source: 'user',
      bytes: Buffer.from('keep'),
    });
    // What a crash in the middle of writes can leave behind.
    await fsp.writeFile(join(dir, 'vault.bin.tmp-0123456789ab'), 'partial garbage');
    await fsp.writeFile(join(dir, 'documents', `${randomUUID()}.bin`), 'orphan document');
    await fsp.writeFile(join(dir, 'documents', `${doc.id}.bin.tmp-abcdef012345`), 'partial');

    const reopened = await Vault.open(dir, keys());
    expect(reopened.getPersonal('givenName')?.value).toBe('Carmen');
    expect((await reopened.readDocument(doc.id)).toString()).toBe('keep');
    expect(await fsp.readdir(join(dir, 'documents'))).toEqual([`${doc.id}.bin`]);
    expect((await fsp.readdir(dir)).sort()).toEqual(['documents', 'key.bin', 'vault.bin']);
  });

  it('recovers from a crash between creating key.bin and vault.bin', async () => {
    const dir = await tempVaultDir();
    crash.target = 'vault.bin';
    await expect(Vault.open(dir, keys())).rejects.toMatchObject({ code: 'io' });
    expect(await fsp.readdir(dir)).toContain('key.bin');
    const vault = await Vault.open(dir, keys());
    expect(vault.listPersonal()).toEqual([]);
  });
});
