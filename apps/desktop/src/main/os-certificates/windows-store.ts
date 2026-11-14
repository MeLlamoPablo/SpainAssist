/**
 * The Windows certificate store of the current user (`CurrentUser\My`, "Personal" in certmgr)
 * through crypt32 and ncrypt, called in-process with koffi (FFI)
 * (`docs/research/os-certificate-store.md` §3). Read-only: the Store build (MSIX) sees the
 * user's real store, but Windows keeps what it writes there private to the app, where no other
 * program would find it, so nothing is ever added (no `importPkcs12`).
 */
import type { SignatureDigest } from '@sa/shared';
import { type OsKeyStore, OsKeyStoreError } from './store';

type Ref = unknown;

/** `CERT_STORE_PROV_SYSTEM_W`: a system store, named with a wide string. */
const STORE_PROVIDER_SYSTEM = 10;
const SYSTEM_STORE_CURRENT_USER = 0x0001_0000;
const STORE_READONLY = 0x0000_8000;
/** What marks a certificate that has a private key: where its key container is. */
const KEY_PROV_INFO_PROP_ID = 2;
/**
 * A CNG handle or nothing. CNG also opens the keys of Microsoft's older (CAPI) software
 * providers, where browsers used to put FNMT certificates, and signs with SHA-2 where those
 * providers themselves can't.
 */
const ACQUIRE_ONLY_NCRYPT_KEY = 0x0004_0000;
const PAD_PKCS1 = 0x0000_0002;
/** NTE_USER_CANCELLED, SCARD_W_CANCELLED_BY_USER and ERROR_CANCELLED as an HRESULT. */
const CANCELLED = new Set([0x8009_0036, 0x8010_006e, 0x8007_04c7]);
/** Enough for an RSA key of 8192 bits. */
const MAX_SIGNATURE_BYTES = 1024;
/** Whether koffi already has this module's structs. */
let structsDefined = false;

const DIGEST_ALGORITHMS: Record<SignatureDigest, string> = {
  sha1: 'SHA1',
  sha256: 'SHA256',
  sha384: 'SHA384',
  sha512: 'SHA512',
};

export interface WindowsStoreOptions {
  /** A store of the current user to read instead of `MY` (tests). */
  storeName?: string;
}

/** Loads koffi and the system libraries: Windows only. Throws when they can't be loaded. */
export async function openWindowsStore(options: WindowsStoreOptions = {}): Promise<OsKeyStore> {
  const { default: koffi } = await import('koffi');
  const crypt32 = koffi.load('crypt32.dll');
  const ncrypt = koffi.load('ncrypt.dll');

  // koffi's type names are global: a second `openWindowsStore` in the process finds them defined.
  if (!structsDefined) {
    structsDefined = true;
    koffi.struct('CERT_CONTEXT', {
      dwCertEncodingType: 'uint32_t',
      pbCertEncoded: 'void *',
      cbCertEncoded: 'uint32_t',
      pCertInfo: 'void *',
      hCertStore: 'void *',
    });
    koffi.struct('BCRYPT_PKCS1_PADDING_INFO', { pszAlgId: 'str16' });
  }

  const CertOpenStore = crypt32.func(
    'void *__stdcall CertOpenStore(uintptr_t, uint32_t, uintptr_t, uint32_t, str16)',
  );
  const CertCloseStore = crypt32.func('bool __stdcall CertCloseStore(void *, uint32_t)');
  const CertEnumCertificatesInStore = crypt32.func(
    'void *__stdcall CertEnumCertificatesInStore(void *, void *)',
  );
  const CertFreeCertificateContext = crypt32.func(
    'bool __stdcall CertFreeCertificateContext(void *)',
  );
  const CertGetCertificateContextProperty = crypt32.func(
    'bool __stdcall CertGetCertificateContextProperty(void *, uint32_t, void *, _Inout_ uint32_t *)',
  );
  const CryptAcquireCertificatePrivateKey = crypt32.func(
    'bool __stdcall CryptAcquireCertificatePrivateKey(void *, uint32_t, void *, _Out_ uintptr_t *, _Out_ uint32_t *, _Out_ int *)',
  );
  const NCryptSignHash = ncrypt.func(
    'int32_t __stdcall NCryptSignHash(uintptr_t, BCRYPT_PKCS1_PADDING_INFO *, const uint8_t *, uint32_t, _Out_ uint8_t *, uint32_t, _Out_ uint32_t *, uint32_t)',
  );
  const NCryptFreeObject = ncrypt.func('int32_t __stdcall NCryptFreeObject(uintptr_t)');

  /** Runs a blocking call on a worker thread: a Windows prompt (PIN, consent) may be on screen. */
  const run = <T>(fn: { async(...args: unknown[]): unknown }, ...args: unknown[]): Promise<T> =>
    new Promise((resolve, reject) => {
      fn.async(...args, (err: Error | null, result: T) => (err ? reject(err) : resolve(result)));
    });

  const openStore = (): Ref => {
    const store = CertOpenStore(
      STORE_PROVIDER_SYSTEM,
      0,
      0,
      SYSTEM_STORE_CURRENT_USER | STORE_READONLY,
      options.storeName ?? 'MY',
    );
    if (!store) throw new OsKeyStoreError('failed', 'The certificate store could not be opened');
    return store;
  };

  const derOf = (context: Ref): Buffer => {
    const { pbCertEncoded, cbCertEncoded } = koffi.decode(context, 'CERT_CONTEXT') as {
      pbCertEncoded: Ref;
      cbCertEncoded: number;
    };
    return Buffer.from(koffi.decode(pbCertEncoded, koffi.array('uint8_t', cbCertEncoded)));
  };

  /**
   * Walks the certificates that have a private key. `visit` returns true to stop there: the
   * context is then the caller's, to free with `CertFreeCertificateContext`.
   */
  const find = (visit: (der: Buffer) => boolean): Ref => {
    const store = openStore();
    try {
      let context: Ref = null;
      // Each call frees the context it is given.
      for (;;) {
        context = CertEnumCertificatesInStore(store, context);
        if (!context) return null;
        if (!CertGetCertificateContextProperty(context, KEY_PROV_INFO_PROP_ID, null, [0])) continue;
        if (visit(derOf(context))) return context;
      }
    } finally {
      // A context found keeps what it needs of the store.
      CertCloseStore(store, 0);
    }
  };

  return {
    async list() {
      const found: Buffer[] = [];
      find((der) => {
        found.push(der);
        return false;
      });
      return found;
    },

    async sign(certificate, digest, hash) {
      const wanted = Buffer.from(certificate);
      const context = find((der) => der.equals(wanted));
      if (!context)
        throw new OsKeyStoreError('not_found', 'The certificate is no longer in the store');
      const key: (number | bigint)[] = [0];
      const release: number[] = [0];
      try {
        const acquired = await run<boolean>(
          CryptAcquireCertificatePrivateKey,
          context,
          ACQUIRE_ONLY_NCRYPT_KEY,
          null,
          key,
          [0],
          release,
        );
        if (!acquired || !key[0])
          throw new OsKeyStoreError('not_found', 'The certificate has no usable key');
        const signature = Buffer.alloc(MAX_SIGNATURE_BYTES);
        const length: number[] = [0];
        const status = await run<number>(
          NCryptSignHash,
          key[0],
          { pszAlgId: DIGEST_ALGORITHMS[hash] },
          digest,
          digest.length,
          signature,
          signature.length,
          length,
          PAD_PKCS1,
        );
        if (status !== 0) {
          const denied = CANCELLED.has(status >>> 0);
          throw new OsKeyStoreError(
            denied ? 'denied' : 'failed',
            denied ? 'The signature was not allowed' : 'The signature failed',
            status,
          );
        }
        return Buffer.from(signature.subarray(0, length[0]));
      } finally {
        if (key[0] && release[0]) NCryptFreeObject(key[0]);
        CertFreeCertificateContext(context);
      }
    },
  };
}
