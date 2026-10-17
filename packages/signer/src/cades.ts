/**
 * CAdES-BES / CAdES-EPES as AutoFirma builds them (afirma-crypto-cades: CAdESUtils,
 * CAdESTriPhaseSigner, CAdESParameters):
 *  - signed attributes (DER-sorted SET): content-type (id-data, not in countersignatures),
 *    message-digest, signing-certificate-v2 (signing-certificate v1 for SHA-1) with IssuerSerial
 *    and the certificate's own policies, signature-policy-identifier (EPES), content-hints,
 *    signer-attributes (claimed roles), signing-time (UTCTime), mime-type (optional);
 *  - SignerInfo v1 with IssuerAndSerialNumber, digest AlgorithmIdentifier with NULL parameters,
 *    `rsaEncryption` (RSA keys) or ecdsa-with-SHAx (EC keys) as signature algorithm;
 *  - SignedData v1, id-data content (attached = "implicit", detached = "explicit"), the
 *    certificate chain (or only the leaf).
 */
import crypto from 'node:crypto';
import * as cms from '@peculiar/asn1-cms';
import * as ess from '@peculiar/asn1-ess';
import {
  AsnConvert,
  AsnProp,
  AsnPropTypes,
  AsnSerializer,
  AsnType,
  AsnTypeTypes,
  OctetString,
} from '@peculiar/asn1-schema';
import {
  AlgorithmIdentifier,
  Certificate,
  GeneralName,
  GeneralNames,
  type PolicyInformation,
} from '@peculiar/asn1-x509';
import type { SignatureBinding } from '@sa/shared';
import { digestOid, type ResolvedAlgorithm } from './algorithms';
import { certificatePolicies, parseCertificate } from './certificate';
import { AfirmaError } from './errors';
import type { KeySigner } from './key';
import type { SignaturePolicy } from './policy';
import {
  encodeDer,
  explicit,
  octets,
  octetsOf,
  oid,
  parseBer,
  seq,
  set,
  utcTime,
  utf8,
} from './util/asn1';
import { toArrayBuffer } from './util/base64';

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  counterSignature: '1.2.840.113549.1.9.6',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  sigPolicyId: '1.2.840.113549.1.9.16.2.15',
  contentHint: '1.2.840.113549.1.9.16.2.4',
  signerAttr: '1.2.840.113549.1.9.16.2.18',
  spqUri: '1.2.840.113549.1.9.16.5.1',
  mimeType: '0.4.0.1733.2.1',
  role: '2.5.4.72',
} as const;

// ---------------------------------------------------------------------------------------------
// SignaturePolicyIdentifier (RFC 5126 §5.8.1); decorators applied as plain calls.
// ---------------------------------------------------------------------------------------------

class OtherHashAlgAndValue {
  hashAlgorithm = new AlgorithmIdentifier();
  hashValue = new OctetString();
  constructor(params: Partial<OtherHashAlgAndValue> = {}) {
    Object.assign(this, params);
  }
}
AsnProp({ type: AlgorithmIdentifier })(OtherHashAlgAndValue.prototype, 'hashAlgorithm');
AsnProp({ type: OctetString })(OtherHashAlgAndValue.prototype, 'hashValue');
AsnType({ type: AsnTypeTypes.Sequence })(OtherHashAlgAndValue);

class SigPolicyQualifierInfo {
  sigPolicyQualifierId = '';
  /** SPURI (id-spq-ets-uri) as IA5String. */
  sigQualifier = '';
  constructor(params: Partial<SigPolicyQualifierInfo> = {}) {
    Object.assign(this, params);
  }
}
AsnProp({ type: AsnPropTypes.ObjectIdentifier })(
  SigPolicyQualifierInfo.prototype,
  'sigPolicyQualifierId',
);
AsnProp({ type: AsnPropTypes.IA5String })(SigPolicyQualifierInfo.prototype, 'sigQualifier');
AsnType({ type: AsnTypeTypes.Sequence })(SigPolicyQualifierInfo);

class SignaturePolicyId {
  sigPolicyId = '';
  sigPolicyHash = new OtherHashAlgAndValue();
  sigPolicyQualifiers?: SigPolicyQualifierInfo[];
  constructor(params: Partial<SignaturePolicyId> = {}) {
    Object.assign(this, params);
  }
}
AsnProp({ type: AsnPropTypes.ObjectIdentifier })(SignaturePolicyId.prototype, 'sigPolicyId');
AsnProp({ type: OtherHashAlgAndValue })(SignaturePolicyId.prototype, 'sigPolicyHash');
AsnProp({ type: SigPolicyQualifierInfo, repeated: 'sequence', optional: true })(
  SignaturePolicyId.prototype,
  'sigPolicyQualifiers',
);
AsnType({ type: AsnTypeTypes.Sequence })(SignaturePolicyId);

// ---------------------------------------------------------------------------------------------
// Signed attributes
// ---------------------------------------------------------------------------------------------

interface ContentHintsValue {
  oid: string;
  description?: string;
}

interface SignedAttributeOptions {
  algorithm: ResolvedAlgorithm;
  /** DER of the signer's certificate. */
  certificateDer: Buffer;
  /** Value of message-digest. */
  messageDigest: Buffer;
  /** Omit content-type (countersignatures). */
  countersignature?: boolean;
  policy?: SignaturePolicy | null;
  /** null omits signing-time (PAdES). */
  signingTime?: Date | null;
  /** null omits content-hints (PAdES). */
  contentHints?: ContentHintsValue | null;
  mimeType?: string | null;
  claimedRoles?: string[];
  /** ESS signing-certificate-v2 (default: true unless the digest is SHA-1). */
  signingCertificateV2?: boolean;
  /** Copy the certificate's policies into ESS signing-certificate (AutoFirma default: true). */
  includeCertificatePolicies?: boolean;
}

const attr = (attrType: string, value: Uint8Array | ArrayBuffer): cms.Attribute =>
  new cms.Attribute({
    attrType,
    attrValues: [value instanceof ArrayBuffer ? value : toArrayBuffer(value)],
  });

function algorithmWithNull(algorithmOid: string): AlgorithmIdentifier {
  return new AlgorithmIdentifier({ algorithm: algorithmOid, parameters: null });
}

function signingCertificateAttribute(
  cert: Certificate,
  certDer: Buffer,
  algorithm: ResolvedAlgorithm,
  v2: boolean,
  includePolicies: boolean,
): cms.Attribute {
  const issuerSerial = new ess.IssuerSerial({
    issuer: new GeneralNames([new GeneralName({ directoryName: cert.tbsCertificate.issuer })]),
    serialNumber: cert.tbsCertificate.serialNumber,
  });
  const policies: PolicyInformation[] | undefined = includePolicies
    ? certificatePolicies(cert)?.map((p) => p)
    : undefined;
  if (v2) {
    const certHash = crypto.createHash(algorithm.digest).update(certDer).digest();
    const value = new ess.SigningCertificateV2({
      certs: [
        new ess.ESSCertIDv2({
          // DEFAULT sha256: omitted, as AutoFirma does.
          hashAlgorithm:
            algorithm.digest === 'sha256' ? undefined : algorithmWithNull(algorithm.digestOid),
          certHash: new OctetString(certHash),
          issuerSerial,
        }),
      ],
      policies: policies?.length ? policies : undefined,
    });
    return attr(OID.signingCertificateV2, AsnSerializer.serialize(value));
  }
  const value = new ess.SigningCertificate({
    certs: [
      new ess.ESSCertID({
        certHash: new OctetString(crypto.createHash('sha1').update(certDer).digest()),
        issuerSerial,
      }),
    ],
    policies: policies?.length ? policies : undefined,
  });
  return attr(OID.signingCertificate, AsnSerializer.serialize(value));
}

function policyAttribute(policy: SignaturePolicy): cms.Attribute {
  const value = new SignaturePolicyId({
    sigPolicyId: policy.oid,
    sigPolicyHash: new OtherHashAlgAndValue({
      hashAlgorithm: algorithmWithNull(digestOid(policy.hashAlgorithm)),
      hashValue: new OctetString(policy.hash),
    }),
    sigPolicyQualifiers: policy.qualifier
      ? [
          new SigPolicyQualifierInfo({
            sigPolicyQualifierId: OID.spqUri,
            sigQualifier: policy.qualifier,
          }),
        ]
      : undefined,
  });
  return attr(OID.sigPolicyId, AsnSerializer.serialize(value));
}

/** Signed attributes in DER order plus the exact bytes that get signed (the DER SET OF). */
function buildSignedAttributes(opts: SignedAttributeOptions): {
  attributes: cms.Attribute[];
  der: Buffer;
} {
  const cert = parseCertificate(opts.certificateDer);
  const list: cms.Attribute[] = [];
  if (!opts.countersignature) list.push(attr(OID.contentType, encodeDer(oid(OID.data))));
  list.push(attr(OID.messageDigest, encodeDer(octets(opts.messageDigest))));
  list.push(
    signingCertificateAttribute(
      cert,
      opts.certificateDer,
      opts.algorithm,
      opts.signingCertificateV2 ?? opts.algorithm.digest !== 'sha1',
      opts.includeCertificatePolicies ?? true,
    ),
  );
  if (opts.policy) list.push(policyAttribute(opts.policy));
  if (opts.contentHints) {
    const hints = new ess.ContentHints({
      contentType: opts.contentHints.oid,
      contentDescription: opts.contentHints.description,
    });
    list.push(attr(OID.contentHint, AsnSerializer.serialize(hints)));
  }
  const roles = (opts.claimedRoles ?? []).filter((r) => r);
  if (roles.length) {
    const claimed = seq(...roles.map((r) => seq(oid(OID.role), set(utf8(r)))));
    list.push(attr(OID.signerAttr, encodeDer(seq(explicit(0, claimed)))));
  }
  if (opts.signingTime) list.push(attr(OID.signingTime, encodeDer(utcTime(opts.signingTime))));
  if (opts.mimeType && !opts.countersignature) {
    list.push(attr(OID.mimeType, encodeDer(utf8(opts.mimeType))));
  }

  // DER: SET OF sorted by encoding. The same order goes into SignerInfo.signedAttrs, because
  // verifiers re-encode the attributes before checking the signature.
  const encoded = list
    .map((a) => ({ a, der: Buffer.from(AsnSerializer.serialize(a)) }))
    .sort((x, y) => Buffer.compare(x.der, y.der));
  const body = Buffer.concat(encoded.map((e) => e.der));
  const der = encodeDer(set(...encoded.map((e) => parseBer(e.der))));
  if (!der.subarray(der.length - body.length).equals(body)) {
    throw AfirmaError.internal('Error codificando los atributos firmados');
  }
  return { attributes: encoded.map((e) => e.a), der };
}

// ---------------------------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------------------------

function signerInfo(
  cert: Certificate,
  algorithm: ResolvedAlgorithm,
  attributes: cms.Attribute[],
  signature: Buffer,
): cms.SignerInfo {
  return new cms.SignerInfo({
    version: cms.CMSVersion.v1,
    sid: new cms.SignerIdentifier({
      issuerAndSerialNumber: new cms.IssuerAndSerialNumber({
        issuer: cert.tbsCertificate.issuer,
        serialNumber: cert.tbsCertificate.serialNumber,
      }),
    }),
    digestAlgorithm: algorithmWithNull(algorithm.digestOid),
    signedAttrs: attributes,
    signatureAlgorithm:
      algorithm.keyType === 'rsa'
        ? algorithmWithNull(algorithm.cmsSignatureOid)
        : new AlgorithmIdentifier({ algorithm: algorithm.cmsSignatureOid }),
    signature: new OctetString(signature),
  });
}

function certificateSet(certs: Buffer[]): cms.CertificateSet {
  const unique: Buffer[] = [];
  for (const c of certs) if (!unique.some((u) => u.equals(c))) unique.push(c);
  // DER SET OF: sorted by encoding.
  unique.sort(Buffer.compare);
  return new cms.CertificateSet(
    unique.map(
      (c) =>
        new cms.CertificateChoices({
          certificate: AsnConvert.parse(toArrayBuffer(c), Certificate),
        }),
    ),
  );
}

function contentInfo(sd: cms.SignedData): Buffer {
  return Buffer.from(
    AsnSerializer.serialize(
      new cms.ContentInfo({ contentType: OID.signedData, content: AsnSerializer.serialize(sd) }),
    ),
  );
}

export interface CadesSignOptions {
  /** Data to sign; may be omitted when `digest` (precalculated hash) is given. */
  data?: Buffer | null;
  /** Precalculated digest of the data (AutoFirma `precalculatedHashAlgorithm`): detached. */
  digest?: Buffer;
  /** Include the data in the signature ("implicit" / attached). */
  implicit: boolean;
  algorithm: ResolvedAlgorithm;
  signer: KeySigner;
  /** Leaf first. */
  chain: Buffer[];
  /** Given to the signer with the signed attributes (keys that check what they sign). */
  binding?: SignatureBinding;
  includeOnlySigningCertificate?: boolean;
  attributes?: Omit<
    SignedAttributeOptions,
    'algorithm' | 'certificateDer' | 'messageDigest' | 'countersignature'
  >;
}

/** Creates a CAdES signature (DER ContentInfo/SignedData). */
export async function createCades(opts: CadesSignOptions): Promise<Buffer> {
  const leafDer = opts.chain[0];
  if (!leafDer) throw AfirmaError.noCertificate();
  const cert = parseCertificate(leafDer);
  const messageDigest =
    opts.digest ??
    crypto
      .createHash(opts.algorithm.digest)
      .update(opts.data ?? Buffer.alloc(0))
      .digest();
  const { attributes, der } = buildSignedAttributes({
    ...opts.attributes,
    algorithm: opts.algorithm,
    certificateDer: leafDer,
    messageDigest,
  });
  const signature = await opts.signer.sign(der, opts.algorithm, { binding: opts.binding });
  const attach = opts.implicit && !opts.digest && opts.data;
  const sd = new cms.SignedData({
    version: cms.CMSVersion.v1,
    digestAlgorithms: new cms.DigestAlgorithmIdentifiers([
      algorithmWithNull(opts.algorithm.digestOid),
    ]),
    encapContentInfo: new cms.EncapsulatedContentInfo({
      eContentType: OID.data,
      eContent: attach
        ? new cms.EncapsulatedContent({ single: new OctetString(opts.data as Buffer) })
        : undefined,
    }),
    certificates: certificateSet(opts.includeOnlySigningCertificate ? [leafDer] : opts.chain),
    signerInfos: new cms.SignerInfos([signerInfo(cert, opts.algorithm, attributes, signature)]),
  });
  return contentInfo(sd);
}

// ---------------------------------------------------------------------------------------------
// Parsing existing signatures (cosign / countersign / AUTO detection)
// ---------------------------------------------------------------------------------------------

export interface ParsedCades {
  signedData: cms.SignedData;
  /** Encapsulated content (attached signatures), else null. */
  content: Buffer | null;
}

export function isCadesSignature(data: Uint8Array): boolean {
  try {
    parseCades(data);
    return true;
  } catch {
    return false;
  }
}

export function parseCades(signature: Uint8Array): ParsedCades {
  let ci: cms.ContentInfo;
  try {
    ci = AsnConvert.parse(toArrayBuffer(signature), cms.ContentInfo);
  } catch {
    throw AfirmaError.notSignature();
  }
  if (ci.contentType !== OID.signedData) throw AfirmaError.notSignature();
  const signedData = AsnConvert.parse(ci.content, cms.SignedData);
  let content: Buffer | null = null;
  const e = signedData.encapContentInfo.eContent;
  if (e?.single) content = Buffer.from(e.single.buffer);
  else if (e?.any) {
    // Constructed (BER) OCTET STRING: concatenate the segments.
    content = octetsOf(parseBer(Buffer.from(e.any)));
  }
  return { signedData, content };
}

function attributeValue(si: cms.SignerInfo, type: string): ArrayBuffer | undefined {
  return si.signedAttrs?.find((a) => a.attrType === type)?.attrValues[0];
}

function contentHintsOf(signedData: cms.SignedData): ContentHintsValue | undefined {
  for (const si of signedData.signerInfos) {
    const v = attributeValue(si, OID.contentHint);
    if (!v) continue;
    const hints = AsnConvert.parse(v, ess.ContentHints);
    return { oid: hints.contentType, description: hints.contentDescription };
  }
  return undefined;
}

function addDigestAlgorithm(sd: cms.SignedData, algorithm: ResolvedAlgorithm): void {
  if (!sd.digestAlgorithms.some((a) => a.algorithm === algorithm.digestOid)) {
    sd.digestAlgorithms.push(algorithmWithNull(algorithm.digestOid));
  }
}

function addCertificates(sd: cms.SignedData, chain: Buffer[]): void {
  const existing: Buffer[] = [];
  for (const c of sd.certificates ?? []) {
    if (c.certificate) existing.push(Buffer.from(AsnSerializer.serialize(c.certificate)));
  }
  const all = [...existing, ...chain];
  const others = (sd.certificates ?? []).filter((c) => !c.certificate);
  const set = certificateSet(all);
  for (const o of others) set.push(o);
  sd.certificates = set;
}

export interface CadesCosignOptions
  extends Omit<CadesSignOptions, 'implicit' | 'digest' | 'binding'> {
  signature: Buffer;
}

/** Adds a parallel signer (AutoFirma "cofirma") to an existing CAdES signature. */
export async function cosignCades(opts: CadesCosignOptions): Promise<Buffer> {
  const { signedData, content } = parseCades(opts.signature);
  const leafDer = opts.chain[0];
  if (!leafDer) throw AfirmaError.noCertificate();
  const cert = parseCertificate(leafDer);
  let messageDigest: Buffer | undefined;
  const data = content ?? opts.data ?? null;
  if (data) {
    messageDigest = crypto.createHash(opts.algorithm.digest).update(data).digest();
  } else {
    // Detached signature without data: reuse the digest of a signer with the same algorithm.
    for (const si of signedData.signerInfos) {
      if (si.digestAlgorithm.algorithm !== opts.algorithm.digestOid) continue;
      const v = attributeValue(si, OID.messageDigest);
      if (v) {
        messageDigest = Buffer.from(AsnConvert.parse(v, OctetString).buffer);
        break;
      }
    }
    if (!messageDigest) {
      throw AfirmaError.invalidParameter(
        'No se puede cofirmar una firma explicita sin los datos con un algoritmo distinto al de la firma original',
      );
    }
  }
  const { attributes, der } = buildSignedAttributes({
    contentHints: contentHintsOf(signedData),
    ...opts.attributes,
    algorithm: opts.algorithm,
    certificateDer: leafDer,
    messageDigest,
  });
  const signature = await opts.signer.sign(der, opts.algorithm);
  signedData.signerInfos.push(signerInfo(cert, opts.algorithm, attributes, signature));
  addDigestAlgorithm(signedData, opts.algorithm);
  addCertificates(signedData, opts.includeOnlySigningCertificate ? [leafDer] : opts.chain);
  return contentInfo(signedData);
}

export type CountersignTarget = 'leafs' | 'tree';

export interface CadesCountersignOptions
  extends Omit<CadesSignOptions, 'implicit' | 'digest' | 'data' | 'binding'> {
  signature: Buffer;
  target?: CountersignTarget;
}

function countersignaturesOf(si: cms.SignerInfo): cms.SignerInfo[] {
  const out: cms.SignerInfo[] = [];
  for (const a of si.unsignedAttrs ?? []) {
    if (a.attrType !== OID.counterSignature) continue;
    for (const v of a.attrValues) out.push(AsnConvert.parse(v, cms.SignerInfo));
  }
  return out;
}

/**
 * Countersigns an existing CAdES signature: `leafs` (default) countersigns every signer that has
 * no countersignature yet (at any depth); `tree` countersigns every signer.
 */
export async function countersignCades(opts: CadesCountersignOptions): Promise<Buffer> {
  const { signedData } = parseCades(opts.signature);
  const leafDer = opts.chain[0];
  if (!leafDer) throw AfirmaError.noCertificate();
  const cert = parseCertificate(leafDer);
  const target = opts.target ?? 'leafs';

  const counterSignerFor = async (si: cms.SignerInfo): Promise<cms.SignerInfo> => {
    const messageDigest = crypto
      .createHash(opts.algorithm.digest)
      .update(Buffer.from(si.signature.buffer))
      .digest();
    const { attributes, der } = buildSignedAttributes({
      ...opts.attributes,
      contentHints: null,
      mimeType: null,
      algorithm: opts.algorithm,
      certificateDer: leafDer,
      messageDigest,
      countersignature: true,
    });
    return signerInfo(
      cert,
      opts.algorithm,
      attributes,
      await opts.signer.sign(der, opts.algorithm),
    );
  };

  // Returns the signer with its countersignature tree updated.
  const visit = async (si: cms.SignerInfo): Promise<cms.SignerInfo> => {
    const children = countersignaturesOf(si);
    const updatedChildren: cms.SignerInfo[] = [];
    for (const child of children) updatedChildren.push(await visit(child));
    const isLeaf = children.length === 0;
    const added = target === 'tree' || isLeaf ? [await counterSignerFor(si)] : [];
    if (updatedChildren.length === 0 && added.length === 0) return si;
    const values = [...updatedChildren, ...added].map((c) => AsnSerializer.serialize(c));
    const others = (si.unsignedAttrs ?? []).filter((a) => a.attrType !== OID.counterSignature);
    si.unsignedAttrs = [
      ...others,
      new cms.Attribute({ attrType: OID.counterSignature, attrValues: values }),
    ];
    return si;
  };

  const updated: cms.SignerInfo[] = [];
  for (const si of signedData.signerInfos) updated.push(await visit(si));
  signedData.signerInfos = new cms.SignerInfos(updated);
  addDigestAlgorithm(signedData, opts.algorithm);
  addCertificates(signedData, opts.includeOnlySigningCertificate ? [leafDer] : opts.chain);
  return contentInfo(signedData);
}
