/**
 * The macOS keychain through Security.framework, called in-process with koffi (FFI): the key's
 * access list then names the app itself, and nothing goes through a command line
 * (`docs/research/os-certificate-store.md` §2). File-based keychains only (the login keychain):
 * the data-protection keychain needs an access group the app doesn't have.
 */
import type { SignatureDigest } from '@sa/shared';
import { type OsKeyStore, OsKeyStoreError } from './store';

type Ref = unknown;

const ERR_USER_CANCELED = -128;
const ERR_AUTH_FAILED = -25293;
const ERR_ITEM_NOT_FOUND = -25300;
const ERR_DUPLICATE_ITEM = -25299;
const UTF8 = 0x08000100;
/** `SecExternalFormat` / `SecExternalItemType` of a PKCS#12 file. */
const FORMAT_PKCS12 = 12;
const ITEM_AGGREGATE = 5;

const DIGEST_ALGORITHMS: Record<SignatureDigest, string> = {
  sha1: 'kSecKeyAlgorithmRSASignatureDigestPKCS1v15SHA1',
  sha256: 'kSecKeyAlgorithmRSASignatureDigestPKCS1v15SHA256',
  sha384: 'kSecKeyAlgorithmRSASignatureDigestPKCS1v15SHA384',
  sha512: 'kSecKeyAlgorithmRSASignatureDigestPKCS1v15SHA512',
};

export interface KeychainOptions {
  /**
   * A keychain file to use instead of the user's keychains (tests). It must exist and be
   * unlocked.
   */
  keychainPath?: string;
}

/** Loads koffi and the system frameworks: macOS only. Throws when they can't be loaded. */
export async function openKeychain(options: KeychainOptions = {}): Promise<OsKeyStore> {
  const { default: koffi } = await import('koffi');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const sec = koffi.load('/System/Library/Frameworks/Security.framework/Security');

  const CFRelease = cf.func('void CFRelease(void *)');
  const CFDictionaryCreateMutable = cf.func(
    'void *CFDictionaryCreateMutable(void *, long, void *, void *)',
  );
  const CFDictionarySetValue = cf.func('void CFDictionarySetValue(void *, void *, void *)');
  const CFArrayCreate = cf.func('void *CFArrayCreate(void *, void **, long, void *)');
  const CFArrayGetCount = cf.func('long CFArrayGetCount(void *)');
  const CFArrayGetValueAtIndex = cf.func('void *CFArrayGetValueAtIndex(void *, long)');
  const CFDataCreate = cf.func('void *CFDataCreate(void *, const uint8_t *, long)');
  const CFDataGetLength = cf.func('long CFDataGetLength(void *)');
  const CFDataGetBytePtr = cf.func('void *CFDataGetBytePtr(void *)');
  const CFStringCreateWithCString = cf.func(
    'void *CFStringCreateWithCString(void *, const char *, uint32_t)',
  );
  const CFErrorGetCode = cf.func('long CFErrorGetCode(void *)');

  const SecItemCopyMatching = sec.func('int32_t SecItemCopyMatching(void *, _Out_ void **)');
  const SecIdentityCopyCertificate = sec.func(
    'int32_t SecIdentityCopyCertificate(void *, _Out_ void **)',
  );
  const SecIdentityCopyPrivateKey = sec.func(
    'int32_t SecIdentityCopyPrivateKey(void *, _Out_ void **)',
  );
  const SecCertificateCopyData = sec.func('void *SecCertificateCopyData(void *)');
  const SecKeyCreateSignature = sec.func(
    'void *SecKeyCreateSignature(void *, void *, void *, _Out_ void **)',
  );
  const SecKeychainOpen = sec.func('int32_t SecKeychainOpen(const char *, _Out_ void **)');
  koffi.struct('SecItemImportExportKeychainParameters', {
    version: 'uint32_t',
    flags: 'uint32_t',
    passphrase: 'void *',
    alertTitle: 'void *',
    alertPrompt: 'void *',
    accessRef: 'void *',
    keyUsage: 'void *',
    keyAttributes: 'void *',
  });
  const SecItemImport = sec.func(
    'int32_t SecItemImport(void *, void *, _Inout_ uint32_t *, _Inout_ uint32_t *, uint32_t, SecItemImportExportKeychainParameters *, void *, _Out_ void **)',
  );

  /** An exported CFTypeRef constant (`kSecClass`, `kCFBooleanTrue`…). */
  const constant = (lib: typeof cf, name: string): Ref =>
    koffi.decode(lib.symbol(name, 'void *'), 'void *');
  const keyCallbacks = cf.symbol('kCFTypeDictionaryKeyCallBacks', 'void *');
  const valueCallbacks = cf.symbol('kCFTypeDictionaryValueCallBacks', 'void *');
  const arrayCallbacks = cf.symbol('kCFTypeArrayCallBacks', 'void *');

  const release = (...refs: Ref[]): void => {
    for (const ref of refs) if (ref) CFRelease(ref);
  };
  const data = (bytes: Uint8Array): Ref => CFDataCreate(null, bytes, bytes.length);
  const bytesOf = (ref: Ref): Buffer => {
    const length = Number(CFDataGetLength(ref));
    return Buffer.from(koffi.decode(CFDataGetBytePtr(ref), koffi.array('uint8_t', length)));
  };
  const array = (items: Ref[]): Ref => CFArrayCreate(null, items, items.length, arrayCallbacks);
  /** Runs a blocking Security call on a worker thread: a keychain prompt may be on screen. */
  const run = <T>(fn: { async(...args: unknown[]): unknown }, ...args: unknown[]): Promise<T> =>
    new Promise((resolve, reject) => {
      fn.async(...args, (err: Error | null, result: T) => (err ? reject(err) : resolve(result)));
    });

  let keychain: Ref = null;
  if (options.keychainPath) {
    const out: Ref[] = [null];
    const status = SecKeychainOpen(options.keychainPath, out);
    if (status !== 0 || !out[0])
      throw new OsKeyStoreError('failed', 'The keychain could not be opened', status);
    keychain = out[0];
  }

  /**
   * Every identity with its certificate (DER). The identities live until `dispose`, which the
   * caller must call.
   */
  async function identities(): Promise<{
    found: { identity: Ref; certificate: Buffer }[];
    dispose(): void;
  }> {
    const query = CFDictionaryCreateMutable(null, 0, keyCallbacks, valueCallbacks);
    const searchList = keychain ? array([keychain]) : null;
    const out: Ref[] = [null];
    try {
      CFDictionarySetValue(query, constant(sec, 'kSecClass'), constant(sec, 'kSecClassIdentity'));
      CFDictionarySetValue(
        query,
        constant(sec, 'kSecMatchLimit'),
        constant(sec, 'kSecMatchLimitAll'),
      );
      CFDictionarySetValue(query, constant(sec, 'kSecReturnRef'), constant(cf, 'kCFBooleanTrue'));
      if (searchList) CFDictionarySetValue(query, constant(sec, 'kSecMatchSearchList'), searchList);
      const status = await run<number>(SecItemCopyMatching, query, out);
      if (status === ERR_ITEM_NOT_FOUND) return { found: [], dispose: () => {} };
      if (status !== 0 || !out[0])
        throw new OsKeyStoreError('failed', 'The keychain could not be read', status);
      const found: { identity: Ref; certificate: Buffer }[] = [];
      const count = Number(CFArrayGetCount(out[0]));
      for (let i = 0; i < count; i++) {
        const identity = CFArrayGetValueAtIndex(out[0], i);
        const certificate: Ref[] = [null];
        if (SecIdentityCopyCertificate(identity, certificate) !== 0 || !certificate[0]) continue;
        const der = SecCertificateCopyData(certificate[0]);
        if (der) found.push({ identity, certificate: bytesOf(der) });
        release(der, certificate[0]);
      }
      // The array owns the identities.
      return { found, dispose: () => release(out[0]) };
    } finally {
      release(searchList, query);
    }
  }

  return {
    async list() {
      const { found, dispose } = await identities();
      dispose();
      return found.map((entry) => entry.certificate);
    },

    async sign(certificate, digest, hash) {
      const wanted = Buffer.from(certificate);
      const { found, dispose } = await identities();
      const key: Ref[] = [null];
      try {
        const match = found.find((entry) => entry.certificate.equals(wanted));
        if (!match)
          throw new OsKeyStoreError('not_found', 'The certificate is no longer in the keychain');
        const status = SecIdentityCopyPrivateKey(match.identity, key);
        if (status !== 0 || !key[0])
          throw new OsKeyStoreError('not_found', 'The certificate has no usable key', status);
      } finally {
        dispose();
      }
      const input = data(digest);
      const error: Ref[] = [null];
      try {
        const signature = await run<Ref>(
          SecKeyCreateSignature,
          key[0],
          constant(sec, DIGEST_ALGORITHMS[hash]),
          input,
          error,
        );
        if (!signature) {
          const status = error[0] ? Number(CFErrorGetCode(error[0])) : undefined;
          const denied = status === ERR_USER_CANCELED || status === ERR_AUTH_FAILED;
          throw new OsKeyStoreError(
            denied ? 'denied' : 'failed',
            denied ? 'The keychain signature was not allowed' : 'The keychain signature failed',
            status,
          );
        }
        try {
          return bytesOf(signature);
        } finally {
          release(signature);
        }
      } finally {
        release(error[0], input, key[0]);
      }
    },

    async importPkcs12(p12, passphrase) {
      const input = data(p12);
      const password = CFStringCreateWithCString(null, passphrase, UTF8);
      // Extractable: once it leaves the app, the keychain holds the only copy, and the user can
      // still make a backup from Acceso a Llaveros.
      const attributes = array([
        constant(sec, 'kSecAttrIsPermanent'),
        constant(sec, 'kSecAttrIsExtractable'),
      ]);
      const items: Ref[] = [null];
      try {
        const status = await run<number>(
          SecItemImport,
          input,
          null,
          [FORMAT_PKCS12],
          [ITEM_AGGREGATE],
          0,
          {
            version: 0,
            flags: 0,
            passphrase: password,
            alertTitle: null,
            alertPrompt: null,
            accessRef: null,
            keyUsage: null,
            keyAttributes: attributes,
          },
          keychain,
          items,
        );
        // Already there (an earlier import): the caller checks what the keychain holds.
        if (status !== 0 && status !== ERR_DUPLICATE_ITEM)
          throw new OsKeyStoreError(
            status === ERR_USER_CANCELED ? 'denied' : 'failed',
            'The certificate could not be added to the keychain',
            status,
          );
      } finally {
        release(items[0], attributes, password, input);
      }
    },
  };
}
