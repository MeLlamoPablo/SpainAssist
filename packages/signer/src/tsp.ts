/**
 * RFC 3161 timestamps: a timestamp authority (TSA) signs "this hash existed at this time". A
 * signature timestamp (PAdES-B-T) covers the signature value; a document timestamp covers the
 * whole PDF. Each answer is checked (status, hash, nonce, the TSA's signature and its
 * timeStamping certificate) before it is used; a TSA that fails is skipped for the next one.
 */
import crypto from 'node:crypto';
import { AsnConvert } from '@peculiar/asn1-schema';
import * as x509 from '@peculiar/asn1-x509';
import * as asn1js from 'asn1js';
import { type DigestName, digestOid } from './algorithms';
import { parseCades } from './cades';
import { digestOfOid, signedDataCertificates, verifySignedData } from './cms-verify';

export interface TsaEndpoint {
  url: string;
  /** TSA policy to ask for (reqPolicy); none: the TSA's default. */
  policy?: string;
  /** Hash of the timestamped data (default SHA-256). */
  digest?: DigestName;
  /** HTTP basic authentication (AutoFirma's tsaUsr / tsaPwd). */
  username?: string;
  password?: string;
}

export interface Timestamp {
  /** The TimeStampToken: a CMS ContentInfo with the signed TSTInfo. */
  token: Buffer;
  url: string;
  genTime: Date;
  /** The TSA's signing certificate (DER). */
  tsaCertificate: Buffer;
  /** Every certificate the token carries (DER), the TSA's first. */
  certificates: Buffer[];
}

export interface TimestampOptions {
  fetch: typeof fetch;
  /** Per TSA (default 10 s). */
  timeoutMs?: number;
  logger?: { warn?(msg: string, data?: unknown): void };
}

const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OID_KP_TIME_STAMPING = '1.3.6.1.5.5.7.3.8';
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/** A TimeStampReq for `hash` (computed with `digest`), asking for the TSA's certificate. */
export function timestampRequest(
  digest: DigestName,
  hash: Uint8Array,
  nonce: Uint8Array,
  policy?: string,
): Buffer {
  const req = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 1 }),
      new asn1js.Sequence({
        value: [
          new asn1js.Sequence({
            value: [new asn1js.ObjectIdentifier({ value: digestOid(digest) }), new asn1js.Null()],
          }),
          new asn1js.OctetString({ valueHex: hash }),
        ],
      }),
      ...(policy ? [new asn1js.ObjectIdentifier({ value: policy })] : []),
      new asn1js.Integer({ valueHex: nonce }),
      new asn1js.Boolean({ value: true }),
    ],
  });
  return Buffer.from(req.toBER());
}

interface TstInfo {
  policy: string;
  digestOid: string;
  hash: Buffer;
  genTime: Date;
  nonce?: Buffer;
}

function parseTstInfo(der: Uint8Array): TstInfo {
  const parsed = asn1js.fromBER(der);
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    throw new Error('TSTInfo is not a SEQUENCE');
  }
  const items = parsed.result.valueBlock.value;
  const policy = items[1];
  const imprint = items[2];
  const genTime = items[4];
  if (
    !(policy instanceof asn1js.ObjectIdentifier) ||
    !(imprint instanceof asn1js.Sequence) ||
    !(genTime instanceof asn1js.GeneralizedTime)
  ) {
    throw new Error('Malformed TSTInfo');
  }
  const [alg, hash] = imprint.valueBlock.value;
  const algOid = alg instanceof asn1js.Sequence ? alg.valueBlock.value[0] : undefined;
  if (!(algOid instanceof asn1js.ObjectIdentifier) || !(hash instanceof asn1js.OctetString)) {
    throw new Error('Malformed messageImprint');
  }
  // After genTime: accuracy (SEQUENCE), ordering (BOOLEAN), nonce (INTEGER), tsa [0], extensions [1].
  const nonce = items.slice(5).find((i) => i instanceof asn1js.Integer) as
    | asn1js.Integer
    | undefined;
  return {
    policy: policy.valueBlock.toString(),
    digestOid: algOid.valueBlock.toString(),
    hash: Buffer.from(hash.valueBlock.valueHexView),
    genTime: genTime.toDate(),
    ...(nonce ? { nonce: Buffer.from(nonce.valueBlock.valueHexView) } : {}),
  };
}

/** Big-endian integers compare equal whatever their leading zeros. */
function sameInteger(a: Uint8Array, b: Uint8Array): boolean {
  const strip = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    return Buffer.from(x.subarray(i));
  };
  return strip(a).equals(strip(b));
}

function hasTimeStampingUsage(certificate: Uint8Array): boolean {
  const cert = AsnConvert.parse(certificate, x509.Certificate);
  const ext = cert.tbsCertificate.extensions?.find((e) => e.extnID === x509.id_ce_extKeyUsage);
  if (!ext) return false;
  const usages = AsnConvert.parse(ext.extnValue, x509.ExtendedKeyUsage);
  return usages.some((u) => u === OID_KP_TIME_STAMPING);
}

/**
 * Reads and checks a TimeStampToken for `hash`: a SignedData over a TSTInfo with that imprint
 * (and `nonce`, when given), signed by a timeStamping certificate it carries.
 */
export function verifyTimestampToken(
  token: Uint8Array,
  digest: DigestName,
  hash: Uint8Array,
  nonce?: Uint8Array,
): Omit<Timestamp, 'url'> {
  const { signedData, content } = parseCades(token);
  if (signedData.encapContentInfo.eContentType !== OID_TST_INFO || !content) {
    throw new Error('Not a timestamp token');
  }
  const info = parseTstInfo(content);
  if (digestOfOid(info.digestOid) !== digest || !info.hash.equals(Buffer.from(hash))) {
    throw new Error('The timestamp is for other data');
  }
  if (nonce && (!info.nonce || !sameInteger(info.nonce, nonce))) {
    throw new Error('The timestamp answers another request (nonce)');
  }
  const tsaCertificate = verifySignedData(signedData, content);
  if (!tsaCertificate) throw new Error('The timestamp signature does not verify');
  if (!hasTimeStampingUsage(tsaCertificate)) {
    throw new Error('The TSA certificate is not for timestamping');
  }
  const certificates = signedDataCertificates(signedData);
  return {
    token: Buffer.from(token),
    genTime: info.genTime,
    tsaCertificate,
    certificates: [tsaCertificate, ...certificates.filter((c) => !c.equals(tsaCertificate))],
  };
}

/** The token out of a TimeStampResp, when the TSA granted it. */
function tokenOfResponse(der: Uint8Array): Buffer {
  const parsed = asn1js.fromBER(der);
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    throw new Error('Not a TimeStampResp');
  }
  const [statusInfo, token] = parsed.result.valueBlock.value;
  const status = statusInfo instanceof asn1js.Sequence ? statusInfo.valueBlock.value[0] : undefined;
  if (!(status instanceof asn1js.Integer)) throw new Error('Not a TimeStampResp');
  const code = status.valueBlock.valueDec;
  // 0 granted, 1 grantedWithMods; anything else is a refusal.
  if (code !== 0 && code !== 1) throw new Error(`The TSA refused the request (status ${code})`);
  if (!token) throw new Error('The TSA sent no token');
  return Buffer.from(token.valueBeforeDecodeView);
}

/** One TSA, one request: the verified timestamp of `data`, or an error. */
export async function requestTimestamp(
  tsa: TsaEndpoint,
  data: Uint8Array,
  o: TimestampOptions,
): Promise<Timestamp> {
  const digest = tsa.digest ?? 'sha256';
  const hash = crypto.createHash(digest).update(data).digest();
  const nonce = crypto.randomBytes(8);
  nonce[0] = (nonce[0] & 0x7f) | 0x01;
  const url = new URL(tsa.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported TSA scheme ${url.protocol}`);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/timestamp-query',
    Accept: 'application/timestamp-reply',
  };
  if (tsa.username) {
    const credentials = `${tsa.username}:${tsa.password ?? ''}`;
    headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }
  const res = await o.fetch(tsa.url, {
    method: 'POST',
    headers,
    body: new Uint8Array(timestampRequest(digest, hash, nonce, tsa.policy)),
    signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_RESPONSE_BYTES) throw new Error('The TSA answer is too large');
  const token = tokenOfResponse(body);
  return { url: tsa.url, ...verifyTimestampToken(token, digest, hash, nonce) };
}

/** The first TSA of `tsas` that answers well; undefined when none does. */
export async function timestampWithFallback(
  tsas: TsaEndpoint[],
  data: Uint8Array,
  o: TimestampOptions,
): Promise<Timestamp | undefined> {
  for (const tsa of tsas) {
    try {
      return await requestTimestamp(tsa, data, o);
    } catch (e) {
      o.logger?.warn?.('timestamp authority failed', {
        url: tsa.url,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return undefined;
}
