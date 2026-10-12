import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { VaultError } from './errors';

/** Wraps and unwraps the vault's data key with OS-backed protection. */
export interface KeyProvider {
  /** Shown in the transparency screen, e.g. "macOS Keychain". */
  readonly backend: string;
  /** False if the OS gives no real protection (e.g. Linux "basic_text"). */
  readonly secure: boolean;
  encrypt(plain: Buffer): Promise<Buffer>;
  decrypt(wrapped: Buffer): Promise<Buffer>;
}

const TEST_MAGIC = Buffer.from('TKP1', 'ascii');

/**
 * Insecure key provider for tests and e2e runs: AES-256-GCM with a key derived from `seed`
 * (stable across runs) or a random key (only valid for this provider instance).
 */
export function createTestKeyProvider(seed?: string): KeyProvider {
  const key =
    seed === undefined
      ? randomBytes(32)
      : createHash('sha256').update(`sa-vault test key provider\0${seed}`).digest();
  return {
    backend: 'test',
    secure: false,
    async encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([TEST_MAGIC, iv, ciphertext, cipher.getAuthTag()]);
    },
    async decrypt(wrapped) {
      if (wrapped.length < 32 || !wrapped.subarray(0, 4).equals(TEST_MAGIC)) {
        throw new Error('Not wrapped by the test key provider');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, wrapped.subarray(4, 16));
      decipher.setAuthTag(wrapped.subarray(wrapped.length - 16));
      return Buffer.concat([
        decipher.update(wrapped.subarray(16, wrapped.length - 16)),
        decipher.final(),
      ]);
    },
  };
}

/**
 * The subset of Electron's `safeStorage` this package needs (duck-typed, so this library never
 * imports Electron). Use it in the main process after `app.whenReady()`.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only: "basic_text", "gnome_libsecret", "kwallet", "kwallet5", "kwallet6", "unknown". */
  getSelectedStorageBackend?(): string;
}

function describeBackend(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform,
): { backend: string; secure: boolean } {
  if (platform === 'darwin') return { backend: 'macOS Keychain', secure: true };
  if (platform === 'win32') return { backend: 'Windows DPAPI', secure: true };
  if (platform === 'linux') {
    const selected = safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
    if (selected === 'gnome_libsecret') return { backend: 'libsecret', secure: true };
    if (selected.startsWith('kwallet')) return { backend: 'KWallet', secure: true };
    return { backend: selected, secure: false };
  }
  return { backend: `safeStorage (${platform})`, secure: true };
}

/**
 * KeyProvider backed by Electron's `safeStorage` (Keychain / DPAPI / libsecret / KWallet).
 * On Linux without a keyring Electron falls back to "basic_text" (a hard-coded password):
 * the provider then reports `secure: false` so the UI can warn the user.
 */
export function createSafeStorageKeyProvider(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform = process.platform,
): KeyProvider {
  const { backend, secure } = describeBackend(safeStorage, platform);
  const ensureAvailable = () => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new VaultError('key_unavailable', 'OS encryption (safeStorage) is not available');
    }
  };
  return {
    backend,
    secure,
    async encrypt(plain) {
      ensureAvailable();
      return safeStorage.encryptString(plain.toString('base64'));
    },
    async decrypt(wrapped) {
      ensureAvailable();
      return Buffer.from(safeStorage.decryptString(wrapped), 'base64');
    },
  };
}
