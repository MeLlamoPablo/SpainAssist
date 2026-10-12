import { describe, expect, it } from 'vitest';
import {
  createSafeStorageKeyProvider,
  createTestKeyProvider,
  type SafeStorageLike,
  Vault,
  VaultError,
} from '../src/index';
import { tempVaultDir } from './helpers/tmp';

/** Mimics Electron's safeStorage (string in, opaque Buffer out). */
function fakeSafeStorage(backend = 'gnome_libsecret', available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(`v10${Buffer.from(text).toString('hex')}`),
    decryptString: (data) => Buffer.from(data.toString().slice(3), 'hex').toString(),
    getSelectedStorageBackend: () => backend,
  };
}

describe('createTestKeyProvider', () => {
  it('is stable for a seed and random without one', async () => {
    const key = Buffer.alloc(32, 1);
    const a = createTestKeyProvider('seed');
    expect(await createTestKeyProvider('seed').decrypt(await a.encrypt(key))).toEqual(key);
    await expect(createTestKeyProvider('other').decrypt(await a.encrypt(key))).rejects.toThrow();
    const random = createTestKeyProvider();
    expect(await random.decrypt(await random.encrypt(key))).toEqual(key);
    await expect(createTestKeyProvider().decrypt(await random.encrypt(key))).rejects.toThrow();
    expect(a).toMatchObject({ backend: 'test', secure: false });
  });
});

describe('createSafeStorageKeyProvider', () => {
  it('describes the OS backend', () => {
    const describe = (platform: NodeJS.Platform, backend?: string) => {
      const p = createSafeStorageKeyProvider(fakeSafeStorage(backend), platform);
      return { backend: p.backend, secure: p.secure };
    };
    expect(describe('darwin')).toEqual({ backend: 'macOS Keychain', secure: true });
    expect(describe('win32')).toEqual({ backend: 'Windows DPAPI', secure: true });
    expect(describe('linux', 'gnome_libsecret')).toEqual({ backend: 'libsecret', secure: true });
    expect(describe('linux', 'kwallet6')).toEqual({ backend: 'KWallet', secure: true });
    expect(describe('linux', 'basic_text')).toEqual({ backend: 'basic_text', secure: false });
  });

  it('backs a vault', async () => {
    const dir = await tempVaultDir();
    const vault = await Vault.open(dir, createSafeStorageKeyProvider(fakeSafeStorage(), 'linux'));
    await vault.setSecret('a', 'A', 'value');
    const reopened = await Vault.open(
      dir,
      createSafeStorageKeyProvider(fakeSafeStorage(), 'linux'),
    );
    expect(await reopened.getSecret('a')).toBe('value');
    expect(reopened.storageInfo()).toEqual({ backend: 'libsecret', secure: true });
  });

  it('reports unavailable OS encryption', async () => {
    const provider = createSafeStorageKeyProvider(fakeSafeStorage('basic_text', false), 'linux');
    const error = await Vault.open(await tempVaultDir(), provider).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe('key_unavailable');
  });
});
