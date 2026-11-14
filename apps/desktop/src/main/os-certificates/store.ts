import type { SignatureDigest } from '@sa/shared';

/**
 * The operating system's store of certificates with a private key (identities): the macOS
 * keychain, or the Windows store of the current user. The keys stay there: the app lists the
 * certificates and asks the OS for signatures.
 */
export interface OsKeyStore {
  /** DER certificates of every identity in the store. Never prompts. */
  list(): Promise<Buffer[]>;
  /**
   * RSA PKCS#1 v1.5 signature over `digest` (already hashed with `hash`) with the key of
   * `certificate` (DER). The OS may ask the user first, the first time the app uses a key that
   * another program installed.
   */
  sign(certificate: Uint8Array, digest: Uint8Array, hash: SignatureDigest): Promise<Buffer>;
  /**
   * Adds the identity and the chain of a PKCS#12 file (3DES, SHA-1 MAC) to the store. Absent
   * where the app only reads the store (Windows).
   */
  importPkcs12?(p12: Uint8Array, passphrase: string): Promise<void>;
}

export type OsKeyStoreErrorCode =
  /** The user refused in the OS prompt. */
  | 'denied'
  /** The store no longer has that certificate's key. */
  | 'not_found'
  | 'failed';

export class OsKeyStoreError extends Error {
  constructor(
    readonly code: OsKeyStoreErrorCode,
    message: string,
    /** The OS error (macOS: OSStatus; Windows: HRESULT). */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OsKeyStoreError';
  }
}
