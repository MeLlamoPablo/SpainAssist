export type VaultErrorCode =
  /** The .p12 passphrase is wrong. */
  | 'invalid_passphrase'
  /** Not a usable certificate file (format, no private key, unsupported algorithm...). */
  | 'invalid_certificate'
  | 'expired_certificate'
  | 'not_found'
  /** Wrong key (e.g. the OS keychain entry changed), tampered or truncated files. */
  | 'corrupted'
  | 'invalid_input'
  /** The KeyProvider cannot protect or unwrap keys (e.g. OS encryption unavailable). */
  | 'key_unavailable'
  /** File system failure (permissions, disk full...). `cause` holds the original error. */
  | 'io';

export class VaultError extends Error {
  override readonly name = 'VaultError';
  constructor(
    readonly code: VaultErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
