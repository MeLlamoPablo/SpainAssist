/**
 * What a verifier needs to check certificates without asking anyone later (PAdES-B-LT): every
 * certificate up to a root and, for each one below the root, a revocation answer from that time:
 * an OCSP response or else the CA's CRL. Answers are verified before they are kept.
 *
 * OCSP responders that sign with a delegated certificate need that certificate checked too,
 * unless it carries id-pkix-ocsp-nocheck. Roots are trust anchors: nothing to check.
 */
import crypto from 'node:crypto';
import { AsnConvert } from '@peculiar/asn1-schema';
import * as x509 from '@peculiar/asn1-x509';
import * as asn1js from 'asn1js';
import { parseCades } from './cades';
import { issuedBy } from './chain';
import { signedDataCertificates, verifyWithCertificate } from './cms-verify';

export interface ValidationData {
  /** Every certificate of the chains, responders included (DER). */
  certificates: Buffer[];
  /** Full OCSPResponse structures (DER). */
  ocsps: Buffer[];
  /** CertificateList structures (DER). */
  crls: Buffer[];
}

export interface ValidationResult extends ValidationData {
  /** Certificates below a root left without a revocation answer (their subjects). */
  missing: string[];
  /** Certificates an answer says are revoked (their subjects). */
  revoked: string[];
  /** Chains that stopped before a root (the last subject reached). */
  incomplete: string[];
}

export interface RevocationOptions {
  fetch: typeof fetch;
  /** Per request (default 10 s). */
  timeoutMs?: number;
  /** Largest CRL downloaded (default 10 MB). */
  maxCrlBytes?: number;
  now?: Date;
  logger?: { warn?(msg: string, data?: unknown): void };
  /** Downloads (CRLs, CA certificates) shared between calls, by URL. */
  cache?: Map<string, Promise<Buffer>>;
}

const OID_AD_OCSP = '1.3.6.1.5.5.7.48.1';
const OID_AD_CA_ISSUERS = '1.3.6.1.5.5.7.48.2';
const OID_OCSP_BASIC = '1.3.6.1.5.5.7.48.1.1';
const OID_OCSP_NOCHECK = '1.3.6.1.5.5.7.48.1.5';
const OID_KP_OCSP_SIGNING = '1.3.6.1.5.5.7.3.9';
const OID_SHA1 = '1.3.14.3.2.26';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CRL_BYTES = 10 * 1024 * 1024;
const MAX_CERTIFICATE_BYTES = 256 * 1024;
const MAX_OCSP_BYTES = 256 * 1024;
const MAX_DEPTH = 8;
/** Clock skew tolerated between us and a responder. */
const SKEW_MS = 5 * 60_000;

function bytes(v: ArrayBuffer | ArrayBufferView): Buffer {
  return v instanceof ArrayBuffer
    ? Buffer.from(v)
    : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

interface Cert {
  der: Buffer;
  x: crypto.X509Certificate;
  asn: x509.Certificate;
}

function cert(der: Buffer): Cert {
  return {
    der,
    x: new crypto.X509Certificate(der),
    asn: AsnConvert.parse(der, x509.Certificate),
  };
}

function isRoot(c: Cert): boolean {
  return c.x.subject === c.x.issuer && issuedBy(c.x, c.x);
}

function extension<T>(c: Cert, oid: string, type: new () => T): T | undefined {
  const ext = c.asn.tbsCertificate.extensions?.find((e) => e.extnID === oid);
  return ext ? AsnConvert.parse(ext.extnValue, type) : undefined;
}

function hasExtension(c: Cert, oid: string): boolean {
  return !!c.asn.tbsCertificate.extensions?.some((e) => e.extnID === oid);
}

/** http(s) URLs of an authority-information-access method (OCSP or CA issuers). */
function accessUrls(c: Cert, method: string): string[] {
  const aia = extension(c, x509.id_pe_authorityInfoAccess, x509.AuthorityInfoAccessSyntax);
  return (aia ?? [])
    .filter((d) => d.accessMethod === method)
    .map((d) => d.accessLocation.uniformResourceIdentifier)
    .filter((u): u is string => !!u && /^https?:\/\//i.test(u));
}

function crlUrls(c: Cert): string[] {
  const dps = extension(c, x509.id_ce_cRLDistributionPoints, x509.CRLDistributionPoints);
  const out: string[] = [];
  for (const dp of dps ?? []) {
    for (const name of dp.distributionPoint?.fullName ?? []) {
      const u = name.uniformResourceIdentifier;
      if (u && /^https?:\/\//i.test(u)) out.push(u);
    }
  }
  return out;
}

function hasUsage(c: Cert, usage: string): boolean {
  const eku = extension(c, x509.id_ce_extKeyUsage, x509.ExtendedKeyUsage);
  return !!eku?.some((u) => u === usage);
}

async function download(
  url: string,
  o: RevocationOptions,
  max: number,
  init: RequestInit = {},
): Promise<Buffer> {
  const res = await o.fetch(url, {
    ...init,
    signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (declared > max) throw new Error('Too large');
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > max) throw new Error('Too large');
  return body;
}

function fromPem(data: Buffer): Buffer[] {
  const text = data.toString('latin1');
  const blocks = [...text.matchAll(/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/g)];
  return blocks.map((m) => Buffer.from(m[1].replace(/\s+/g, ''), 'base64'));
}

/** Certificates of a CA-issuers download: DER, PEM or a PKCS#7 bundle. */
function certificatesOf(data: Buffer): Buffer[] {
  const candidates = data[0] === 0x30 ? [data] : fromPem(data);
  const out: Buffer[] = [];
  for (const der of candidates) {
    try {
      cert(der);
      out.push(der);
      continue;
    } catch {}
    try {
      out.push(...signedDataCertificates(parseCades(der).signedData));
    } catch {}
  }
  return out;
}

// --- OCSP ------------------------------------------------------------------------------------

/** A one-certificate OCSP request (SHA-1 CertID, no nonce: cached responders reject them). */
function ocspRequest(subject: Cert, issuer: Cert): Buffer {
  const nameHash = crypto
    .createHash('sha1')
    .update(bytes(AsnConvert.serialize(issuer.asn.tbsCertificate.subject)))
    .digest();
  const keyHash = crypto
    .createHash('sha1')
    .update(bytes(issuer.asn.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey))
    .digest();
  const certId = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        value: [new asn1js.ObjectIdentifier({ value: OID_SHA1 }), new asn1js.Null()],
      }),
      new asn1js.OctetString({ valueHex: nameHash }),
      new asn1js.OctetString({ valueHex: keyHash }),
      new asn1js.Integer({ valueHex: bytes(subject.asn.tbsCertificate.serialNumber) }),
    ],
  });
  const request = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        value: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [certId] })] })],
      }),
    ],
  });
  return Buffer.from(request.toBER());
}

function isContext(block: asn1js.AsnType, n: number): boolean {
  const id = (block as asn1js.BaseBlock).idBlock;
  return id.tagClass === 3 && id.tagNumber === n;
}

function sameInteger(a: Uint8Array, b: Uint8Array): boolean {
  const strip = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    return Buffer.from(x.subarray(i));
  };
  return strip(a).equals(strip(b));
}

interface OcspAnswer {
  status: 'good' | 'revoked' | 'unknown';
  /** The delegated responder's certificate, when not the issuer itself. */
  responder?: Cert;
}

/** Reads and checks an OCSPResponse about `subject` (issued by `issuer`). */
function checkOcspResponse(der: Buffer, subject: Cert, issuer: Cert, now: Date): OcspAnswer {
  const top = asn1js.fromBER(der).result as asn1js.Sequence;
  const [statusBlock, bytesBlock] = top.valueBlock.value;
  if (!(statusBlock instanceof asn1js.Enumerated) || statusBlock.valueBlock.valueDec !== 0) {
    throw new Error('OCSP responder error');
  }
  const responseBytes = (bytesBlock as asn1js.Constructed).valueBlock.value[0] as asn1js.Sequence;
  const [type, octets] = responseBytes.valueBlock.value;
  if (
    !(type instanceof asn1js.ObjectIdentifier) ||
    type.valueBlock.toString() !== OID_OCSP_BASIC ||
    !(octets instanceof asn1js.OctetString)
  ) {
    throw new Error('Not a basic OCSP response');
  }
  const basic = asn1js.fromBER(octets.valueBlock.valueHexView).result as asn1js.Sequence;
  const [tbs, algBlock, sigBlock, certsBlock] = basic.valueBlock.value;
  const algorithm = AsnConvert.parse(algBlock.toBER(), x509.AlgorithmIdentifier);
  const signature = (sigBlock as asn1js.BitString).valueBlock.valueHexView;
  const tbsRaw = (tbs as asn1js.Sequence).valueBeforeDecodeView;
  const included: Cert[] = [];
  if (certsBlock && isContext(certsBlock, 0)) {
    const seq = (certsBlock as asn1js.Constructed).valueBlock.value[0] as asn1js.Sequence;
    for (const c of seq.valueBlock.value) {
      try {
        included.push(cert(Buffer.from(c.valueBeforeDecodeView)));
      } catch {}
    }
  }
  // Signed by the issuer itself, or by a responder the issuer authorized for OCSP.
  let responder: Cert | undefined;
  if (!verifyWithCertificate(issuer.der, algorithm, tbsRaw, signature)) {
    responder = included.find(
      (c) =>
        issuedBy(c.x, issuer.x) &&
        hasUsage(c, OID_KP_OCSP_SIGNING) &&
        verifyWithCertificate(c.der, algorithm, tbsRaw, signature),
    );
    if (!responder) throw new Error('The OCSP signature does not verify');
  }

  const data = (tbs as asn1js.Sequence).valueBlock.value.filter(
    (b) => !isContext(b, 0) && !isContext(b, 1) && !isContext(b, 2),
  );
  // data: producedAt, responses
  const responses = data.find((b) => b instanceof asn1js.Sequence) as asn1js.Sequence;
  for (const single of responses.valueBlock.value as asn1js.Sequence[]) {
    const [certId, statusTag, thisUpdate, ...rest] = single.valueBlock.value;
    const serial = (certId as asn1js.Sequence).valueBlock.value[3] as asn1js.Integer;
    if (
      !sameInteger(serial.valueBlock.valueHexView, bytes(subject.asn.tbsCertificate.serialNumber))
    )
      continue;
    const nameHashAlg = AsnConvert.parse(
      ((certId as asn1js.Sequence).valueBlock.value[0] as asn1js.Sequence).toBER(),
      x509.AlgorithmIdentifier,
    );
    const nameHash = ((certId as asn1js.Sequence).valueBlock.value[1] as asn1js.OctetString)
      .valueBlock.valueHexView;
    const hashName =
      { [OID_SHA1]: 'sha1', '2.16.840.1.101.3.4.2.1': 'sha256' }[nameHashAlg.algorithm] ?? 'sha1';
    const expectedName = crypto
      .createHash(hashName)
      .update(bytes(AsnConvert.serialize(issuer.asn.tbsCertificate.subject)))
      .digest();
    if (!expectedName.equals(Buffer.from(nameHash))) continue;
    const from = (thisUpdate as asn1js.GeneralizedTime).toDate();
    if (from.getTime() > now.getTime() + SKEW_MS) throw new Error('OCSP answer from the future');
    const next = rest.find((b) => isContext(b, 0)) as asn1js.Constructed | undefined;
    const until = next ? (next.valueBlock.value[0] as asn1js.GeneralizedTime).toDate() : undefined;
    if (until && until.getTime() < now.getTime() - SKEW_MS) throw new Error('Stale OCSP answer');
    const tag = (statusTag as asn1js.BaseBlock).idBlock.tagNumber;
    const status = tag === 0 ? 'good' : tag === 1 ? 'revoked' : 'unknown';
    return { status, ...(responder ? { responder } : {}) };
  }
  throw new Error('The OCSP answer is about another certificate');
}

// --- CRL -------------------------------------------------------------------------------------

/** Checks a CRL issued by `issuer`; true when it lists `subject` as revoked. */
function checkCrl(der: Buffer, subject: Cert, issuer: Cert, now: Date): boolean {
  const crl = AsnConvert.parse(der, x509.CertificateList);
  const raw = crl.tbsCertListRaw;
  if (
    !raw ||
    !verifyWithCertificate(issuer.der, crl.signatureAlgorithm, bytes(raw), bytes(crl.signature))
  ) {
    throw new Error('The CRL signature does not verify');
  }
  const tbs = crl.tbsCertList;
  const next = tbs.nextUpdate?.getTime();
  if (next && next.getTime() < now.getTime() - SKEW_MS) throw new Error('Stale CRL');
  const serial = bytes(subject.asn.tbsCertificate.serialNumber);
  return !!tbs.revokedCertificates?.some((r) => sameInteger(bytes(r.userCertificate), serial));
}

// --- Collection ------------------------------------------------------------------------------

/**
 * Chains from each of `leaves` up to a root, using `pool` and the certificates' CA-issuers URLs,
 * with a revocation answer for every certificate below the root.
 */
export async function collectValidationData(
  leaves: Buffer[],
  pool: Buffer[],
  o: RevocationOptions,
): Promise<ValidationResult> {
  const now = o.now ?? new Date();
  const known = new Map<string, Cert>();
  const add = (der: Buffer): Cert | undefined => {
    try {
      const c = cert(der);
      const key = c.x.fingerprint256;
      if (!known.has(key)) known.set(key, c);
      return known.get(key);
    } catch {
      return undefined;
    }
  };
  for (const der of pool) add(der);

  const cache = o.cache ?? new Map<string, Promise<Buffer>>();
  const cached = (url: string, get: () => Promise<Buffer>): Promise<Buffer> => {
    let pending = cache.get(url);
    if (!pending) {
      pending = get();
      // A failure isn't kept: the next certificate may try again.
      pending.catch(() => cache.delete(url));
      cache.set(url, pending);
    }
    return pending;
  };

  const issuerOf = async (c: Cert): Promise<Cert | undefined> => {
    // Prefer a self-signed root over a cross-signed copy of it (DigiCert's TSA sends both):
    // the path then ends at the anchor validators trust.
    const candidates = [...known.values()].filter((k) => k !== c && issuedBy(c.x, k.x));
    const local = candidates.find(isRoot) ?? candidates[0];
    if (local) return local;
    for (const url of accessUrls(c, OID_AD_CA_ISSUERS)) {
      try {
        const data = await cached(url, () => download(url, o, MAX_CERTIFICATE_BYTES));
        for (const der of certificatesOf(data)) {
          const found = add(der);
          if (found && issuedBy(c.x, found.x)) return found;
        }
      } catch (e) {
        o.logger?.warn?.('CA certificate download failed', { url, error: String(e) });
      }
    }
    return undefined;
  };

  // Pairs (certificate, issuer) needing an answer.
  const pairs: { subject: Cert; issuer: Cert }[] = [];
  const queued = new Set<string>();
  const result: ValidationResult = {
    certificates: [],
    ocsps: [],
    crls: [],
    missing: [],
    revoked: [],
    incomplete: [],
  };
  const used = new Map<string, Cert>();
  for (const leafDer of leaves) {
    let current = add(leafDer);
    for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
      used.set(current.x.fingerprint256, current);
      if (isRoot(current)) break;
      const issuer = await issuerOf(current);
      if (!issuer) {
        result.incomplete.push(current.x.subject);
        break;
      }
      const key = current.x.fingerprint256;
      if (!queued.has(key)) {
        queued.add(key);
        pairs.push({ subject: current, issuer });
      }
      current = issuer;
    }
  }

  const answer = async ({ subject, issuer }: { subject: Cert; issuer: Cert }) => {
    for (const url of accessUrls(subject, OID_AD_OCSP)) {
      try {
        const der = await download(url, o, MAX_OCSP_BYTES, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/ocsp-request',
            Accept: 'application/ocsp-response',
          },
          body: new Uint8Array(ocspRequest(subject, issuer)),
        });
        const { status, responder } = checkOcspResponse(der, subject, issuer, now);
        if (status === 'unknown') throw new Error('The responder does not know the certificate');
        if (status === 'revoked') result.revoked.push(subject.x.subject);
        result.ocsps.push(der);
        if (responder) {
          used.set(responder.x.fingerprint256, responder);
          const key = responder.x.fingerprint256;
          if (!hasExtension(responder, OID_OCSP_NOCHECK) && !queued.has(key)) {
            queued.add(key);
            await answer({ subject: responder, issuer });
          }
        }
        return;
      } catch (e) {
        o.logger?.warn?.('OCSP failed', { url, error: String(e) });
      }
    }
    for (const url of crlUrls(subject)) {
      try {
        const der = await cached(url, () =>
          download(url, o, o.maxCrlBytes ?? DEFAULT_MAX_CRL_BYTES).then((d) =>
            d[0] === 0x30 ? d : (fromPem(d)[0] ?? d),
          ),
        );
        if (checkCrl(der, subject, issuer, now)) result.revoked.push(subject.x.subject);
        if (!result.crls.some((c) => c.equals(der))) result.crls.push(der);
        return;
      } catch (e) {
        o.logger?.warn?.('CRL failed', { url, error: String(e) });
      }
    }
    result.missing.push(subject.x.subject);
  };
  await Promise.all(pairs.map(answer));

  result.certificates = [...used.values()].map((c) => c.der);
  return result;
}
