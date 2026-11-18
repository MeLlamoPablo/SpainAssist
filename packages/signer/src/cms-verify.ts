/**
 * Checking signatures made by others: a timestamp authority's token, an OCSP responder's answer,
 * a CA's revocation list. Anything we embed in a signed PDF as evidence is verified first, so a
 * broken or forged answer is never written into the user's document.
 */
import crypto from 'node:crypto';
import type * as cms from '@peculiar/asn1-cms';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import * as x509 from '@peculiar/asn1-x509';
import type { DigestName } from './algorithms';

const DIGEST_BY_OID: Record<string, DigestName> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};

/** Signature algorithm OIDs that name their digest. */
const SIGNATURE_DIGEST: Record<string, DigestName> = {
  '1.2.840.113549.1.1.5': 'sha1',
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.10045.4.1': 'sha1',
  '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384',
  '1.2.840.10045.4.3.4': 'sha512',
};
const RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const RSASSA_PSS = '1.2.840.113549.1.1.10';
const EC_PUBLIC_KEY_SIGNATURE = '1.2.840.10045.2.1';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';

export function digestOfOid(oid: string): DigestName | undefined {
  return DIGEST_BY_OID[oid];
}

function bytes(v: ArrayBuffer | ArrayBufferView): Buffer {
  return v instanceof ArrayBuffer
    ? Buffer.from(v)
    : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** RSASSA-PSS-params: [0] hash, [1] mask generation, [2] salt length (defaults SHA-1, 20). */
function pssParams(params: ArrayBuffer | null | undefined): { digest: DigestName; salt: number } {
  let digest: DigestName = 'sha1';
  let salt = 20;
  if (!params) return { digest, salt };
  const der = bytes(params);
  // A tiny walk: SEQUENCE { [0] { AlgorithmIdentifier }, [1] {...}, [2] { INTEGER } ... }
  let i = 2;
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  while (i < der.length) {
    const tag = der[i];
    let len = der[i + 1];
    let head = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = len * 256 + der[i + 2 + k];
      head = 2 + n;
    }
    const inner = der.subarray(i + head, i + head + len);
    if (tag === 0xa0) {
      const alg = AsnConvert.parse(inner, x509.AlgorithmIdentifier);
      digest = DIGEST_BY_OID[alg.algorithm] ?? digest;
    } else if (tag === 0xa2 && inner[0] === 0x02) {
      salt = 0;
      for (let k = 0; k < inner[1]; k++) salt = salt * 256 + inner[2 + k];
    }
    i += head + len;
  }
  return { digest, salt };
}

/**
 * `signature` over `data` by `certificate`'s key with `algorithm`. `digest` is the digest for
 * algorithms that don't name it (CMS writes rsaEncryption next to a separate digest).
 */
export function verifyWithCertificate(
  certificate: Uint8Array,
  algorithm: x509.AlgorithmIdentifier,
  data: Uint8Array,
  signature: Uint8Array,
  digest?: DigestName,
): boolean {
  try {
    const key = new crypto.X509Certificate(Buffer.from(certificate)).publicKey;
    const oid = algorithm.algorithm;
    if (oid === RSASSA_PSS) {
      const { digest: hash, salt } = pssParams(algorithm.parameters);
      return crypto.verify(
        hash,
        data,
        { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: salt },
        signature,
      );
    }
    const hash =
      SIGNATURE_DIGEST[oid] ??
      (oid === RSA_ENCRYPTION || oid === EC_PUBLIC_KEY_SIGNATURE ? digest : undefined);
    if (!hash) return false;
    return crypto.verify(hash, data, { key, dsaEncoding: 'der' }, signature);
  } catch {
    return false;
  }
}

function derSet(items: Buffer[]): Buffer {
  const content = Buffer.concat(items);
  const n = content.length;
  const length: number[] = [];
  if (n < 0x80) length.push(n);
  else {
    for (let v = n; v > 0; v = Math.floor(v / 256)) length.unshift(v & 0xff);
    length.unshift(0x80 | length.length);
  }
  return Buffer.concat([Buffer.from([0x31, ...length]), content]);
}

/** The certificates a SignedData carries (DER). */
export function signedDataCertificates(signedData: cms.SignedData): Buffer[] {
  return (signedData.certificates ?? [])
    .map((c) => c.certificate)
    .filter((c): c is x509.Certificate => c !== undefined)
    .map((c) => Buffer.from(AsnConvert.serialize(c)));
}

/** The certificate `signerInfo` names (issuer and serial, or key identifier) among `certificates`. */
export function findSignerCertificate(
  signerInfo: cms.SignerInfo,
  certificates: Buffer[],
): Buffer | undefined {
  const byIssuer = signerInfo.sid.issuerAndSerialNumber;
  const byKey = signerInfo.sid.subjectKeyIdentifier;
  return certificates.find((der) => {
    const tbs = AsnConvert.parse(der, x509.Certificate).tbsCertificate;
    if (byIssuer) {
      return (
        bytes(tbs.serialNumber).equals(bytes(byIssuer.serialNumber)) &&
        bytes(AsnConvert.serialize(tbs.issuer)).equals(bytes(AsnConvert.serialize(byIssuer.issuer)))
      );
    }
    if (byKey) {
      const ext = tbs.extensions?.find((e) => e.extnID === x509.id_ce_subjectKeyIdentifier);
      if (!ext) return false;
      const ski = AsnConvert.parse(ext.extnValue, OctetString);
      return bytes(ski.buffer).equals(bytes(byKey.buffer));
    }
    return false;
  });
}

/**
 * Verifies the first signer of `signedData` over `content` (its encapsulated content): the
 * message-digest attribute and the signature over the signed attributes, with the signer's
 * certificate from the SignedData itself. Returns that certificate, or undefined when anything
 * doesn't check out.
 */
export function verifySignedData(
  signedData: cms.SignedData,
  content: Uint8Array,
): Buffer | undefined {
  const signerInfo = signedData.signerInfos[0];
  if (!signerInfo) return undefined;
  const certificate = findSignerCertificate(signerInfo, signedDataCertificates(signedData));
  if (!certificate) return undefined;
  const digest = DIGEST_BY_OID[signerInfo.digestAlgorithm.algorithm];
  if (!digest) return undefined;
  const attrs = signerInfo.signedAttrs;
  if (!attrs) return undefined;
  const messageDigest = attrs.find((a) => a.attrType === OID_MESSAGE_DIGEST)?.attrValues[0];
  const contentType = attrs.find((a) => a.attrType === OID_CONTENT_TYPE);
  if (!messageDigest || !contentType) return undefined;
  const expected = crypto.createHash(digest).update(content).digest();
  const declared = AsnConvert.parse(messageDigest, OctetString);
  if (!bytes(declared.buffer).equals(expected)) return undefined;
  // The signature covers the attributes DER-encoded as a SET (not [0] as they sit in SignerInfo).
  // Parsed in order and each value kept as it came, so this is the DER that was signed.
  const signed = derSet(attrs.map((a) => bytes(AsnConvert.serialize(a))));
  const ok = verifyWithCertificate(
    certificate,
    signerInfo.signatureAlgorithm,
    signed,
    bytes(signerInfo.signature.buffer),
    digest,
  );
  return ok ? certificate : undefined;
}
