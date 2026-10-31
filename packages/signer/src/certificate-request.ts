/**
 * Key pairs and PKCS#10 requests for FNMT's software certificates, made as FNMT's Configurador
 * makes them, and the certificates FNMT's download page hands back (docs/research/fnmt.md §3.3,
 * §3.5, §4).
 */
import crypto, { type KeyObject } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ContentInfo, id_signedData, SignedData } from '@peculiar/asn1-cms';
import { AsnConvert } from '@peculiar/asn1-schema';
import * as asn1js from 'asn1js';
import { completeChain } from './chain';
import { encodeDer, int, oid, seq, set, utf8 } from './util/asn1';
import { asBuffer, decodeBase64, toArrayBuffer } from './util/base64';

const OID_COMMON_NAME = '2.5.4.3';
const OID_SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';

type RequestKeyType = 'rsa' | 'ec';

export interface RequestKeySpec {
  type: RequestKeyType;
  /** RSA modulus bits; 256 for EC (the curve is always P-256). */
  bits: number;
}

const RSA_DEFAULT_BITS = 2048;
const RSA_MAX_BITS = 4096;

/**
 * The key FNMT's page asks for, read as the Configurador reads it: `keyType` "ec"/"ecdsa" (any
 * case) means EC P-256, anything else RSA; `keyLength` sets the RSA size (2048 by default, and
 * never below it).
 */
export function requestKeySpec(keyType: unknown, keyLength: unknown): RequestKeySpec {
  const type = typeof keyType === 'string' ? keyType.trim().toLowerCase() : '';
  if (type === 'ec' || type === 'ecdsa') return { type: 'ec', bits: 256 };
  const length =
    typeof keyLength === 'number' ? keyLength : Number.parseInt(String(keyLength ?? ''), 10);
  const bits =
    Number.isInteger(length) && length >= RSA_DEFAULT_BITS && length <= RSA_MAX_BITS
      ? length
      : RSA_DEFAULT_BITS;
  return { type: 'rsa', bits };
}

export interface CertificateRequest {
  privateKey: KeyObject;
  /** DER SubjectPublicKeyInfo of the new key. */
  publicKey: Buffer;
  /** base64url(SHA-256(publicKey)): how pending keys and certificates are matched. */
  publicKeyHash: string;
  /** DER PKCS#10. */
  pkcs10: Buffer;
  /** e.g. "rsa 2048", "ec prime256v1". */
  keyDescription: string;
}

/** base64url(SHA-256(DER SubjectPublicKeyInfo)), without padding. */
export function publicKeyHash(spki: Uint8Array): string {
  return crypto.createHash('sha256').update(spki).digest('base64url');
}

function describeKey(key: KeyObject): string {
  const details = key.asymmetricKeyDetails;
  return [key.asymmetricKeyType, details?.modulusLength ?? details?.namedCurve ?? '']
    .filter(Boolean)
    .join(' ');
}

/**
 * A new key pair and its PKCS#10, as the Configurador builds it: subject `CN=foo.bar.com`, no
 * attributes, signed SHA256withRSA or SHA256withECDSA, with no parameters in the signature
 * algorithm (no NULL for RSA either).
 */
export function createCertificateRequest(spec: RequestKeySpec): CertificateRequest {
  const { privateKey, publicKey } =
    spec.type === 'ec'
      ? crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      : crypto.generateKeyPairSync('rsa', { modulusLength: spec.bits, publicExponent: 0x10001 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pkcs10 = buildPkcs10(privateKey, spki);
  return {
    privateKey,
    publicKey: spki,
    publicKeyHash: publicKeyHash(spki),
    pkcs10,
    keyDescription: describeKey(privateKey),
  };
}

function buildPkcs10(privateKey: KeyObject, spki: Buffer): Buffer {
  // The Configurador's fixed placeholder: FNMT takes the real subject from the request form.
  const subject = seq(set(seq(oid(OID_COMMON_NAME), utf8('foo.bar.com'))));
  const spkiNode = asn1js.fromBER(toArrayBuffer(spki)).result;
  // attributes [0] IMPLICIT SET OF Attribute: present and empty, as Bouncy Castle writes it.
  const attributes = new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value: [] });
  const info = encodeDer(seq(int(0), subject, spkiNode, attributes));
  const ec = privateKey.asymmetricKeyType === 'ec';
  const signature = crypto.sign('sha256', info, privateKey);
  const algorithm = seq(oid(ec ? OID_ECDSA_WITH_SHA256 : OID_SHA256_WITH_RSA));
  return encodeDer(
    seq(
      asn1js.fromBER(toArrayBuffer(info)).result,
      algorithm,
      new asn1js.BitString({ valueHex: toArrayBuffer(signature) }),
    ),
  );
}

/** Whether the PKCS#10's signature verifies with its own public key; returns that key's SPKI. */
export function verifyCertificateRequest(pkcs10: Uint8Array): Buffer {
  const req = asn1js.fromBER(toArrayBuffer(pkcs10));
  if (req.offset === -1) throw new Error('Invalid PKCS#10');
  const [info, algorithm, signature] = (req.result as asn1js.Sequence).valueBlock.value as [
    asn1js.Sequence,
    asn1js.Sequence,
    asn1js.BitString,
  ];
  const spkiNode = info.valueBlock.value[2] as asn1js.Sequence;
  const spki = Buffer.from(spkiNode.toBER(false));
  const algOid = (algorithm.valueBlock.value[0] as asn1js.ObjectIdentifier).valueBlock.toString();
  if (algOid !== OID_SHA256_WITH_RSA && algOid !== OID_ECDSA_WITH_SHA256) {
    throw new Error(`Unexpected PKCS#10 signature algorithm ${algOid}`);
  }
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const ok = crypto.verify(
    'sha256',
    Buffer.from(info.valueBeforeDecodeView),
    key,
    Buffer.from(signature.valueBlock.valueHexView),
  );
  if (!ok) throw new Error('The PKCS#10 signature does not verify');
  return spki;
}

// ---------------------------------------------------------------------------------------------
// The certificate at download
// ---------------------------------------------------------------------------------------------

/**
 * The certificates in what FNMT's download page passes to `installCert`: base64 or base64url
 * (spaces allowed), optionally gzipped, of a CMS SignedData ("degenerate PKCS#7") or a single
 * DER X.509; PEM is accepted too. Throws when nothing in it is a certificate.
 */
export function parseIssuedCertificates(data: string): Buffer[] {
  const pem = [...data.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)];
  if (pem.length) return pem.map((m) => Buffer.from(m[1]!.replace(/\s/g, ''), 'base64'));
  const decoded = decodeBase64(data);
  if (!decoded || decoded.length === 0) throw new Error('The certificate data is not base64');
  let der = decoded;
  if (der[0] === 0x1f && der[1] === 0x8b) der = gunzipSync(der);
  const fromCms = certificatesFromCms(der);
  if (fromCms.length) return fromCms;
  try {
    return [Buffer.from(new crypto.X509Certificate(der).raw)];
  } catch {
    throw new Error('The certificate data is neither a PKCS#7 bundle nor a certificate');
  }
}

function certificatesFromCms(der: Buffer): Buffer[] {
  try {
    const info = AsnConvert.parse(toArrayBuffer(der), ContentInfo);
    if (info.contentType !== id_signedData) return [];
    const signed = AsnConvert.parse(info.content, SignedData);
    return (signed.certificates ?? []).flatMap((choice) =>
      choice.certificate ? [asBuffer(AsnConvert.serialize(choice.certificate))] : [],
    );
  } catch {
    return [];
  }
}

/**
 * The path of `leaf` for the vault credential: leaf, intermediates and root, each verified by
 * signature, from `authorities` (the FNMT CAs the app ships, preferred as the Configurador
 * does) and then the certificates that came with it. A leaf no known CA issued comes back alone.
 */
export function issuedCertificatePath(
  leaf: Uint8Array,
  bundle: readonly Uint8Array[],
  authorities: readonly Uint8Array[],
): Buffer[] {
  const others = bundle.filter((c) => !asBuffer(c).equals(asBuffer(leaf)));
  return completeChain([leaf], [...authorities, ...others], { root: true });
}
