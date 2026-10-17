/**
 * PKCS#12 (.p12 / .pfx) reading and re-encoding.
 *
 * node-forge cannot read EC private keys (FNMT's new hierarchy issues ECDSA P-256/P-384 keys), so
 * the container is parsed here with asn1js and decrypted with Node's crypto. node-forge is only
 * used for the RC2 cipher of legacy files (`openssl pkcs12 -legacy`, old Windows/Firefox
 * exports), which OpenSSL 3 / Node no longer ship.
 *
 * Supported: PBES2 (PBKDF2 + AES-128/192/256-CBC or 3DES), PKCS#12 PBE with SHA-1 and
 * 3DES (2/3-key), RC2-40/128 or RC4-40/128; MAC with SHA-1/224/256/384/512 or PBMAC1;
 * RSA, EC and other key types Node can import from PKCS#8.
 */
import crypto, { type KeyObject } from 'node:crypto';
import type { CertificateInfo } from '@sa/shared';
import forge from 'node-forge';
import { certificateInfo } from './certificate';
import {
  type Asn1,
  bmp,
  child,
  children,
  encodeDer,
  explicit,
  implicitOctets,
  int,
  intOf,
  isContext,
  nul,
  octets,
  octetsOf,
  oid,
  oidOf,
  parseBer,
  rawBytes,
  seq,
  set,
  stringOf,
} from './util/asn1';
import { asBuffer } from './util/base64';

export type P12ErrorCode =
  | 'BAD_PASSWORD'
  | 'INVALID_FILE'
  | 'NO_PRIVATE_KEY'
  | 'NO_CERTIFICATE'
  | 'UNSUPPORTED';

export class P12Error extends Error {
  readonly code: P12ErrorCode;
  constructor(code: P12ErrorCode, message: string) {
    super(message);
    this.name = 'P12Error';
    this.code = code;
  }
}

export interface P12Contents {
  /** DER of the signing (end-entity) certificate. */
  certificateDer: Buffer;
  /** Certificate path found in the file, starting with `certificateDer`, then its issuers. */
  chainDer: Buffer[];
  info: CertificateInfo;
}

export type KeyType = 'rsa' | 'ec';

/** Everything needed to sign. Stays in the main process; never serialize it. */
export interface P12Identity extends P12Contents {
  privateKey: KeyObject;
  keyType: KeyType;
  /** EC keys only: JOSE curve name ('P-256', 'P-384', 'P-521'). */
  namedCurve?: string;
}

const OID = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  envelopedData: '1.2.840.113549.1.7.3',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  safeContentsBag: '1.2.840.113549.1.12.10.1.6',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  friendlyName: '1.2.840.113549.1.9.20',
  localKeyId: '1.2.840.113549.1.9.21',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  pbmac1: '1.2.840.113549.1.5.14',
  pbeSha1Rc4_128: '1.2.840.113549.1.12.1.1',
  pbeSha1Rc4_40: '1.2.840.113549.1.12.1.2',
  pbeSha1Des3: '1.2.840.113549.1.12.1.3',
  pbeSha1Des2: '1.2.840.113549.1.12.1.4',
  pbeSha1Rc2_128: '1.2.840.113549.1.12.1.5',
  pbeSha1Rc2_40: '1.2.840.113549.1.12.1.6',
  aes128cbc: '2.16.840.1.101.3.4.1.2',
  aes192cbc: '2.16.840.1.101.3.4.1.22',
  aes256cbc: '2.16.840.1.101.3.4.1.42',
  desEde3cbc: '1.2.840.113549.3.7',
} as const;

const HASH_BY_OID: Record<string, string> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.4': 'sha224',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};
const OID_BY_HASH: Record<string, string> = Object.fromEntries(
  Object.entries(HASH_BY_OID).map(([k, v]) => [v, k]),
);
const HMAC_BY_OID: Record<string, string> = {
  '1.2.840.113549.2.7': 'sha1',
  '1.2.840.113549.2.8': 'sha224',
  '1.2.840.113549.2.9': 'sha256',
  '1.2.840.113549.2.10': 'sha384',
  '1.2.840.113549.2.11': 'sha512',
};
const PBES2_CIPHERS: Record<string, { name: string; keyLength: number }> = {
  [OID.aes128cbc]: { name: 'aes-128-cbc', keyLength: 16 },
  [OID.aes192cbc]: { name: 'aes-192-cbc', keyLength: 24 },
  [OID.aes256cbc]: { name: 'aes-256-cbc', keyLength: 32 },
  [OID.desEde3cbc]: { name: 'des-ede3-cbc', keyLength: 24 },
};

/** Refuse absurd iteration counts (a crafted file could otherwise hang the main process). */
const MAX_ITERATIONS = 10_000_000;

// ---------------------------------------------------------------------------------------------
// Key derivation and ciphers
// ---------------------------------------------------------------------------------------------

interface Passwords {
  /** BMPString (UTF-16BE) with a 2-byte terminator: PKCS#12 PBE and MAC. */
  bmp: Buffer;
  /** UTF-8 bytes: PBES2 / PBKDF2 (OpenSSL, NSS, Java) and PBMAC1. */
  utf8: Buffer;
  /**
   * Encodings tried in order for PBES2 when the passphrase has non-ASCII characters: some
   * exporters use Latin-1 (node-forge) or UTF-16 instead of UTF-8. The MAC has already validated
   * the passphrase, and each attempt is checked (padding + ASN.1), so trying them is safe.
   */
  pbes2: Buffer[];
}

function passwords(passphrase: string): Passwords[] {
  const utf16be = Buffer.from(passphrase, 'utf16le').swap16();
  const utf8 = Buffer.from(passphrase, 'utf8');
  const pbes2 = [utf8];
  const maxCode = Math.max(0, ...Array.from(passphrase, (c) => c.charCodeAt(0)));
  if (maxCode > 0x7f) {
    if (maxCode <= 0xff) pbes2.push(Buffer.from(passphrase, 'latin1'));
    pbes2.push(utf16be, Buffer.concat([utf16be, Buffer.alloc(2)]));
  }
  const variants: Passwords[] = [{ bmp: Buffer.concat([utf16be, Buffer.alloc(2)]), utf8, pbes2 }];
  // Some tools encode an empty password as zero bytes instead of a lone terminator.
  if (passphrase === '') variants.push({ bmp: Buffer.alloc(0), utf8, pbes2 });
  return variants;
}

function hashBlockSize(hash: string): number {
  return hash === 'sha384' || hash === 'sha512' ? 128 : 64;
}

/** RFC 7292 Appendix B.2 key derivation (id 1 = key, 2 = IV, 3 = MAC key). */
export function pkcs12Kdf(
  hash: string,
  password: Buffer,
  salt: Buffer,
  id: 1 | 2 | 3,
  iterations: number,
  size: number,
): Buffer {
  const u = crypto.createHash(hash).digest().length;
  const v = hashBlockSize(hash);
  const fill = (src: Buffer): Buffer => {
    if (src.length === 0) return Buffer.alloc(0);
    const out = Buffer.alloc(v * Math.ceil(src.length / v));
    for (let i = 0; i < out.length; i++) out[i] = src[i % src.length];
    return out;
  };
  const d = Buffer.alloc(v, id);
  const input = Buffer.concat([fill(salt), fill(password)]);
  const blocks: Buffer[] = [];
  const count = Math.ceil(size / u);
  for (let i = 0; i < count; i++) {
    let a = crypto.createHash(hash).update(d).update(input).digest();
    for (let j = 1; j < iterations; j++) a = crypto.createHash(hash).update(a).digest();
    blocks.push(a);
    if (i < count - 1) {
      const b = fill(a);
      for (let j = 0; j < input.length; j += v) {
        let carry = 1;
        for (let k = v - 1; k >= 0; k--) {
          const sum = input[j + k] + b[k] + carry;
          input[j + k] = sum & 0xff;
          carry = sum >> 8;
        }
      }
    }
  }
  return Buffer.concat(blocks).subarray(0, size);
}

function checkIterations(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ITERATIONS) {
    throw new P12Error('UNSUPPORTED', `Unsupported iteration count ${n}`);
  }
  return n;
}

function stripPkcs7Padding(data: Buffer, blockSize: number): Buffer {
  const n = data[data.length - 1];
  if (!data.length || data.length % blockSize !== 0 || n < 1 || n > blockSize) {
    throw new P12Error('BAD_PASSWORD', 'Wrong passphrase or corrupt file');
  }
  for (let i = data.length - n; i < data.length; i++) {
    if (data[i] !== n) throw new P12Error('BAD_PASSWORD', 'Wrong passphrase or corrupt file');
  }
  return data.subarray(0, data.length - n);
}

/** Decrypted PKCS#12 payloads are always a DER SEQUENCE spanning the whole buffer. */
function checkDecrypted(plain: Buffer): Buffer {
  let ok = plain[0] === 0x30;
  if (ok) {
    try {
      ok = rawBytes(parseBer(plain)).length === plain.length;
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new P12Error('BAD_PASSWORD', 'Wrong passphrase or corrupt file');
  return plain;
}

function addPkcs7Padding(data: Buffer, blockSize: number): Buffer {
  const n = blockSize - (data.length % blockSize);
  return Buffer.concat([data, Buffer.alloc(n, n)]);
}

function nodeCipher(name: string, key: Buffer, iv: Buffer, data: Buffer, encrypt: boolean): Buffer {
  const c = encrypt ? crypto.createCipheriv(name, key, iv) : crypto.createDecipheriv(name, key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}

function forgeRc2(key: Buffer, bits: number, iv: Buffer, data: Buffer, encrypt: boolean): Buffer {
  const k = forge.util.createBuffer(key.toString('binary'));
  const cipher = encrypt
    ? forge.rc2.createEncryptionCipher(k, bits)
    : forge.rc2.createDecryptionCipher(k, bits);
  cipher.start(forge.util.createBuffer(iv.toString('binary')));
  cipher.update(forge.util.createBuffer(data.toString('binary')));
  // Padding is handled by the caller (strict check); forge only processes whole blocks.
  cipher.finish(() => true);
  return Buffer.from(cipher.output.getBytes(), 'binary');
}

function forgeDes3(key: Buffer, iv: Buffer, data: Buffer, encrypt: boolean): Buffer {
  const k = forge.util.createBuffer(key.toString('binary'));
  const cipher = encrypt
    ? forge.cipher.createCipher('3DES-CBC', k)
    : forge.cipher.createDecipher('3DES-CBC', k);
  cipher.start({ iv: forge.util.createBuffer(iv.toString('binary')) });
  cipher.update(forge.util.createBuffer(data.toString('binary')));
  // forge accepts a padding callback (untyped); padding is handled by the caller.
  (cipher.finish as unknown as (pad: () => boolean) => boolean)(() => true);
  return Buffer.from(cipher.output.getBytes(), 'binary');
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

/** 3DES through Node when available, node-forge otherwise (e.g. a BoringSSL build without it). */
function des3(key: Buffer, iv: Buffer, data: Buffer, encrypt: boolean): Buffer {
  const name = key.length === 16 ? 'des-ede-cbc' : 'des-ede3-cbc';
  try {
    return nodeCipher(name, key, iv, data, encrypt);
  } catch (e) {
    if ((e as { code?: string }).code !== 'ERR_OSSL_EVP_UNSUPPORTED') throw e;
    const k = key.length === 16 ? Buffer.concat([key, key.subarray(0, 8)]) : key;
    return forgeDes3(k, iv, data, encrypt);
  }
}

interface PkcsPbe {
  keyLength: number;
  ivLength: number;
  run(key: Buffer, iv: Buffer, data: Buffer, encrypt: boolean): Buffer;
  blockSize: number;
}

const PKCS12_PBE: Record<string, PkcsPbe> = {
  [OID.pbeSha1Des3]: { keyLength: 24, ivLength: 8, blockSize: 8, run: des3 },
  [OID.pbeSha1Des2]: { keyLength: 16, ivLength: 8, blockSize: 8, run: des3 },
  [OID.pbeSha1Rc2_128]: {
    keyLength: 16,
    ivLength: 8,
    blockSize: 8,
    run: (k, iv, d, e) => forgeRc2(k, 128, iv, d, e),
  },
  [OID.pbeSha1Rc2_40]: {
    keyLength: 5,
    ivLength: 8,
    blockSize: 8,
    run: (k, iv, d, e) => forgeRc2(k, 40, iv, d, e),
  },
  [OID.pbeSha1Rc4_128]: { keyLength: 16, ivLength: 0, blockSize: 1, run: (k, _iv, d) => rc4(k, d) },
  [OID.pbeSha1Rc4_40]: { keyLength: 5, ivLength: 0, blockSize: 1, run: (k, _iv, d) => rc4(k, d) },
};

function decrypt(algorithm: Asn1, data: Buffer, pw: Passwords): Buffer {
  const algOid = oidOf(child(algorithm, 0, 'algorithm'));
  const params = children(algorithm)[1];
  try {
    if (algOid === OID.pbes2) {
      if (!params) throw new P12Error('INVALID_FILE', 'Missing PBES2 parameters');
      const kdf = child(params, 0, 'PBES2 KDF');
      const scheme = child(params, 1, 'PBES2 encryption scheme');
      if (oidOf(child(kdf, 0)) !== OID.pbkdf2) {
        throw new P12Error('UNSUPPORTED', 'Unsupported PBES2 key derivation function');
      }
      const kdfParams = child(kdf, 1, 'PBKDF2 parameters');
      const salt = octetsOf(child(kdfParams, 0, 'PBKDF2 salt'));
      const iterations = checkIterations(intOf(child(kdfParams, 1, 'PBKDF2 iterations')));
      let keyLength: number | undefined;
      let prf = 'sha1';
      for (const extra of children(kdfParams).slice(2)) {
        if ((extra as { idBlock?: { tagNumber: number } }).idBlock?.tagNumber === 2) {
          keyLength = intOf(extra);
        } else {
          const prfOid = oidOf(child(extra, 0));
          const h = HMAC_BY_OID[prfOid];
          if (!h) throw new P12Error('UNSUPPORTED', `Unsupported PBKDF2 PRF ${prfOid}`);
          prf = h;
        }
      }
      const schemeOid = oidOf(child(scheme, 0));
      const cipher = PBES2_CIPHERS[schemeOid];
      if (!cipher) throw new P12Error('UNSUPPORTED', `Unsupported PBES2 cipher ${schemeOid}`);
      const iv = octetsOf(child(scheme, 1, 'IV'));
      let lastError: unknown;
      for (const password of pw.pbes2) {
        try {
          const key = crypto.pbkdf2Sync(
            password,
            salt,
            iterations,
            keyLength ?? cipher.keyLength,
            prf,
          );
          const plain =
            cipher.name === 'des-ede3-cbc'
              ? des3(key, iv, data, false)
              : nodeCipher(cipher.name, key, iv, data, false);
          return checkDecrypted(stripPkcs7Padding(plain, iv.length));
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError;
    }
    const pbe = PKCS12_PBE[algOid];
    if (!pbe) throw new P12Error('UNSUPPORTED', `Unsupported encryption algorithm ${algOid}`);
    if (!params) throw new P12Error('INVALID_FILE', 'Missing PBE parameters');
    const salt = octetsOf(child(params, 0, 'salt'));
    const iterations = checkIterations(intOf(child(params, 1, 'iterations')));
    const key = pkcs12Kdf('sha1', pw.bmp, salt, 1, iterations, pbe.keyLength);
    const iv = pbe.ivLength ? pkcs12Kdf('sha1', pw.bmp, salt, 2, iterations, pbe.ivLength) : null;
    const plain = pbe.run(key, iv ?? Buffer.alloc(0), data, false);
    return checkDecrypted(pbe.blockSize > 1 ? stripPkcs7Padding(plain, pbe.blockSize) : plain);
  } catch (e) {
    if (e instanceof P12Error) throw e;
    throw new P12Error('BAD_PASSWORD', 'Wrong passphrase or corrupt file');
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

interface Bag {
  localKeyId?: Buffer;
  friendlyName?: string;
}
interface KeyEntry extends Bag {
  key: KeyObject;
}
interface CertEntry extends Bag {
  der: Buffer;
}

function bagAttributes(bag: Asn1): Bag {
  const out: Bag = {};
  const attrs = children(bag)[2];
  if (!attrs) return out;
  for (const attr of children(attrs)) {
    const type = oidOf(child(attr, 0));
    const values = children(child(attr, 1));
    if (!values[0]) continue;
    if (type === OID.localKeyId) out.localKeyId = octetsOf(values[0]);
    if (type === OID.friendlyName) out.friendlyName = stringOf(values[0]);
  }
  return out;
}

function importPrivateKey(pkcs8: Buffer): KeyObject {
  try {
    return crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  } catch {
    throw new P12Error('UNSUPPORTED', 'Unsupported private key');
  }
}

function readSafeContents(
  der: Buffer,
  pw: Passwords,
  keys: KeyEntry[],
  certs: CertEntry[],
  depth = 0,
): void {
  if (depth > 4) throw new P12Error('INVALID_FILE', 'Nested SafeContents too deep');
  for (const bag of children(parseBer(der))) {
    const bagId = oidOf(child(bag, 0, 'bagId'));
    const wrapper = child(bag, 1, 'bagValue');
    if (!isContext(wrapper, 0)) throw new P12Error('INVALID_FILE', 'Malformed SafeBag');
    const value = child(wrapper, 0, 'bagValue');
    const attrs = bagAttributes(bag);
    if (bagId === OID.keyBag) {
      keys.push({ ...attrs, key: importPrivateKey(rawBytes(value)) });
    } else if (bagId === OID.shroudedKeyBag) {
      const algorithm = child(value, 0, 'encryptionAlgorithm');
      const encrypted = octetsOf(child(value, 1, 'encryptedData'));
      keys.push({ ...attrs, key: importPrivateKey(decrypt(algorithm, encrypted, pw)) });
    } else if (bagId === OID.certBag) {
      if (oidOf(child(value, 0)) !== OID.x509Certificate) continue;
      const certValue = child(value, 1, 'certValue');
      certs.push({
        ...attrs,
        der: octetsOf(isContext(certValue, 0) ? child(certValue, 0) : certValue),
      });
    } else if (bagId === OID.safeContentsBag) {
      readSafeContents(rawBytes(value), pw, keys, certs, depth + 1);
    }
  }
}

function verifyMac(macData: Asn1, authSafe: Buffer, candidates: Passwords[]): Passwords | null {
  const digestInfo = child(macData, 0, 'mac');
  const algorithm = child(digestInfo, 0, 'mac algorithm');
  const algOid = oidOf(child(algorithm, 0));
  const expected = octetsOf(child(digestInfo, 1, 'mac digest'));
  const salt = octetsOf(child(macData, 1, 'macSalt'));
  const iterationsNode = children(macData)[2];
  const iterations = checkIterations(iterationsNode ? intOf(iterationsNode) : 1);

  for (const pw of candidates) {
    let mac: Buffer;
    if (algOid === OID.pbmac1) {
      // RFC 9579: key = PBKDF2(password, salt, ...), HMAC scheme given separately.
      const params = child(algorithm, 1, 'PBMAC1 parameters');
      const kdfParams = child(child(params, 0), 1, 'PBKDF2 parameters');
      const kdfSalt = octetsOf(child(kdfParams, 0));
      const kdfIterations = checkIterations(intOf(child(kdfParams, 1)));
      let keyLength = 32;
      let prf = 'sha1';
      for (const extra of children(kdfParams).slice(2)) {
        if ((extra as { idBlock?: { tagNumber: number } }).idBlock?.tagNumber === 2) {
          keyLength = intOf(extra);
        } else {
          prf = HMAC_BY_OID[oidOf(child(extra, 0))] ?? prf;
        }
      }
      const scheme = HMAC_BY_OID[oidOf(child(child(params, 1), 0))];
      if (!scheme) throw new P12Error('UNSUPPORTED', 'Unsupported PBMAC1 scheme');
      const key = crypto.pbkdf2Sync(pw.utf8, kdfSalt, kdfIterations, keyLength, prf);
      mac = crypto.createHmac(scheme, key).update(authSafe).digest();
    } else {
      const hash = HASH_BY_OID[algOid];
      if (!hash) throw new P12Error('UNSUPPORTED', `Unsupported MAC algorithm ${algOid}`);
      const size = crypto.createHash(hash).digest().length;
      const key = pkcs12Kdf(hash, pw.bmp, salt, 3, iterations, size);
      mac = crypto.createHmac(hash, key).update(authSafe).digest();
    }
    if (mac.length === expected.length && crypto.timingSafeEqual(mac, expected)) return pw;
  }
  return null;
}

function publicKeyDer(key: KeyObject): Buffer {
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
}

function sameIssuerSubject(child: crypto.X509Certificate, parent: crypto.X509Certificate): boolean {
  try {
    return child.checkIssued(parent) && child.verify(parent.publicKey);
  } catch {
    return false;
  }
}

/** Orders `certs` as a path starting at `leaf` (only certificates that chain are kept). */
function buildChain(leaf: Buffer, certs: Buffer[]): Buffer[] {
  const chain = [leaf];
  const pool = certs.filter((c) => !c.equals(leaf));
  let current = new crypto.X509Certificate(leaf);
  for (let i = 0; i < 10; i++) {
    if (current.subject === current.issuer && sameIssuerSubject(current, current)) break;
    const idx = pool.findIndex((c) => sameIssuerSubject(current, new crypto.X509Certificate(c)));
    if (idx < 0) break;
    const [next] = pool.splice(idx, 1);
    chain.push(next);
    current = new crypto.X509Certificate(next);
  }
  return chain;
}

/**
 * Opens a PKCS#12 file and returns the signing identity (private key + certificate path).
 * @throws P12Error (`BAD_PASSWORD`, `INVALID_FILE`, `NO_PRIVATE_KEY`, `NO_CERTIFICATE`,
 *   `UNSUPPORTED`)
 */
export function openP12(p12: Uint8Array, passphrase: string): P12Identity {
  let pfx: Asn1;
  let authSafe: Buffer;
  try {
    pfx = parseBer(asBuffer(p12));
    const contentInfo = child(pfx, 1, 'authSafe');
    if (oidOf(child(contentInfo, 0)) !== OID.data) {
      throw new P12Error('UNSUPPORTED', 'Public-key protected PKCS#12 files are not supported');
    }
    authSafe = octetsOf(child(child(contentInfo, 1, 'content'), 0, 'content'));
  } catch (e) {
    if (e instanceof P12Error) throw e;
    throw new P12Error('INVALID_FILE', 'Not a PKCS#12 file');
  }

  let candidates = passwords(passphrase);
  const macData = children(pfx)[2];
  if (macData) {
    let match: Passwords | null;
    try {
      match = verifyMac(macData, authSafe, candidates);
    } catch (e) {
      if (e instanceof P12Error) throw e;
      throw new P12Error('INVALID_FILE', 'Malformed PKCS#12 MAC');
    }
    if (!match) throw new P12Error('BAD_PASSWORD', 'Wrong passphrase');
    candidates = [match];
  }

  let lastError: unknown;
  for (const pw of candidates) {
    const keys: KeyEntry[] = [];
    const certs: CertEntry[] = [];
    try {
      for (const ci of children(parseBer(authSafe))) {
        const type = oidOf(child(ci, 0));
        const content = children(ci)[1];
        if (!content) continue;
        if (type === OID.data) {
          readSafeContents(octetsOf(child(content, 0)), pw, keys, certs);
        } else if (type === OID.encryptedData) {
          const encryptedContentInfo = child(child(content, 0), 1, 'encryptedContentInfo');
          const algorithm = child(encryptedContentInfo, 1, 'contentEncryptionAlgorithm');
          const encrypted = children(encryptedContentInfo)[2];
          if (!encrypted) continue;
          readSafeContents(decrypt(algorithm, octetsOf(encrypted), pw), pw, keys, certs);
        } else if (type === OID.envelopedData) {
          throw new P12Error('UNSUPPORTED', 'Public-key protected PKCS#12 files are not supported');
        }
      }
    } catch (e) {
      lastError = e;
      continue;
    }
    return selectIdentity(keys, certs);
  }
  if (lastError instanceof P12Error) throw lastError;
  throw new P12Error('INVALID_FILE', 'Malformed PKCS#12 contents');
}

function selectIdentity(keys: KeyEntry[], certs: CertEntry[]): P12Identity {
  if (keys.length === 0) throw new P12Error('NO_PRIVATE_KEY', 'The file has no private key');
  if (certs.length === 0) throw new P12Error('NO_CERTIFICATE', 'The file has no certificate');
  for (const k of keys) {
    const spki = publicKeyDer(k.key);
    const leaf =
      (k.localKeyId && certs.find((c) => c.localKeyId?.equals(k.localKeyId as Buffer))) ||
      certs.find((c) =>
        new crypto.X509Certificate(c.der).publicKey
          .export({ type: 'spki', format: 'der' })
          .equals(spki),
      );
    if (!leaf) continue;
    const type = k.key.asymmetricKeyType;
    if (type !== 'rsa' && type !== 'ec') {
      throw new P12Error('UNSUPPORTED', `Unsupported key type ${type}`);
    }
    const chainDer = buildChain(
      leaf.der,
      certs.map((c) => c.der),
    );
    let info: CertificateInfo;
    try {
      info = certificateInfo(leaf.der);
    } catch {
      throw new P12Error('INVALID_FILE', 'Unreadable certificate');
    }
    const identity: P12Identity = {
      privateKey: k.key,
      keyType: type,
      certificateDer: leaf.der,
      chainDer,
      info,
    };
    if (type === 'ec') {
      const curve = k.key.asymmetricKeyDetails?.namedCurve;
      identity.namedCurve =
        curve === 'prime256v1'
          ? 'P-256'
          : curve === 'secp384r1'
            ? 'P-384'
            : curve === 'secp521r1'
              ? 'P-521'
              : curve;
    }
    return identity;
  }
  throw new P12Error('NO_CERTIFICATE', 'No certificate matches the private key');
}

/**
 * Reads the certificate information of a .p12 (validating the passphrase).
 * @throws P12Error on a wrong passphrase or an invalid / unsupported file.
 */
export function readP12(p12: Uint8Array, passphrase: string): P12Contents {
  const { certificateDer, chainDer, info } = openP12(p12, passphrase);
  return { certificateDer, chainDer, info };
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

type P12KeyEncryption = 'aes-256-cbc' | 'pbeWithSHAAnd3-KeyTripleDES-CBC';
type P12CertEncryption =
  | 'aes-256-cbc'
  | 'pbeWithSHAAnd3-KeyTripleDES-CBC'
  | 'pbeWithSHAAnd40BitRC2-CBC'
  | 'none';

export interface EncodeP12Options {
  privateKey: KeyObject;
  /** End-entity certificate first, then the rest of the chain. */
  certificates: Uint8Array[];
  passphrase: string;
  friendlyName?: string;
  /** Default 'aes-256-cbc' (PBES2, PBKDF2-HMAC-SHA256), as OpenSSL 3 does. */
  keyEncryption?: P12KeyEncryption;
  /** Default 'aes-256-cbc'. Legacy values exist to produce test files like old exporters. */
  certEncryption?: P12CertEncryption;
  /** Default 'sha256'. */
  macAlgorithm?: 'sha1' | 'sha256';
  /** PBKDF2 / PBE / MAC iterations (default 2048, OpenSSL's default). */
  iterations?: number;
}

function encryptWith(
  method: Exclude<P12CertEncryption, 'none'>,
  data: Buffer,
  pw: Passwords,
  iterations: number,
): { algorithm: Asn1; encrypted: Buffer } {
  const salt = crypto.randomBytes(method === 'aes-256-cbc' ? 16 : 8);
  if (method === 'aes-256-cbc') {
    const iv = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(pw.utf8, salt, iterations, 32, 'sha256');
    const encrypted = nodeCipher('aes-256-cbc', key, iv, addPkcs7Padding(data, 16), true);
    const algorithm = seq(
      oid(OID.pbes2),
      seq(
        seq(
          oid(OID.pbkdf2),
          seq(octets(salt), int(iterations), seq(oid('1.2.840.113549.2.9'), nul())),
        ),
        seq(oid(OID.aes256cbc), octets(iv)),
      ),
    );
    return { algorithm, encrypted };
  }
  const algOid = method === 'pbeWithSHAAnd3-KeyTripleDES-CBC' ? OID.pbeSha1Des3 : OID.pbeSha1Rc2_40;
  const pbe = PKCS12_PBE[algOid];
  const key = pkcs12Kdf('sha1', pw.bmp, salt, 1, iterations, pbe.keyLength);
  const iv = pkcs12Kdf('sha1', pw.bmp, salt, 2, iterations, pbe.ivLength);
  const encrypted = pbe.run(key, iv, addPkcs7Padding(data, pbe.blockSize), true);
  return { algorithm: seq(oid(algOid), seq(octets(salt), int(iterations))), encrypted };
}

function attributes(localKeyId: Buffer, friendlyName?: string): Asn1 {
  const attrs = [seq(oid(OID.localKeyId), set(octets(localKeyId)))];
  if (friendlyName) attrs.push(seq(oid(OID.friendlyName), set(bmp(friendlyName))));
  return set(...attrs);
}

/** Builds a PKCS#12 file (RSA or EC key). Modern algorithms by default. */
export function encodeP12(options: EncodeP12Options): Buffer {
  const iterations = options.iterations ?? 2048;
  const [pw] = passwords(options.passphrase);
  const certs = options.certificates.map((c) => asBuffer(c));
  if (certs.length === 0) throw new P12Error('NO_CERTIFICATE', 'No certificate given');
  const localKeyId = crypto.createHash('sha1').update(certs[0]).digest();

  // Certificates
  const certBags = certs.map((der, i) =>
    i === 0
      ? seq(
          oid(OID.certBag),
          explicit(0, seq(oid(OID.x509Certificate), explicit(0, octets(der)))),
          attributes(localKeyId, options.friendlyName),
        )
      : seq(oid(OID.certBag), explicit(0, seq(oid(OID.x509Certificate), explicit(0, octets(der))))),
  );
  const certSafeContents = encodeDer(seq(...certBags));
  let certContentInfo: Asn1;
  const certEncryption = options.certEncryption ?? 'aes-256-cbc';
  if (certEncryption === 'none') {
    certContentInfo = seq(oid(OID.data), explicit(0, octets(certSafeContents)));
  } else {
    const { algorithm, encrypted } = encryptWith(certEncryption, certSafeContents, pw, iterations);
    certContentInfo = seq(
      oid(OID.encryptedData),
      explicit(0, seq(int(0), seq(oid(OID.data), algorithm, implicitOctets(0, encrypted)))),
    );
  }

  // Private key
  const pkcs8 = options.privateKey.export({ type: 'pkcs8', format: 'der' });
  const keyEnc = encryptWith(options.keyEncryption ?? 'aes-256-cbc', pkcs8, pw, iterations);
  const keyBag = seq(
    oid(OID.shroudedKeyBag),
    explicit(0, seq(keyEnc.algorithm, octets(keyEnc.encrypted))),
    attributes(localKeyId, options.friendlyName),
  );
  const keyContentInfo = seq(oid(OID.data), explicit(0, octets(encodeDer(seq(keyBag)))));

  const authSafe = encodeDer(seq(certContentInfo, keyContentInfo));

  // MAC
  const macHash = options.macAlgorithm ?? 'sha256';
  const macSalt = crypto.randomBytes(macHash === 'sha256' ? 16 : 8);
  const macKey = pkcs12Kdf(
    macHash,
    pw.bmp,
    macSalt,
    3,
    iterations,
    crypto.createHash(macHash).digest().length,
  );
  const mac = crypto.createHmac(macHash, macKey).update(authSafe).digest();
  const macData = seq(
    seq(seq(oid(OID_BY_HASH[macHash]), nul()), octets(mac)),
    octets(macSalt),
    int(iterations),
  );

  return encodeDer(seq(int(3), seq(oid(OID.data), explicit(0, octets(authSafe))), macData));
}
