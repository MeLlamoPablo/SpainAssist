/**
 * @sa/vault — local encrypted store for personal data, documents, credentials and app secrets.
 *
 * Plain Node library (no Electron imports): the OS-backed key protection is injected through
 * `KeyProvider` (the desktop app passes `createSafeStorageKeyProvider(safeStorage)`; tests use
 * `createTestKeyProvider`).
 *
 * Design (envelope encryption, see envelope.ts for the byte layout):
 *   <dir>/key.bin            random 256-bit data key, wrapped by KeyProvider.encrypt()
 *   <dir>/vault.bin          AES-256-GCM(JSON state) — personal data, credential secrets, metadata
 *   <dir>/documents/<id>.bin AES-256-GCM(file bytes)
 * Writes are atomic (temp file + fsync + rename), the directory is 0700 and files 0600, and
 * nothing is ever written in plaintext.
 */
export {
  certificateInfo,
  type ImportedCertificate,
  importCertificate,
  parseHolder,
  pkcs12ToPem,
} from './certificate';
export { VaultError, type VaultErrorCode } from './errors';
export { retryWhileLocked } from './files';
export { compactId, isDni, isNie, isSpanishId } from './ids';
export {
  createSafeStorageKeyProvider,
  createTestKeyProvider,
  type KeyProvider,
  type SafeStorageLike,
} from './keys';
export { normalizePersonalInput, PersonalDataValidationError } from './personal';
export { type Pkcs12Contents, Pkcs12Error, readPkcs12 } from './pkcs12';
export {
  type AddDocumentOptions,
  type CertificateSecret,
  type ClaveSecret,
  type CredentialSecret,
  Vault,
  type VaultOptions,
} from './vault';
