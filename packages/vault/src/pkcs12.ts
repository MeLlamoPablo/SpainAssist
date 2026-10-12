/**
 * PKCS#12 (.p12 / .pfx) reader and writer built on Node's crypto, so it handles any key type
 * Node does (RSA, RSA-PSS, ECDSA P-256/P-384/P-521, Ed25519). FNMT issues ECDSA certificates
 * since late 2025, which node-forge cannot read; node-forge is only used for the legacy RC2
 * cipher (OpenSSL 3 moved RC2 to its "legacy" provider, so Node cannot decrypt it).
 *
 * Supported when reading:
 *  - integrity: HMAC with the PKCS#12 KDF (SHA-1/224/256/384/512) and PBMAC1 (RFC 9579);
 *  - privacy: PBES2 (PBKDF2 + AES-128/192/256-CBC or 3DES-CBC) and the PKCS#12 PBEs
 *    pbeWithSHAAnd3-KeyTripleDES-CBC, pbeWithSHAAnd2-KeyTripleDES-CBC, pbeWithSHAAnd128BitRC2-CBC
 *    and pbewithSHAAnd40BitRC2-CBC;
 *  - BER encodings (indefinite lengths, constructed strings), nested SafeContents bags.
 * Not supported: public-key integrity/privacy modes and the RC4 PBEs (never seen in the wild
 * for personal certificates).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  type KeyObject,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import type forgeType from 'node-forge';
import {
  Asn1Error,
  type Asn1Node,
  der,
  explicit,
  isContext,
  isUniversal,
  parseAsn1,
  readOctets,
  readOid,
  readSmallInt,
  readString,
  sequence,
  TAG,
} from './der';

export const OID = {
  data: '1.2.840.113549.1.7.1',
  envelopedData: '1.2.840.113549.1.7.3',
  encryptedData: '1.2.840.113549.1.7.6',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  pkcs8ShroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  safeContentsBag: '1.2.840.113549.1.12.10.1.6',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  friendlyName: '1.2.840.113549.1.9.20',
  localKeyId: '1.2.840.113549.1.9.21',
  pbeSha1TripleDes3: '1.2.840.113549.1.12.1.3',
  pbeSha1TripleDes2: '1.2.840.113549.1.12.1.4',
  pbeSha1Rc2_128: '1.2.840.113549.1.12.1.5',
  pbeSha1Rc2_40: '1.2.840.113549.1.12.1.6',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  pbmac1: '1.2.840.113549.1.5.14',
  hmacWithSha1: '1.2.840.113549.2.7',
  hmacWithSha224: '1.2.840.113549.2.8',
  hmacWithSha256: '1.2.840.113549.2.9',
  hmacWithSha384: '1.2.840.113549.2.10',
  hmacWithSha512: '1.2.840.113549.2.11',
  aes128cbc: '2.16.840.1.101.3.4.1.2',
  aes192cbc: '2.16.840.1.101.3.4.1.22',
  aes256cbc: '2.16.840.1.101.3.4.1.42',
  desEde3Cbc: '1.2.840.113549.3.7',
  sha1: '1.3.14.3.2.26',
  sha224: '2.16.840.1.101.3.4.2.4',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
} as const;

interface HashInfo {
  name: string;
  /** Output length (bytes). */
  size: number;
  /** Block length (bytes), the "v" of the PKCS#12 KDF. */
  block: number;
}

const SHA1: HashInfo = { name: 'sha1', size: 20, block: 64 };
const SHA256: HashInfo = { name: 'sha256', size: 32, block: 64 };
const DIGESTS: Record<string, HashInfo> = {
  [OID.sha1]: SHA1,
  [OID.sha224]: { name: 'sha224', size: 28, block: 64 },
  [OID.sha256]: SHA256,
  [OID.sha384]: { name: 'sha384', size: 48, block: 128 },
  [OID.sha512]: { name: 'sha512', size: 64, block: 128 },
};
const HMAC_PRFS: Record<string, HashInfo> = {
  [OID.hmacWithSha1]: SHA1,
  [OID.hmacWithSha224]: DIGESTS[OID.sha224]!,
  [OID.hmacWithSha256]: SHA256,
  [OID.hmacWithSha384]: DIGESTS[OID.sha384]!,
  [OID.hmacWithSha512]: DIGESTS[OID.sha512]!,
};

interface CipherSpec {
  name: 'aes-128-cbc' | 'aes-192-cbc' | 'aes-256-cbc' | 'des-ede3-cbc' | 'rc2';
  keyLength: number;
  ivLength: number;
  rc2Bits?: number;
}
const PBES2_CIPHERS: Record<string, CipherSpec> = {
  [OID.aes128cbc]: { name: 'aes-128-cbc', keyLength: 16, ivLength: 16 },
  [OID.aes192cbc]: { name: 'aes-192-cbc', keyLength: 24, ivLength: 16 },
  [OID.aes256cbc]: { name: 'aes-256-cbc', keyLength: 32, ivLength: 16 },
  [OID.desEde3Cbc]: { name: 'des-ede3-cbc', keyLength: 24, ivLength: 8 },
};
const PKCS12_PBES: Record<string, CipherSpec> = {
  [OID.pbeSha1TripleDes3]: { name: 'des-ede3-cbc', keyLength: 24, ivLength: 8 },
  // Two-key 3DES is three-key 3DES with K3 = K1 (expanded below).
  [OID.pbeSha1TripleDes2]: { name: 'des-ede3-cbc', keyLength: 16, ivLength: 8 },
  [OID.pbeSha1Rc2_128]: { name: 'rc2', keyLength: 16, ivLength: 8, rc2Bits: 128 },
  [OID.pbeSha1Rc2_40]: { name: 'rc2', keyLength: 5, ivLength: 8, rc2Bits: 40 },
};

/** Upper bound for iteration counts, so a hostile file cannot hang the main process. */
const MAX_ITERATIONS = 10_000_000;

export type Pkcs12ErrorCode =
  | 'invalid_passphrase'
  | 'invalid_format'
  | 'unsupported'
  | 'no_private_key'
  | 'no_certificate'
  | 'key_mismatch';

export class Pkcs12Error extends Error {
  override readonly name = 'Pkcs12Error';
  constructor(
    readonly code: Pkcs12ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface Pkcs12Contents {
  privateKey: KeyObject;
  /** The certificate that matches the private key. */
  certificate: X509Certificate;
  /** Other certificates in the file, issuer chain first. */
  chain: X509Certificate[];
  friendlyName?: string;
}

// ---------------------------------------------------------------------------------------------
// Password encodings
// ---------------------------------------------------------------------------------------------

/** PKCS#12 passwords are BMPStrings (UTF-16BE) with a two-byte NUL terminator. */
function bmpPassword(password: string, terminator: boolean): Buffer {
  const out = Buffer.alloc((password.length + (terminator ? 1 : 0)) * 2);
  for (let i = 0; i < password.length; i++) out.writeUInt16BE(password.charCodeAt(i), i * 2);
  return out;
}

function uniqueBuffers(list: Buffer[]): Buffer[] {
  return list.filter((b, i) => list.findIndex((o) => o.equals(b)) === i);
}

class PasswordForms {
  /** Encodings for the PKCS#12 KDF (MAC and PKCS#12 PBEs). Reordered once the MAC matches. */
  pkcs12: Buffer[];
  /**
   * Encodings for PBKDF2 (PBES2, PBMAC1). OpenSSL/BoringSSL use UTF-8; some producers used
   * Latin-1 or UTF-16, which only matters for non-ASCII passphrases.
   */
  readonly pbkdf2: Buffer[];

  constructor(password: string) {
    this.pkcs12 =
      password === '' ? [Buffer.alloc(2), Buffer.alloc(0)] : [bmpPassword(password, true)];
    const forms: Buffer[] = [Buffer.from(password, 'utf8')];
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range check
    if (/[^\x00-\x7f]/.test(password)) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Latin-1 range check
      if (/^[\x00-\xff]*$/.test(password)) forms.push(Buffer.from(password, 'latin1'));
      forms.push(bmpPassword(password, false), bmpPassword(password, true));
    }
    this.pbkdf2 = uniqueBuffers(forms);
  }

  preferPkcs12(form: Buffer): void {
    this.pkcs12 = [form, ...this.pkcs12.filter((f) => !f.equals(form))];
  }
}

// ---------------------------------------------------------------------------------------------
// Key derivation and ciphers
// ---------------------------------------------------------------------------------------------

function checkIterations(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > MAX_ITERATIONS) {
    throw new Pkcs12Error('unsupported', `Unsupported iteration count ${n}`);
  }
  return n;
}

/** RFC 7292 Appendix B.2: the PKCS#12 key derivation function. `id`: 1 key, 2 IV, 3 MAC key. */
function pkcs12Kdf(
  hash: HashInfo,
  password: Buffer,
  salt: Buffer,
  id: 1 | 2 | 3,
  iterations: number,
  length: number,
): Buffer {
  const v = hash.block;
  const fill = (src: Buffer): Buffer => {
    if (src.length === 0) return Buffer.alloc(0);
    const out = Buffer.alloc(v * Math.ceil(src.length / v));
    for (let i = 0; i < out.length; i++) out[i] = src[i % src.length]!;
    return out;
  };
  const D = Buffer.alloc(v, id);
  const I = Buffer.concat([fill(salt), fill(password)]);
  const blocks = Math.ceil(length / hash.size);
  const out = Buffer.alloc(blocks * hash.size);
  for (let i = 0; i < blocks; i++) {
    let A = createHash(hash.name).update(D).update(I).digest();
    for (let j = 1; j < iterations; j++) A = createHash(hash.name).update(A).digest();
    A.copy(out, i * hash.size);
    if (i + 1 < blocks) {
      const B = fill(A);
      for (let j = 0; j < I.length; j += v) {
        let carry = 1;
        for (let k = v - 1; k >= 0; k--) {
          const sum = I[j + k]! + B[k]! + carry;
          I[j + k] = sum & 0xff;
          carry = sum >>> 8;
        }
      }
    }
  }
  return out.subarray(0, length);
}

let forgePromise: Promise<typeof forgeType> | undefined;
function loadForge(): Promise<typeof forgeType> {
  forgePromise ??= import('node-forge').then(
    (m) => ((m as { default?: typeof forgeType }).default ?? m) as typeof forgeType,
  );
  return forgePromise;
}

function unpadPkcs7(data: Buffer, blockSize: number): Buffer {
  const n = data[data.length - 1];
  if (data.length === 0 || data.length % blockSize !== 0 || !n || n > blockSize) {
    throw new Error('Bad padding');
  }
  for (let i = 1; i <= n; i++) if (data[data.length - i] !== n) throw new Error('Bad padding');
  return data.subarray(0, data.length - n);
}

async function rc2(
  encrypt: boolean,
  key: Buffer,
  iv: Buffer,
  bits: number,
  data: Buffer,
): Promise<Buffer> {
  const forge = await loadForge();
  const buffer = (b: Buffer) => forge.util.createBuffer(b.toString('binary'));
  const cipher = encrypt
    ? forge.rc2.createEncryptionCipher(buffer(key), bits)
    : forge.rc2.createDecryptionCipher(buffer(key), bits);
  cipher.start(buffer(iv));
  cipher.update(buffer(data));
  // In decrypt mode, a no-op pad function returns the raw blocks: we unpad strictly ourselves.
  const ok = encrypt ? cipher.finish() : cipher.finish(() => true);
  if (!ok) throw new Error('RC2 failed');
  const out = Buffer.from(cipher.output.getBytes(), 'binary');
  return encrypt ? out : unpadPkcs7(out, 8);
}

async function runCipher(
  spec: CipherSpec,
  encrypt: boolean,
  key: Buffer,
  iv: Buffer,
  data: Buffer,
): Promise<Buffer> {
  if (spec.name === 'rc2') return rc2(encrypt, key, iv, spec.rc2Bits ?? 128, data);
  const k =
    spec.name === 'des-ede3-cbc' && key.length === 16
      ? Buffer.concat([key, key.subarray(0, 8)])
      : key;
  const c = encrypt ? createCipheriv(spec.name, k, iv) : createDecipheriv(spec.name, k, iv);
  return Buffer.concat([c.update(data), c.final()]);
}

interface Pbkdf2Params {
  salt: Buffer;
  iterations: number;
  keyLength?: number;
  prf: HashInfo;
}

function parsePbkdf2Params(node: Asn1Node | undefined): Pbkdf2Params {
  const items = sequence(node, 'PBKDF2-params');
  if (!isUniversal(items[0], TAG.OCTET_STRING)) {
    throw new Pkcs12Error('unsupported', 'Unsupported PBKDF2 salt source');
  }
  const salt = readOctets(items[0]);
  const iterations = checkIterations(readSmallInt(items[1]));
  let index = 2;
  let keyLength: number | undefined;
  if (isUniversal(items[index], TAG.INTEGER)) keyLength = readSmallInt(items[index++]);
  let prf = SHA1;
  const prfNode = items[index];
  if (prfNode) {
    const prfOid = readOid(sequence(prfNode, 'PBKDF2 PRF')[0]);
    const found = HMAC_PRFS[prfOid];
    if (!found) throw new Pkcs12Error('unsupported', `Unsupported PBKDF2 PRF ${prfOid}`);
    prf = found;
  }
  return { salt, iterations, keyLength, prf };
}

interface Decryptor {
  /** Decryption attempts, one per plausible password encoding. */
  attempts: Array<() => Promise<Buffer>>;
}

function decryptor(
  algorithm: Asn1Node | undefined,
  ciphertext: Buffer,
  passwords: PasswordForms,
): Decryptor {
  const alg = sequence(algorithm, 'AlgorithmIdentifier');
  const oid = readOid(alg[0]);
  if (oid === OID.pbes2) {
    const [kdfNode, encNode] = sequence(alg[1], 'PBES2-params');
    const kdf = sequence(kdfNode, 'PBES2 key derivation function');
    if (readOid(kdf[0]) !== OID.pbkdf2) {
      throw new Pkcs12Error('unsupported', 'Unsupported PBES2 key derivation function');
    }
    const params = parsePbkdf2Params(kdf[1]);
    const enc = sequence(encNode, 'PBES2 encryption scheme');
    const encOid = readOid(enc[0]);
    const spec = PBES2_CIPHERS[encOid];
    if (!spec) throw new Pkcs12Error('unsupported', `Unsupported PBES2 cipher ${encOid}`);
    const iv = readOctets(enc[1]);
    if (iv.length !== spec.ivLength) throw new Asn1Error('Invalid PBES2 IV');
    if (params.keyLength !== undefined && params.keyLength !== spec.keyLength) {
      throw new Asn1Error('PBKDF2 key length does not match the cipher');
    }
    return {
      attempts: passwords.pbkdf2.map((password) => async () => {
        const key = pbkdf2Sync(
          password,
          params.salt,
          params.iterations,
          spec.keyLength,
          params.prf.name,
        );
        return runCipher(spec, false, key, iv, ciphertext);
      }),
    };
  }
  const spec = PKCS12_PBES[oid];
  if (!spec) throw new Pkcs12Error('unsupported', `Unsupported encryption algorithm ${oid}`);
  const [saltNode, iterNode] = sequence(alg[1], 'PKCS#12 PBE parameters');
  const salt = readOctets(saltNode);
  const iterations = checkIterations(readSmallInt(iterNode));
  return {
    attempts: passwords.pkcs12.map((password) => async () => {
      const key = pkcs12Kdf(SHA1, password, salt, 1, iterations, spec.keyLength);
      const iv = pkcs12Kdf(SHA1, password, salt, 2, iterations, spec.ivLength);
      return runCipher(spec, false, key, iv, ciphertext);
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

interface BagAttributes {
  friendlyName?: string;
  localKeyId?: Buffer;
}

interface ReadContext {
  passwords: PasswordForms;
  macVerified: boolean;
  keys: Array<{ key: KeyObject } & BagAttributes>;
  certs: Array<{ cert: X509Certificate } & BagAttributes>;
}

/** Parses and decrypts a PKCS#12 file. Throws `Pkcs12Error`. */
export async function readPkcs12(input: Uint8Array, passphrase: string): Promise<Pkcs12Contents> {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let pfx: Asn1Node;
  try {
    pfx = parseAsn1(bytes);
  } catch (e) {
    throw new Pkcs12Error('invalid_format', 'Not a PKCS#12 file', { cause: e });
  }
  try {
    return await readPfx(pfx, passphrase);
  } catch (e) {
    if (e instanceof Pkcs12Error) throw e;
    throw new Pkcs12Error('invalid_format', 'Malformed PKCS#12 file', { cause: e });
  }
}

async function readPfx(pfx: Asn1Node, passphrase: string): Promise<Pkcs12Contents> {
  const [versionNode, authSafeNode, macDataNode] = sequence(pfx, 'PFX');
  const version = readSmallInt(versionNode);
  if (version !== 3) throw new Pkcs12Error('unsupported', `Unsupported PKCS#12 version ${version}`);
  const authSafe = sequence(authSafeNode, 'authSafe ContentInfo');
  if (readOid(authSafe[0]) !== OID.data) {
    throw new Pkcs12Error(
      'unsupported',
      'PKCS#12 files with public-key integrity are not supported',
    );
  }
  const authSafeContent = readOctets(explicit(authSafe[1], 0, 'authSafe content'));
  const ctx: ReadContext = {
    passwords: new PasswordForms(passphrase),
    macVerified: false,
    keys: [],
    certs: [],
  };
  if (macDataNode) {
    verifyMac(macDataNode, authSafeContent, ctx.passwords);
    ctx.macVerified = true;
  }
  for (const info of sequence(parseAsn1(authSafeContent), 'AuthenticatedSafe')) {
    await readContentInfo(info, ctx);
  }
  return pickLeaf(ctx);
}

function verifyMac(macData: Asn1Node, content: Buffer, passwords: PasswordForms): void {
  const [digestInfo, saltNode, iterNode] = sequence(macData, 'MacData');
  const [algNode, digestNode] = sequence(digestInfo, 'DigestInfo');
  const alg = sequence(algNode, 'MAC algorithm');
  const oid = readOid(alg[0]);
  const expected = readOctets(digestNode);
  const matches = (mac: Buffer) => mac.length === expected.length && timingSafeEqual(mac, expected);

  if (oid === OID.pbmac1) {
    // RFC 9579: the MAC key comes from PBKDF2; MacData.macSalt/iterations are ignored.
    const [kdfNode, schemeNode] = sequence(alg[1], 'PBMAC1-params');
    const kdf = sequence(kdfNode, 'PBMAC1 key derivation function');
    if (readOid(kdf[0]) !== OID.pbkdf2) {
      throw new Pkcs12Error('unsupported', 'Unsupported PBMAC1 key derivation function');
    }
    const params = parsePbkdf2Params(kdf[1]);
    const schemeOid = readOid(sequence(schemeNode, 'PBMAC1 scheme')[0]);
    const hmac = HMAC_PRFS[schemeOid];
    if (!hmac) throw new Pkcs12Error('unsupported', `Unsupported PBMAC1 MAC ${schemeOid}`);
    if (!params.keyLength) throw new Asn1Error('PBMAC1 requires a key length');
    for (const password of passwords.pbkdf2) {
      const key = pbkdf2Sync(
        password,
        params.salt,
        params.iterations,
        params.keyLength,
        params.prf.name,
      );
      if (matches(createHmac(hmac.name, key).update(content).digest())) return;
    }
    throw new Pkcs12Error('invalid_passphrase', 'Wrong passphrase (MAC mismatch)');
  }

  const hash = DIGESTS[oid];
  if (!hash) throw new Pkcs12Error('unsupported', `Unsupported MAC digest ${oid}`);
  const salt = readOctets(saltNode);
  const iterations = checkIterations(iterNode ? readSmallInt(iterNode) : 1);
  for (const password of passwords.pkcs12) {
    const key = pkcs12Kdf(hash, password, salt, 3, iterations, hash.size);
    if (matches(createHmac(hash.name, key).update(content).digest())) {
      passwords.preferPkcs12(password);
      return;
    }
  }
  throw new Pkcs12Error('invalid_passphrase', 'Wrong passphrase (MAC mismatch)');
}

async function decrypt<T>(
  algorithm: Asn1Node | undefined,
  ciphertext: Buffer,
  ctx: ReadContext,
  validate: (plain: Buffer) => T,
): Promise<T> {
  const { attempts } = decryptor(algorithm, ciphertext, ctx.passwords);
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return validate(await attempt());
    } catch (e) {
      lastError = e;
    }
  }
  // Without a MAC, a failed decryption is the only sign of a wrong passphrase.
  throw ctx.macVerified
    ? new Pkcs12Error('invalid_format', 'Could not decrypt the PKCS#12 contents', {
        cause: lastError,
      })
    : new Pkcs12Error('invalid_passphrase', 'Wrong passphrase', { cause: lastError });
}

async function readContentInfo(info: Asn1Node, ctx: ReadContext): Promise<void> {
  const [typeNode, contentNode] = sequence(info, 'ContentInfo');
  const type = readOid(typeNode);
  if (type === OID.data) {
    await readSafeContents(parseAsn1(readOctets(explicit(contentNode, 0, 'data'))), ctx);
    return;
  }
  if (type === OID.encryptedData) {
    const encryptedData = sequence(explicit(contentNode, 0, 'EncryptedData'), 'EncryptedData');
    const eci = sequence(encryptedData[1], 'EncryptedContentInfo');
    if (!isContext(eci[2], 0)) throw new Asn1Error('Missing encrypted content');
    const safeContents = await decrypt(eci[1], readOctets(eci[2], true), ctx, (plain) => {
      const node = parseAsn1(plain);
      for (const bag of sequence(node, 'SafeContents')) readOid(sequence(bag, 'SafeBag')[0]);
      return node;
    });
    await readSafeContents(safeContents, ctx);
    return;
  }
  if (type === OID.envelopedData) {
    throw new Pkcs12Error('unsupported', 'PKCS#12 files with public-key privacy are not supported');
  }
  throw new Pkcs12Error('unsupported', `Unsupported PKCS#12 content type ${type}`);
}

function readAttributes(node: Asn1Node | undefined): BagAttributes {
  const out: BagAttributes = {};
  if (!node) return out;
  for (const attribute of sequence(node, 'bag attributes', TAG.SET)) {
    const [idNode, valuesNode] = sequence(attribute, 'attribute');
    const id = readOid(idNode);
    const value = sequence(valuesNode, 'attribute values', TAG.SET)[0];
    try {
      if (id === OID.friendlyName && value) out.friendlyName = readString(value);
      if (id === OID.localKeyId && value) out.localKeyId = readOctets(value);
    } catch {
      // Ignore malformed optional attributes.
    }
  }
  return out;
}

function toPrivateKey(pkcs8: Buffer): KeyObject {
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}

async function readSafeContents(node: Asn1Node, ctx: ReadContext): Promise<void> {
  for (const bag of sequence(node, 'SafeContents')) {
    const [idNode, valueNode, attrsNode] = sequence(bag, 'SafeBag');
    const bagId = readOid(idNode);
    const value = explicit(valueNode, 0, 'bag value');
    const attributes = readAttributes(attrsNode);
    if (bagId === OID.keyBag) {
      ctx.keys.push({ key: toPrivateKey(Buffer.from(value.raw)), ...attributes });
    } else if (bagId === OID.pkcs8ShroudedKeyBag) {
      const [algNode, dataNode] = sequence(value, 'EncryptedPrivateKeyInfo');
      const key = await decrypt(algNode, readOctets(dataNode), ctx, toPrivateKey);
      ctx.keys.push({ key, ...attributes });
    } else if (bagId === OID.certBag) {
      const [typeNode, certNode] = sequence(value, 'CertBag');
      if (readOid(typeNode) !== OID.x509Certificate) continue;
      const certDer = readOctets(explicit(certNode, 0, 'certificate'));
      ctx.certs.push({ cert: new X509Certificate(certDer), ...attributes });
    } else if (bagId === OID.safeContentsBag) {
      await readSafeContents(value, ctx);
    }
    // CRL and secret bags are ignored.
  }
}

function matchesKey(cert: X509Certificate, key: KeyObject): boolean {
  try {
    return cert.checkPrivateKey(key);
  } catch {
    return false;
  }
}

function pickLeaf(ctx: ReadContext): Pkcs12Contents {
  if (ctx.keys.length === 0) throw new Pkcs12Error('no_private_key', 'The file has no private key');
  if (ctx.certs.length === 0)
    throw new Pkcs12Error('no_certificate', 'The file has no certificate');
  for (const key of ctx.keys) {
    const leaf = ctx.certs.find((c) => matchesKey(c.cert, key.key));
    if (!leaf) continue;
    const others = ctx.certs.filter((c) => c !== leaf).map((c) => c.cert);
    return {
      privateKey: key.key,
      certificate: leaf.cert,
      chain: orderChain(leaf.cert, others),
      friendlyName: leaf.friendlyName ?? key.friendlyName,
    };
  }
  throw new Pkcs12Error('key_mismatch', 'The private key does not match any certificate');
}

/** Orders certificates from the leaf's issuer up to the root; unrelated ones go last. */
function orderChain(leaf: X509Certificate, others: X509Certificate[]): X509Certificate[] {
  const remaining = [...others];
  const chain: X509Certificate[] = [];
  let current = leaf;
  for (;;) {
    const index = remaining.findIndex((c) => current.checkIssued(c));
    if (index < 0) break;
    const [next] = remaining.splice(index, 1);
    chain.push(next!);
    if (next!.checkIssued(next!)) break; // self-signed root
    current = next!;
  }
  return [...chain, ...remaining];
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

export type Pkcs12Encryption = 'aes-256-cbc' | 'pbe-sha1-3des' | 'pbe-sha1-rc2-40' | 'none';

export interface WritePkcs12Options {
  privateKey: KeyObject;
  certificate: X509Certificate;
  chain?: X509Certificate[];
  passphrase: string;
  friendlyName?: string;
  /** Default 'aes-256-cbc' (PBES2, PBKDF2-HMAC-SHA256), like `openssl pkcs12 -export` (3.x). */
  keyEncryption?: Pkcs12Encryption;
  /** Default 'aes-256-cbc'. Legacy values exist to build test fixtures. */
  certEncryption?: Pkcs12Encryption;
  /** Default 'sha256'. */
  mac?: 'sha256' | 'sha1' | 'none';
  /** PBKDF2 / KDF iterations. Default 2048 (OpenSSL's default). */
  iterations?: number;
}

async function encryptPayload(
  encryption: Exclude<Pkcs12Encryption, 'none'>,
  plain: Buffer,
  passphrase: string,
  iterations: number,
): Promise<{ algorithm: Buffer; ciphertext: Buffer }> {
  if (encryption === 'aes-256-cbc') {
    const salt = randomBytes(16);
    const iv = randomBytes(16);
    const key = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iterations, 32, 'sha256');
    const algorithm = der.sequence(
      der.oid(OID.pbes2),
      der.sequence(
        der.sequence(
          der.oid(OID.pbkdf2),
          der.sequence(
            der.octets(salt),
            der.integer(iterations),
            der.sequence(der.oid(OID.hmacWithSha256), der.null()),
          ),
        ),
        der.sequence(der.oid(OID.aes256cbc), der.octets(iv)),
      ),
    );
    const ciphertext = await runCipher(PBES2_CIPHERS[OID.aes256cbc]!, true, key, iv, plain);
    return { algorithm, ciphertext };
  }
  const oid = encryption === 'pbe-sha1-3des' ? OID.pbeSha1TripleDes3 : OID.pbeSha1Rc2_40;
  const spec = PKCS12_PBES[oid]!;
  const salt = randomBytes(8);
  const password = bmpPassword(passphrase, true);
  const key = pkcs12Kdf(SHA1, password, salt, 1, iterations, spec.keyLength);
  const iv = pkcs12Kdf(SHA1, password, salt, 2, iterations, spec.ivLength);
  const algorithm = der.sequence(
    der.oid(oid),
    der.sequence(der.octets(salt), der.integer(iterations)),
  );
  return { algorithm, ciphertext: await runCipher(spec, true, key, iv, plain) };
}

function dataContentInfo(content: Buffer): Buffer {
  return der.sequence(der.oid(OID.data), der.explicit(0, der.octets(content)));
}

/** Builds a PKCS#12 file. Output defaults match `openssl pkcs12 -export` in OpenSSL 3. */
export async function writePkcs12(options: WritePkcs12Options): Promise<Buffer> {
  const iterations = checkIterations(options.iterations ?? 2048);
  const keyEncryption = options.keyEncryption ?? 'aes-256-cbc';
  const certEncryption = options.certEncryption ?? 'aes-256-cbc';
  const mac = options.mac ?? 'sha256';

  const localKeyId = createHash('sha1').update(options.certificate.raw).digest();
  const leafAttributes = der.set(
    der.sequence(der.oid(OID.localKeyId), der.set(der.octets(localKeyId))),
    ...(options.friendlyName
      ? [der.sequence(der.oid(OID.friendlyName), der.set(der.bmp(options.friendlyName)))]
      : []),
  );

  const pkcs8 = options.privateKey.export({ type: 'pkcs8', format: 'der' });
  let keyBag: Buffer;
  if (keyEncryption === 'none') {
    keyBag = der.sequence(der.oid(OID.keyBag), der.explicit(0, pkcs8), leafAttributes);
  } else {
    const { algorithm, ciphertext } = await encryptPayload(
      keyEncryption,
      pkcs8,
      options.passphrase,
      iterations,
    );
    keyBag = der.sequence(
      der.oid(OID.pkcs8ShroudedKeyBag),
      der.explicit(0, der.sequence(algorithm, der.octets(ciphertext))),
      leafAttributes,
    );
  }

  const certBags = [options.certificate, ...(options.chain ?? [])].map((cert, i) =>
    der.sequence(
      der.oid(OID.certBag),
      der.explicit(
        0,
        der.sequence(der.oid(OID.x509Certificate), der.explicit(0, der.octets(cert.raw))),
      ),
      ...(i === 0 ? [leafAttributes] : []),
    ),
  );
  const certContents = der.sequence(...certBags);
  let certInfo: Buffer;
  if (certEncryption === 'none') {
    certInfo = dataContentInfo(certContents);
  } else {
    const { algorithm, ciphertext } = await encryptPayload(
      certEncryption,
      certContents,
      options.passphrase,
      iterations,
    );
    certInfo = der.sequence(
      der.oid(OID.encryptedData),
      der.explicit(
        0,
        der.sequence(
          der.integer(0),
          der.sequence(der.oid(OID.data), algorithm, der.implicitPrimitive(0, ciphertext)),
        ),
      ),
    );
  }

  const authSafe = der.sequence(certInfo, dataContentInfo(der.sequence(keyBag)));
  const parts = [der.integer(3), dataContentInfo(authSafe)];
  if (mac !== 'none') {
    const hash = mac === 'sha1' ? SHA1 : SHA256;
    const salt = randomBytes(16);
    const key = pkcs12Kdf(
      hash,
      bmpPassword(options.passphrase, true),
      salt,
      3,
      iterations,
      hash.size,
    );
    const digest = createHmac(hash.name, key).update(authSafe).digest();
    parts.push(
      der.sequence(
        der.sequence(
          der.sequence(der.oid(mac === 'sha1' ? OID.sha1 : OID.sha256), der.null()),
          der.octets(digest),
        ),
        der.octets(salt),
        der.integer(iterations),
      ),
    );
  }
  return der.sequence(...parts);
}
