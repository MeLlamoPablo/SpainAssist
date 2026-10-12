import type { KeyProvider } from '@sa/vault';
import type { Logger } from '../core/logger';
import type { Biometric } from '../ports';

/** The subset of Electron's `safeStorage` we use (injected so this module stays testable). */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
  setUsePlainTextEncryption?(usePlainText: boolean): void;
}

function backendLabel(
  platform: NodeJS.Platform,
  linuxBackend: string | undefined,
): { backend: string; secure: boolean } {
  if (platform === 'darwin') return { backend: 'macOS Keychain', secure: true };
  if (platform === 'win32') return { backend: 'Windows DPAPI', secure: true };
  switch (linuxBackend) {
    case 'gnome_libsecret':
      return { backend: 'libsecret', secure: true };
    case 'kwallet':
    case 'kwallet5':
    case 'kwallet6':
      return { backend: 'KWallet', secure: true };
    case 'basic_text':
      return { backend: 'basic_text', secure: false };
    default:
      return { backend: linuxBackend ?? 'unknown', secure: false };
  }
}

/**
 * KeyProvider backed by the OS (Keychain / DPAPI / libsecret) through Electron's async
 * safeStorage API. It only wraps the vault's random data key; the data itself is encrypted by
 * @sa/vault. Must be created after `app.whenReady()`.
 */
export async function createSafeStorageKeyProvider(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform,
  logger: Logger,
): Promise<KeyProvider> {
  let available = await safeStorage.isAsyncEncryptionAvailable();
  if (!available && platform === 'linux' && safeStorage.setUsePlainTextEncryption) {
    logger.warn('no OS keyring available: falling back to basic_text (insecure)');
    safeStorage.setUsePlainTextEncryption(true);
    available = await safeStorage.isAsyncEncryptionAvailable();
  }
  if (!available) throw new Error('OS encryption (safeStorage) is not available');
  const linuxBackend = platform === 'linux' ? safeStorage.getSelectedStorageBackend?.() : undefined;
  const { backend, secure } = backendLabel(platform, linuxBackend);
  return {
    backend,
    secure,
    async encrypt(plain: Buffer): Promise<Buffer> {
      return safeStorage.encryptStringAsync(plain.toString('base64'));
    },
    async decrypt(wrapped: Buffer): Promise<Buffer> {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(wrapped);
      if (shouldReEncrypt) logger.info('safeStorage suggests re-encrypting the vault key');
      return Buffer.from(result, 'base64');
    },
  };
}

/** The subset of Electron's `systemPreferences` used for Touch ID. */
export interface TouchIdLike {
  canPromptTouchID(): boolean;
  promptTouchID(reason: string): Promise<void>;
}

/** Touch ID on macOS when available; elsewhere the in-app confirmation is the only step. */
export function createTouchIdBiometric(
  prefs: TouchIdLike | undefined,
  platform: NodeJS.Platform,
  logger: Logger,
): Biometric {
  const available = () => {
    if (platform !== 'darwin' || !prefs) return false;
    try {
      return prefs.canPromptTouchID();
    } catch {
      return false;
    }
  };
  return {
    available,
    async prompt(reason: string): Promise<boolean> {
      if (!available()) return true;
      try {
        await prefs!.promptTouchID(reason);
        return true;
      } catch (err) {
        logger.info('Touch ID not confirmed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
  };
}
