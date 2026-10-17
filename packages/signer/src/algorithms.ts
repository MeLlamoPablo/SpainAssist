/**
 * Signature algorithm names as AutoScript receives them ("SHA512", "SHA256withRSA",
 * "SHA384withECDSA"...). Like AutoFirma, only the digest is taken from the page; the final
 * algorithm is composed with the key type of the certificate (RSA or ECDSA).
 */
import { AfirmaError } from './errors';
import type { KeyType } from './p12';

export type DigestName = 'sha1' | 'sha256' | 'sha384' | 'sha512';

export type SignatureAlgorithm =
  | 'SHA1withRSA'
  | 'SHA256withRSA'
  | 'SHA384withRSA'
  | 'SHA512withRSA'
  | 'SHA1withECDSA'
  | 'SHA256withECDSA'
  | 'SHA384withECDSA'
  | 'SHA512withECDSA';

export interface ResolvedAlgorithm {
  /** Node crypto digest name. */
  digest: DigestName;
  /** AutoFirma / JCA name composed with the key type, e.g. "SHA256withECDSA". */
  name: SignatureAlgorithm;
  keyType: KeyType;
  digestOid: string;
  /** Full signature OID (e.g. sha256WithRSAEncryption, ecdsa-with-SHA256). */
  signatureOid: string;
  /**
   * OID AutoFirma writes in CMS `SignerInfo.signatureAlgorithm`: `rsaEncryption` for RSA keys,
   * the ecdsa-with-SHAx OID for EC keys.
   */
  cmsSignatureOid: string;
  xmlSignatureMethod: string;
  xmlDigestMethod: string;
}

const DEFAULT_ALGORITHM = 'SHA512withRSA';

const DIGESTS: Record<DigestName, { oid: string; xml: string; bits: string }> = {
  sha1: { oid: '1.3.14.3.2.26', xml: 'http://www.w3.org/2000/09/xmldsig#sha1', bits: '1' },
  sha256: {
    oid: '2.16.840.1.101.3.4.2.1',
    xml: 'http://www.w3.org/2001/04/xmlenc#sha256',
    bits: '256',
  },
  sha384: {
    oid: '2.16.840.1.101.3.4.2.2',
    xml: 'http://www.w3.org/2001/04/xmldsig-more#sha384',
    bits: '384',
  },
  sha512: {
    oid: '2.16.840.1.101.3.4.2.3',
    xml: 'http://www.w3.org/2001/04/xmlenc#sha512',
    bits: '512',
  },
};

const RSA_OIDS: Record<DigestName, string> = {
  sha1: '1.2.840.113549.1.1.5',
  sha256: '1.2.840.113549.1.1.11',
  sha384: '1.2.840.113549.1.1.12',
  sha512: '1.2.840.113549.1.1.13',
};
const ECDSA_OIDS: Record<DigestName, string> = {
  sha1: '1.2.840.10045.4.1',
  sha256: '1.2.840.10045.4.3.2',
  sha384: '1.2.840.10045.4.3.3',
  sha512: '1.2.840.10045.4.3.4',
};
const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';

/** Digest named in an algorithm string, or null if it is not one AutoFirma accepts. */
function parseDigest(algorithm: string): DigestName | null {
  const m = /^\s*SHA-?(1|256|384|512)(?:with(?:RSA|ECDSA))?\s*$/i.exec(algorithm);
  if (!m) return null;
  return `sha${m[1]}` as DigestName;
}

/** Digest name from a name, OID or XMLDSig URI (policy hash algorithms come in all three). */
export function digestFromAny(value: string): DigestName | null {
  const v = value.trim();
  for (const [name, d] of Object.entries(DIGESTS)) {
    if (v === d.oid || v === d.xml) return name as DigestName;
  }
  if (/^http:\/\/www\.w3\.org\/2001\/04\/xmldsig-more#sha384$/.test(v)) return 'sha384';
  return parseDigest(v);
}

export function digestOid(digest: DigestName): string {
  return DIGESTS[digest].oid;
}

export function xmlDigestUri(digest: DigestName): string {
  return DIGESTS[digest].xml;
}

/** Digest of the requested algorithm (default when empty); throws if it is not supported. */
export function checkAlgorithm(algorithm: string | null | undefined): DigestName {
  const requested = algorithm == null || algorithm === '' ? DEFAULT_ALGORITHM : String(algorithm);
  const digest = parseDigest(requested);
  if (!digest) throw AfirmaError.unsupportedAlgorithm(requested);
  return digest;
}

export function resolveAlgorithm(
  algorithm: string | null | undefined,
  keyType: KeyType,
): ResolvedAlgorithm {
  const digest = checkAlgorithm(algorithm);
  const bits = DIGESTS[digest].bits;
  if (keyType === 'rsa') {
    return {
      digest,
      name: `SHA${bits}withRSA` as SignatureAlgorithm,
      keyType,
      digestOid: DIGESTS[digest].oid,
      signatureOid: RSA_OIDS[digest],
      cmsSignatureOid: OID_RSA_ENCRYPTION,
      xmlSignatureMethod:
        digest === 'sha1'
          ? 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'
          : `http://www.w3.org/2001/04/xmldsig-more#rsa-sha${bits}`,
      xmlDigestMethod: DIGESTS[digest].xml,
    };
  }
  return {
    digest,
    name: `SHA${bits}withECDSA` as SignatureAlgorithm,
    keyType,
    digestOid: DIGESTS[digest].oid,
    signatureOid: ECDSA_OIDS[digest],
    cmsSignatureOid: ECDSA_OIDS[digest],
    xmlSignatureMethod: `http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha${bits}`,
    xmlDigestMethod: DIGESTS[digest].xml,
  };
}
