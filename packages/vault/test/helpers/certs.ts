/**
 * Test-only X.509 certificate builder (RSA and ECDSA) on top of the vault's DER writer and
 * Node's crypto. All material is synthetic.
 */
import {
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  X509Certificate,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { der } from '../../src/der';

export const ATTR = {
  CN: '2.5.4.3',
  SN: '2.5.4.4',
  SERIALNUMBER: '2.5.4.5',
  C: '2.5.4.6',
  O: '2.5.4.10',
  OU: '2.5.4.11',
  GN: '2.5.4.42',
} as const;

export type NameSpec = Array<[oid: string, value: string]>;

function encodeName(name: NameSpec): Buffer {
  return der.sequence(
    ...name.map(([oid, value]) =>
      der.set(
        der.sequence(
          der.oid(oid),
          oid === ATTR.C || oid === ATTR.SERIALNUMBER ? der.printable(value) : der.utf8(value),
        ),
      ),
    ),
  );
}

export interface KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

const rsaKeyPair = (bits = 2048): KeyPair => generateKeyPairSync('rsa', { modulusLength: bits });
const ecKeyPair = (curve: 'P-256' | 'P-384' = 'P-256'): KeyPair =>
  generateKeyPairSync('ec', { namedCurve: curve });

function signatureAlgorithm(key: KeyObject): { hash: string; id: Buffer } {
  if (key.asymmetricKeyType === 'rsa') {
    return { hash: 'sha256', id: der.sequence(der.oid('1.2.840.113549.1.1.11'), der.null()) };
  }
  if (key.asymmetricKeyType === 'ec') {
    const big = key.asymmetricKeyDetails?.namedCurve !== 'prime256v1';
    return {
      hash: big ? 'sha384' : 'sha256',
      id: der.sequence(der.oid(big ? '1.2.840.10045.4.3.3' : '1.2.840.10045.4.3.2')),
    };
  }
  throw new Error(`Unsupported key type ${key.asymmetricKeyType}`);
}

export interface CertOptions {
  subject: NameSpec;
  /** Defaults to the subject (self-signed). */
  issuer?: NameSpec;
  publicKey: KeyObject;
  /** The issuer's private key. */
  signingKey: KeyObject;
  notBefore?: Date;
  notAfter?: Date;
  ca?: boolean;
}

function makeCertificate(options: CertOptions): X509Certificate {
  const notBefore = options.notBefore ?? new Date(Date.now() - 24 * 3600_000);
  const notAfter = options.notAfter ?? new Date(Date.now() + 365 * 24 * 3600_000);
  const serial = randomBytes(12);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const algorithm = signatureAlgorithm(options.signingKey);
  const basicConstraints = der.sequence(
    der.oid('2.5.29.19'),
    der.boolean(true),
    der.octets(der.sequence(...(options.ca ? [der.boolean(true)] : []))),
  );
  const tbs = der.sequence(
    der.explicit(0, der.integer(2)),
    der.integer(serial),
    algorithm.id,
    encodeName(options.issuer ?? options.subject),
    der.sequence(der.time(notBefore), der.time(notAfter)),
    encodeName(options.subject),
    options.publicKey.export({ type: 'spki', format: 'der' }),
    der.explicit(3, der.sequence(basicConstraints)),
  );
  const signature = sign(algorithm.hash, tbs, options.signingKey);
  return new X509Certificate(der.sequence(tbs, algorithm.id, der.bitString(signature)));
}

const CA_NAME: NameSpec = [
  [ATTR.C, 'ES'],
  [ATTR.O, 'SPAINASSISTANT TEST'],
  [ATTR.CN, 'AC TEST'],
];

const CARMEN: NameSpec = [
  [ATTR.C, 'ES'],
  [ATTR.SERIALNUMBER, 'IDCES-99999999R'],
  [ATTR.SN, 'ESPAÑOLA ESPAÑOLA'],
  [ATTR.GN, 'CARMEN'],
  [ATTR.CN, 'ESPAÑOLA ESPAÑOLA CARMEN - 99999999R'],
];

/** A CA plus a leaf issued by it. */
export function makeChain(
  kind: 'rsa' | 'ec256' | 'ec384',
  leaf: Partial<CertOptions> & { subject?: NameSpec } = {},
): { ca: X509Certificate; caKey: KeyPair; leaf: X509Certificate; key: KeyPair } {
  const keyPair = () =>
    kind === 'rsa' ? rsaKeyPair() : ecKeyPair(kind === 'ec256' ? 'P-256' : 'P-384');
  const caKey = keyPair();
  const ca = makeCertificate({
    subject: CA_NAME,
    publicKey: caKey.publicKey,
    signingKey: caKey.privateKey,
    ca: true,
    notBefore: new Date('2025-01-01T00:00:00Z'),
    notAfter: new Date('2055-01-01T00:00:00Z'),
  });
  const key = keyPair();
  const cert = makeCertificate({
    subject: CARMEN,
    issuer: CA_NAME,
    publicKey: key.publicKey,
    signingKey: caKey.privateKey,
    ...leaf,
  });
  return { ca, caKey, leaf: cert, key };
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const fixture = (name: string): Buffer => readFileSync(join(fixturesDir, name));
export const FIXTURE_PASSPHRASE = 'Fixture-1234';
export const FIXTURE_NONASCII_PASSPHRASE = 'Contraseña-Ñ€1';
