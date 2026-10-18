/**
 * Where signatures come from: a `.p12` key in memory, or a key outside the app (the DNIe in the
 * paired phone, through `ExternalSigningKey`). The CAdES/XAdES/PAdES/triphase builders only see
 * a `KeySigner`, so every format works with both.
 */
import crypto, { type KeyObject } from 'node:crypto';
import type {
  CertificateInfo,
  CertificateRefusal,
  ExternalSigningKey,
  SignatureBinding,
} from '@sa/shared';
import type { ResolvedAlgorithm } from './algorithms';
import { certificateInfo } from './certificate';
import { AfirmaError } from './errors';
import type { KeyType, P12Identity } from './p12';

export interface KeySignOptions {
  /** What the signed bytes belong to, for keys that check it (the phone). */
  binding?: SignatureBinding;
  /** ECDSA output: DER (CMS) or r|s (XML-DSig). Ignored for RSA. */
  ecdsaFormat?: 'der' | 'ieee-p1363';
}

export interface KeySigner {
  keyType: KeyType;
  /** Like JCA `Signature`: hashes `data` with the algorithm's digest, then signs. */
  sign(data: Uint8Array, algorithm: ResolvedAlgorithm, options?: KeySignOptions): Promise<Buffer>;
}

/** A certificate and the key that signs for it. */
export interface SignerIdentity {
  keyType: KeyType;
  /** DER of the signing certificate. */
  certificateDer: Buffer;
  /** Leaf first. */
  chainDer: Buffer[];
  /**
   * The credential's other certificates (DER), which this identity can't sign with: the DNIe's
   * AUTENTICACIÓN. Only for the site's certificate filters.
   */
  otherCertificatesDer: Buffer[];
  info: CertificateInfo;
  signer: KeySigner;
  /** Call once the operation ends, signed or not (`refusal`: the filters refused it). */
  release(ok: boolean, refusal?: CertificateRefusal): void;
}

export function keyObjectSigner(key: KeyObject, keyType: KeyType): KeySigner {
  return {
    keyType,
    sign: async (data, algorithm, options) =>
      crypto.sign(algorithm.digest, data, { key, dsaEncoding: options?.ecdsaFormat ?? 'der' }),
  };
}

export function p12Identity(identity: P12Identity): SignerIdentity {
  return {
    keyType: identity.keyType,
    certificateDer: identity.certificateDer,
    chainDer: identity.chainDer,
    otherCertificatesDer: [],
    info: identity.info,
    signer: keyObjectSigner(identity.privateKey, identity.keyType),
    release: () => {},
  };
}

/** An external key: RSA only (the DNIe), certificates from the card. */
export function externalIdentity(key: ExternalSigningKey): SignerIdentity {
  const chainDer = key.certificates.map((c) => Buffer.from(c));
  const certificateDer = chainDer[0];
  if (!certificateDer) throw AfirmaError.noCertificate();
  let keyType: KeyType;
  try {
    keyType = new crypto.X509Certificate(certificateDer).publicKey.asymmetricKeyType as KeyType;
  } catch {
    throw AfirmaError.noCertificate();
  }
  if (keyType !== 'rsa') {
    throw new AfirmaError('java.lang.Exception', 'El certificado del DNI no es RSA', 'AF201101');
  }
  return {
    keyType,
    certificateDer,
    chainDer,
    otherCertificatesDer: (key.otherCertificates ?? []).map((c) => Buffer.from(c)),
    info: certificateInfo(certificateDer),
    signer: {
      keyType,
      sign: async (data, algorithm, options) =>
        Buffer.from(await key.sign(data, algorithm.digest, options?.binding)),
    },
    release: (ok, refusal) => key.release(ok, refusal),
  };
}
