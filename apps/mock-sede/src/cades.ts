/**
 * CAdES (CMS SignedData) verification, as a sede's backend would do after AutoFirma's
 * `sign(..., "CAdES", "mode=implicit")` returns: parse the CMS, check the signed attributes
 * (content-type, message-digest, ESS signing-certificate-v2), verify the signature over the
 * signed attributes, and check that the signer certificate chains to a trusted CA.
 *
 * Parsing uses pkijs/asn1js; digests, signatures and chain checks use node:crypto.
 */
import { createHash, verify as cryptoVerify, X509Certificate } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { type CertificateHolder, describeCertificate } from './certinfo';
import { loadClientCa } from './identities';

export const CMS_OIDS = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  subjectKeyIdentifier: '2.5.29.14',
} as const;

const DIGEST_BY_OID: Record<string, string> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};

/** Signature algorithm OID -> digest (null: take it from the SignerInfo digestAlgorithm). */
const SIGNATURE_DIGEST_BY_OID: Record<string, string | null> = {
  '1.2.840.113549.1.1.1': null, // rsaEncryption
  '1.2.840.113549.1.1.5': 'sha1',
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.10045.4.3.2': 'sha256', // ecdsa-with-SHA256
  '1.2.840.10045.4.3.3': 'sha384',
  '1.2.840.10045.4.3.4': 'sha512',
};

export type CadesCheckId =
  | 'structure'
  | 'content'
  | 'contentType'
  | 'messageDigest'
  | 'signingCertificate'
  | 'signature'
  | 'chain'
  | 'validity'
  | 'certificateArgument';

export interface CadesCheck {
  id: CadesCheckId;
  ok: boolean;
  /** Spanish, shown to the user on failure. */
  message: string;
}

export interface CadesVerification {
  valid: boolean;
  checks: CadesCheck[];
  /** Message of the first failed check. */
  error?: string;
  mode?: 'implicit' | 'explicit';
  digestAlgorithm?: string;
  signingTime?: Date;
  signer?: CertificateHolder;
  /** The content covered by the signature (from the CMS, or `expectedContent` if explicit). */
  signedContent?: Buffer;
}

export interface VerifyCadesOptions {
  /** CMS SignedData as Base64 (standard or URL-safe, like AutoFirma returns) or DER. */
  signature: string | Uint8Array;
  /** Bytes the signature must cover (required for explicit signatures). */
  expectedContent?: Uint8Array;
  /** Trusted CA certificates (PEM). Default: the mock "FNMT-like" client CA. */
  trustedCaPems?: string[];
  /** Require the signed data inside the CMS (AutoFirma "mode=implicit"). Default true. */
  requireImplicit?: boolean;
  /** Require ESS signing-certificate(-v2), mandatory in CAdES-BES. Default true. */
  requireSigningCertificate?: boolean;
  /**
   * `certificateB64` received by the page's success callback; when given it must be the signer
   * certificate.
   */
  certificateArgument?: string;
  now?: Date;
}

/** Decodes standard or URL-safe Base64, ignoring whitespace. Throws on garbage. */
export function decodeBase64(value: string): Buffer {
  const clean = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length === 0) {
    throw new Error('Not Base64');
  }
  return Buffer.from(clean, 'base64');
}

const bytes = (view: Uint8Array) => Buffer.from(view.buffer, view.byteOffset, view.byteLength);

function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function findSignerCertificate(
  sid: unknown,
  certs: pkijs.Certificate[],
): pkijs.Certificate | undefined {
  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    const serial = bytes(sid.serialNumber.valueBlock.valueHexView).toString('hex');
    return certs.find(
      (c) =>
        bytes(c.serialNumber.valueBlock.valueHexView).toString('hex') === serial &&
        c.issuer.isEqual(sid.issuer),
    );
  }
  // [0] SubjectKeyIdentifier
  const ski = (sid as { valueBlock?: { valueHexView?: Uint8Array } })?.valueBlock?.valueHexView;
  if (!ski) return undefined;
  const wanted = bytes(ski).toString('hex');
  return certs.find((c) => {
    const ext = c.extensions?.find((e) => e.extnID === CMS_OIDS.subjectKeyIdentifier);
    const value = (ext?.parsedValue as asn1js.OctetString | undefined)?.valueBlock.valueHexView;
    return value ? bytes(value).toString('hex') === wanted : false;
  });
}

/** Extracts the expected certificate hash from ESS signing-certificate(-v2). */
function essCertHash(
  attr: pkijs.Attribute,
  v2: boolean,
): { algorithm: string; hash: Buffer } | undefined {
  const signingCertificate = attr.values[0];
  if (!(signingCertificate instanceof asn1js.Sequence)) return undefined;
  const certIds = signingCertificate.valueBlock.value[0];
  if (!(certIds instanceof asn1js.Sequence)) return undefined;
  const first = certIds.valueBlock.value[0];
  if (!(first instanceof asn1js.Sequence)) return undefined;
  const [a, b] = first.valueBlock.value;
  if (!v2) {
    return a instanceof asn1js.OctetString
      ? { algorithm: 'sha1', hash: bytes(a.valueBlock.valueHexView) }
      : undefined;
  }
  // ESSCertIDv2 ::= SEQUENCE { hashAlgorithm DEFAULT sha256, certHash, issuerSerial OPTIONAL }
  if (a instanceof asn1js.OctetString) {
    return { algorithm: 'sha256', hash: bytes(a.valueBlock.valueHexView) };
  }
  if (a instanceof asn1js.Sequence && b instanceof asn1js.OctetString) {
    const algOid = a.valueBlock.value[0];
    const algorithm =
      algOid instanceof asn1js.ObjectIdentifier
        ? DIGEST_BY_OID[algOid.valueBlock.toString()]
        : undefined;
    return algorithm ? { algorithm, hash: bytes(b.valueBlock.valueHexView) } : undefined;
  }
  return undefined;
}

/** Builds the chain from `leaf` to a trusted certificate. Returns null when none is reached. */
function buildChain(
  leaf: X509Certificate,
  trusted: X509Certificate[],
  extra: X509Certificate[],
): X509Certificate[] | null {
  const chain = [leaf];
  let current = leaf;
  for (let depth = 0; depth < 6; depth++) {
    if (trusted.some((t) => t.fingerprint256 === current.fingerprint256)) return chain;
    const issuer = [...trusted, ...extra].find(
      (c) =>
        c.fingerprint256 !== current.fingerprint256 &&
        current.checkIssued(c) &&
        current.verify(c.publicKey),
    );
    if (!issuer) return null;
    chain.push(issuer);
    current = issuer;
  }
  return null;
}

export function verifyCadesSignature(opts: VerifyCadesOptions): CadesVerification {
  const checks: CadesCheck[] = [];
  const out: CadesVerification = { valid: false, checks };
  const add = (id: CadesCheckId, ok: boolean, message: string) => {
    checks.push({ id, ok, message });
  };
  const done = (): CadesVerification => {
    const failed = checks.find((c) => !c.ok);
    out.valid = !failed && checks.length > 0;
    out.error = failed?.message;
    return out;
  };
  const now = opts.now ?? new Date();

  // --- Structure ---------------------------------------------------------------------------
  let der: Buffer;
  try {
    der =
      typeof opts.signature === 'string'
        ? decodeBase64(opts.signature)
        : Buffer.from(opts.signature);
  } catch {
    add('structure', false, 'La firma recibida no está en Base64.');
    return done();
  }
  let signedData: pkijs.SignedData;
  try {
    const parsed = asn1js.fromBER(toArrayBuffer(der));
    if (parsed.offset === -1) throw new Error(parsed.result.error);
    const contentInfo = new pkijs.ContentInfo({ schema: parsed.result });
    if (contentInfo.contentType !== CMS_OIDS.signedData) throw new Error('not SignedData');
    signedData = new pkijs.SignedData({ schema: contentInfo.content });
  } catch {
    add('structure', false, 'La firma no es una firma CAdES/CMS válida.');
    return done();
  }
  const signerInfo = signedData.signerInfos[0];
  if (!signerInfo) {
    add('structure', false, 'La firma no contiene ningún firmante.');
    return done();
  }
  add('structure', true, 'Estructura CMS SignedData correcta.');

  // --- Content -----------------------------------------------------------------------------
  const eContent = signedData.encapContentInfo.eContent;
  let content: Buffer | undefined;
  if (eContent) {
    out.mode = 'implicit';
    content = Buffer.from(eContent.getValue());
  } else {
    out.mode = 'explicit';
  }
  const expected = opts.expectedContent ? Buffer.from(opts.expectedContent) : undefined;
  if (!content && (opts.requireImplicit ?? true)) {
    add(
      'content',
      false,
      'La firma no incluye los datos firmados (se esperaba una firma implícita).',
    );
  } else if (!content && !expected) {
    add('content', false, 'Firma explícita sin datos con los que comprobarla.');
  } else {
    content ??= expected!;
    if (expected && !content.equals(expected)) {
      add('content', false, 'Los datos firmados no coinciden con los de la solicitud.');
    } else {
      add('content', true, 'Los datos firmados coinciden con la solicitud.');
    }
  }
  out.signedContent = content;

  // --- Signer certificate ------------------------------------------------------------------
  const embedded = (signedData.certificates ?? []).filter(
    (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
  );
  const signerPkijs = findSignerCertificate(signerInfo.sid, embedded);
  if (!signerPkijs) {
    add('chain', false, 'La firma no incluye el certificado del firmante.');
    return done();
  }
  const signerDer = Buffer.from(signerPkijs.toSchema().toBER(false));
  const signerX509 = new X509Certificate(signerDer);
  out.signer = describeCertificate(signerX509);

  // --- Signed attributes ---------------------------------------------------------------------
  const digestAlgorithm = DIGEST_BY_OID[signerInfo.digestAlgorithm.algorithmId];
  out.digestAlgorithm = digestAlgorithm;
  const attrs = signerInfo.signedAttrs?.attributes ?? [];
  const attr = (oid: string) => attrs.find((a) => a.type === oid);
  if (!signerInfo.signedAttrs) {
    add('messageDigest', false, 'La firma no tiene atributos firmados (obligatorios en CAdES).');
  } else {
    const contentType = attr(CMS_OIDS.contentType)?.values[0];
    const contentTypeOk =
      contentType instanceof asn1js.ObjectIdentifier &&
      contentType.valueBlock.toString() === signedData.encapContentInfo.eContentType;
    add(
      'contentType',
      contentTypeOk,
      contentTypeOk
        ? 'Atributo content-type correcto.'
        : 'Falta el atributo content-type o no es correcto.',
    );

    const messageDigest = attr(CMS_OIDS.messageDigest)?.values[0];
    if (!digestAlgorithm) {
      add('messageDigest', false, 'Algoritmo de resumen no soportado.');
    } else if (!(messageDigest instanceof asn1js.OctetString)) {
      add('messageDigest', false, 'Falta el atributo message-digest.');
    } else if (!content) {
      add('messageDigest', false, 'No hay datos con los que comprobar el resumen.');
    } else {
      const ok = createHash(digestAlgorithm)
        .update(content)
        .digest()
        .equals(bytes(messageDigest.valueBlock.valueHexView));
      add(
        'messageDigest',
        ok,
        ok
          ? 'El resumen (message-digest) coincide con los datos.'
          : 'El resumen (message-digest) no coincide con los datos firmados.',
      );
    }

    const signingTime = attr(CMS_OIDS.signingTime)?.values[0];
    if (signingTime instanceof asn1js.UTCTime || signingTime instanceof asn1js.GeneralizedTime) {
      out.signingTime = signingTime.toDate();
    }

    const essV2 = attr(CMS_OIDS.signingCertificateV2);
    const essV1 = attr(CMS_OIDS.signingCertificate);
    const ess = essV2 ? essCertHash(essV2, true) : essV1 ? essCertHash(essV1, false) : undefined;
    if (!essV2 && !essV1) {
      if (opts.requireSigningCertificate ?? true) {
        add(
          'signingCertificate',
          false,
          'Falta el atributo signing-certificate-v2 (obligatorio en CAdES-BES).',
        );
      }
    } else if (!ess) {
      add('signingCertificate', false, 'El atributo signing-certificate no se puede leer.');
    } else {
      const ok = createHash(ess.algorithm).update(signerDer).digest().equals(ess.hash);
      add(
        'signingCertificate',
        ok,
        ok
          ? 'El atributo signing-certificate identifica al firmante.'
          : 'El atributo signing-certificate no corresponde al certificado del firmante.',
      );
    }
  }

  // --- Signature over the signed attributes -------------------------------------------------
  const sigOid = signerInfo.signatureAlgorithm.algorithmId;
  const sigDigest =
    sigOid in SIGNATURE_DIGEST_BY_OID
      ? (SIGNATURE_DIGEST_BY_OID[sigOid] ?? digestAlgorithm)
      : undefined;
  if (!signerInfo.signedAttrs) {
    // Already reported above.
  } else if (!sigDigest) {
    add('signature', false, `Algoritmo de firma no soportado (${sigOid}).`);
  } else {
    let ok = false;
    try {
      const isEc = sigOid.startsWith('1.2.840.10045.');
      ok = cryptoVerify(
        sigDigest,
        Buffer.from(signerInfo.signedAttrs.encodedValue),
        isEc ? { key: signerX509.publicKey, dsaEncoding: 'der' } : signerX509.publicKey,
        bytes(signerInfo.signature.valueBlock.valueHexView),
      );
    } catch {
      ok = false;
    }
    add(
      'signature',
      ok,
      ok
        ? 'La firma criptográfica es correcta.'
        : 'La firma criptográfica no es válida (los datos o la firma se han alterado).',
    );
  }

  // --- Chain and validity ---------------------------------------------------------------------
  const trusted = (opts.trustedCaPems ?? loadClientCa().trustedPems).map(
    (pem) => new X509Certificate(pem),
  );
  const extra = embedded
    .filter((c) => c !== signerPkijs)
    .map((c) => new X509Certificate(Buffer.from(c.toSchema().toBER(false))));
  const chain = buildChain(signerX509, trusted, extra);
  if (!chain) {
    add(
      'chain',
      false,
      'El certificado del firmante no lo ha emitido una autoridad de certificación reconocida por esta sede.',
    );
  } else {
    add(
      'chain',
      true,
      `Certificado emitido por ${out.signer.issuerCommonName ?? 'una CA reconocida'}.`,
    );
    const expired = chain.find(
      (c) =>
        new Date(c.validFrom).getTime() > now.getTime() ||
        new Date(c.validTo).getTime() < now.getTime(),
    );
    add(
      'validity',
      !expired,
      expired
        ? 'El certificado de firma está caducado o todavía no es válido.'
        : 'El certificado está en vigor.',
    );
  }

  // --- certificateB64 from the success callback ----------------------------------------------
  if (opts.certificateArgument !== undefined) {
    let matches = false;
    try {
      matches = decodeBase64(opts.certificateArgument).equals(signerDer);
    } catch {
      matches = false;
    }
    add(
      'certificateArgument',
      matches,
      matches
        ? 'El certificado recibido coincide con el de la firma.'
        : 'El certificado recibido no coincide con el que aparece en la firma.',
    );
  }

  return done();
}
