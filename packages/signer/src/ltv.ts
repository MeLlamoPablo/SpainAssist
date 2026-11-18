/**
 * Long-term PAdES (B-T and B-LT), applied after a PDF is signed, once the key is released:
 *
 *  1. B-T: a TSA timestamps the signature value; the token goes into the CMS as the unsigned
 *     signatureTimeStampToken attribute. /Contents is outside the signed byte range and the
 *     attribute is unsigned, so the signature stays valid. The CMS is edited in its raw DER:
 *     every signed byte stays as it was.
 *  2. B-LT: the certificates of the signer and of the TSA up to their roots, with OCSP responses
 *     (or CRLs) for each one below a root, go into a Document Security Store (/DSS) appended as
 *     another incremental update, with a /VRI entry for the signature.
 *  3. On request (AutoFirma's tsType 2 or 3), a document timestamp over the whole file.
 *
 * Every step degrades instead of failing: no TSA answer leaves the signature as it was (B-B),
 * missing revocation data leaves it B-T. The one hard stop is a signer certificate that its CA
 * says is revoked: such a signature is worthless, and the user must know.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import * as asn1js from 'asn1js';
import { type PDFDict, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import { parseCades } from './cades';
import { findSignerCertificate, signedDataCertificates } from './cms-verify';
import { AfirmaError } from './errors';
import { addDocumentTimestamp } from './pades';
import { PdfUpdate } from './pdf-update';
import { collectValidationData, type ValidationData } from './revocation';
import { type Timestamp, type TsaEndpoint, timestampWithFallback } from './tsp';

export interface PadesUpgradeOptions {
  fetch: typeof fetch;
  /** TSAs in order of preference. */
  tsas: TsaEndpoint[];
  /** Also add a document timestamp after the validation data (AutoFirma's tsType 2 or 3). */
  documentTimestamp?: boolean;
  /** CA certificates to complete chains with (besides those in the signature). */
  authorities?: Uint8Array[];
  /** Per network request (default 10 s). */
  timeoutMs?: number;
  now?: Date;
  logger?: {
    info?(msg: string, data?: unknown): void;
    warn?(msg: string, data?: unknown): void;
  };
}

export type PadesLevel = 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';

export interface PadesUpgrade {
  pdf: Buffer;
  /** The level reached (B-T also when some revocation data is missing). */
  level: PadesLevel;
  /** The TSA that timestamped the signature. */
  tsa?: string;
  /** Certificates left without revocation data or chain (subjects), when not B-LT. */
  missing: string[];
}

const OID_SIGNATURE_TIMESTAMP = '1.2.840.113549.1.9.16.2.14';

// --- DER surgery -----------------------------------------------------------------------------

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Buffer.from([0x80 | out.length, ...out]);
}

function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function raw(block: asn1js.AsnType): Buffer {
  return Buffer.from((block as asn1js.BaseBlock).valueBeforeDecodeView);
}

function children(block: asn1js.AsnType): asn1js.AsnType[] {
  return (block as asn1js.Constructed).valueBlock.value;
}

function isContext(block: asn1js.AsnType, n: number): boolean {
  const id = (block as asn1js.BaseBlock).idBlock;
  return id.tagClass === 3 && id.tagNumber === n;
}

/**
 * `cms` (a ContentInfo with SignedData) with `attribute` (DER) added to the unsigned attributes
 * of its first signer. Only lengths around it change.
 */
export function addUnsignedAttribute(cms: Uint8Array, attribute: Buffer): Buffer {
  const parsed = asn1js.fromBER(cms);
  if (parsed.offset === -1) throw AfirmaError.notSignature();
  const [oid, explicit] = children(parsed.result);
  const signedData = children(explicit)[0];
  const sdParts = children(signedData);
  const signerInfos = sdParts[sdParts.length - 1];
  const [first, ...others] = children(signerInfos);
  if (!first) throw AfirmaError.notSignature();
  const siParts = children(first);
  const last = siParts[siParts.length - 1];
  const existing = isContext(last, 1) ? children(last).map(raw) : [];
  const kept = (isContext(last, 1) ? siParts.slice(0, -1) : siParts).map(raw);
  const unsigned = der(0xa1, Buffer.concat([...existing, attribute]));
  const signerInfo = der(0x30, Buffer.concat([...kept, unsigned]));
  const infos = der(0x31, Buffer.concat([signerInfo, ...others.map(raw)]));
  const sd = der(0x30, Buffer.concat([...sdParts.slice(0, -1).map(raw), infos]));
  return der(0x30, Buffer.concat([raw(oid), der(0xa0, sd)]));
}

// --- The signature in the file ---------------------------------------------------------------

interface SignatureSlot {
  /** Where the hex digits of /Contents start and how many there are. */
  hexStart: number;
  hexLength: number;
  cms: Buffer;
}

/** The last signature of `pdf` (the one just made): its /Contents slot and CMS. */
function lastSignature(pdf: Buffer): SignatureSlot {
  const text = pdf.toString('latin1');
  const all = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  const range = all.at(-1);
  if (!range) throw AfirmaError.notSignature();
  const [, b, c] = range.slice(1).map(Number);
  if (pdf[b] !== 0x3c || pdf[c - 1] !== 0x3e) throw AfirmaError.notSignature();
  const hexStart = b + 1;
  const hexLength = c - 1 - hexStart;
  const contents = Buffer.from(
    pdf.subarray(hexStart, hexStart + hexLength).toString('latin1'),
    'hex',
  );
  const parsed = asn1js.fromBER(contents);
  if (parsed.offset === -1) throw AfirmaError.notSignature();
  return { hexStart, hexLength, cms: Buffer.from(contents.subarray(0, parsed.offset)) };
}

/** VRI key: the uppercase hex SHA-1 of the signature's /Contents bytes, padding included. */
function vriKey(pdf: Buffer, slot: SignatureSlot): string {
  const contents = Buffer.from(
    pdf.subarray(slot.hexStart, slot.hexStart + slot.hexLength).toString('latin1'),
    'hex',
  );
  return crypto.createHash('sha1').update(contents).digest('hex').toUpperCase();
}

// --- DSS -------------------------------------------------------------------------------------

/** PDF date for /TU: D:YYYYMMDDHHmmSSZ. */
function pdfUtcDate(d: Date): string {
  return `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
}

/** Appends a /DSS (merged with an existing one) with `data` and a /VRI entry for `key`. */
async function appendDss(
  pdf: Buffer,
  data: ValidationData,
  key: string,
  now: Date,
): Promise<Buffer> {
  const update = await PdfUpdate.open(pdf);
  const { ctx, catalog, rootRef } = update;
  const existing = update.lookupDict(catalog.get(PDFName.of('DSS')));
  const refsOf = (name: string): PDFRef[] => {
    const arr = update.lookupArray(existing?.get(PDFName.of(name)));
    return (arr?.asArray() ?? []).filter((r): r is PDFRef => r instanceof PDFRef);
  };
  const stream = (body: Buffer): PDFRef => {
    const ref = update.newRef();
    update.writeStream(ref, '/Filter /FlateDecode', zlib.deflateSync(body));
    return ref;
  };
  const certs = data.certificates.map(stream);
  const ocsps = data.ocsps.map(stream);
  const crls = data.crls.map(stream);

  const vri = update.lookupDict(existing?.get(PDFName.of('VRI'))) ?? ctx.obj({});
  const entry = ctx.obj({}) as PDFDict;
  if (certs.length) entry.set(PDFName.of('Cert'), ctx.obj(certs));
  if (ocsps.length) entry.set(PDFName.of('OCSP'), ctx.obj(ocsps));
  if (crls.length) entry.set(PDFName.of('CRL'), ctx.obj(crls));
  entry.set(PDFName.of('TU'), PDFString.of(pdfUtcDate(now)));
  vri.set(PDFName.of(key), entry);

  const dss = ctx.obj({}) as PDFDict;
  dss.set(PDFName.of('Type'), PDFName.of('DSS'));
  const merged = (name: string, added: PDFRef[]) => {
    const all = [...refsOf(name), ...added];
    if (all.length) dss.set(PDFName.of(name), ctx.obj(all));
  };
  merged('Certs', certs);
  merged('OCSPs', ocsps);
  merged('CRLs', crls);
  dss.set(PDFName.of('VRI'), vri);
  const dssRef = update.newRef();
  update.write(dssRef, dss);
  catalog.set(PDFName.of('DSS'), dssRef);

  // Adobe's extension level for the DSS (as iText and Acrobat write it).
  const extEntry = catalog.get(PDFName.of('Extensions'));
  const extensions = update.lookupDict(extEntry) ?? ctx.obj({});
  extensions.set(
    PDFName.of('ADBE'),
    ctx.obj({ BaseVersion: PDFName.of('1.7'), ExtensionLevel: PDFNumber.of(8) }),
  );
  if (extEntry instanceof PDFRef) update.write(extEntry, extensions);
  else catalog.set(PDFName.of('Extensions'), extensions);
  update.write(rootRef, catalog);
  return update.finish(`dss-${now.getTime()}`).pdf;
}

// --- Upgrade ---------------------------------------------------------------------------------

/** Adds a timestamp and the validation data to the PDF's last signature (see the header). */
export async function upgradePades(pdf: Buffer, o: PadesUpgradeOptions): Promise<PadesUpgrade> {
  const now = o.now ?? new Date();
  const net = { fetch: o.fetch, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) };
  const logger = o.logger;
  const slot = lastSignature(pdf);
  const { signedData } = parseCades(slot.cms);
  const signerInfo = signedData.signerInfos[0];
  if (!signerInfo) throw AfirmaError.notSignature();
  const cmsCertificates = signedDataCertificates(signedData);
  const signer = findSignerCertificate(signerInfo, cmsCertificates);
  if (!signer) throw AfirmaError.notSignature();

  // 1. B-T
  const timestamp: Timestamp | undefined = await timestampWithFallback(
    o.tsas,
    Buffer.from(signerInfo.signature.buffer),
    { ...net, ...(logger ? { logger } : {}) },
  );
  if (!timestamp) return { pdf, level: 'B-B', missing: [] };
  const attribute = der(
    0x30,
    Buffer.concat([
      Buffer.from(new asn1js.ObjectIdentifier({ value: OID_SIGNATURE_TIMESTAMP }).toBER()),
      der(0x31, timestamp.token),
    ]),
  );
  const cms = addUnsignedAttribute(slot.cms, attribute);
  const hex = cms.toString('hex');
  if (hex.length > slot.hexLength) {
    logger?.warn?.('no room for the timestamp in the signature', {
      needed: hex.length / 2,
      reserved: slot.hexLength / 2,
    });
    return { pdf, level: 'B-B', missing: [] };
  }
  const stamped = Buffer.from(pdf);
  stamped.write(hex.padEnd(slot.hexLength, '0'), slot.hexStart, 'latin1');

  // 2. B-LT
  const pool = [
    ...cmsCertificates,
    ...timestamp.certificates,
    ...(o.authorities ?? []).map((a) => Buffer.from(a)),
  ];
  const cache = new Map<string, Promise<Buffer>>();
  const [forSigner, forTsa] = await Promise.all(
    [signer, timestamp.tsaCertificate].map((leaf) =>
      collectValidationData([leaf], pool, { ...net, now, cache, ...(logger ? { logger } : {}) }),
    ),
  );
  if (forSigner.revoked.length) {
    throw AfirmaError.revokedCertificate(forSigner.revoked[0]);
  }
  const missing = [
    ...forSigner.missing,
    ...forSigner.incomplete,
    ...forTsa.missing,
    ...forTsa.incomplete,
    ...forTsa.revoked,
  ];
  const unique = (list: Buffer[]) =>
    list.filter((b, i) => list.findIndex((other) => other.equals(b)) === i);
  const data: ValidationData = {
    certificates: unique([...forSigner.certificates, ...forTsa.certificates]),
    ocsps: unique([...forSigner.ocsps, ...forTsa.ocsps]),
    crls: unique([...forSigner.crls, ...forTsa.crls]),
  };
  if (data.ocsps.length === 0 && data.crls.length === 0) {
    logger?.warn?.('no revocation data: the signature stays B-T', { missing });
    return { pdf: stamped, level: 'B-T', tsa: timestamp.url, missing };
  }
  let out = await appendDss(stamped, data, vriKey(stamped, slot), now);
  let level: PadesLevel = missing.length ? 'B-T' : 'B-LT';

  // 3. Document timestamp
  if (o.documentTimestamp) {
    try {
      out = await addDocumentTimestamp(out, async (signedBytes) => {
        const docTimestamp = await timestampWithFallback(o.tsas, signedBytes, {
          ...net,
          ...(logger ? { logger } : {}),
        });
        if (!docTimestamp) throw new Error('No TSA answered');
        return docTimestamp.token;
      });
      if (level === 'B-LT') level = 'B-LTA';
    } catch (e) {
      logger?.warn?.('document timestamp failed', { error: String(e) });
    }
  }
  logger?.info?.('PAdES upgraded', { level, tsa: timestamp.url, missing: missing.length });
  return { pdf: out, level, tsa: timestamp.url, missing };
}
