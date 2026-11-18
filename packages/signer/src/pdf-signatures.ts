/**
 * The signatures a PDF already holds (ours, AutoFirma's, Acrobat's…): who signed, when and with
 * which certificate, for Mis documentos. It only reads them: nothing here says a signature is
 * valid.
 */
import type * as cms from '@peculiar/asn1-cms';
import { AsnConvert } from '@peculiar/asn1-schema';
import type { Certificate, Name } from '@peculiar/asn1-x509';
import type { DocumentSignature } from '@sa/shared';
import * as asn1js from 'asn1js';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import { displayName } from './appearance';
import { parseCades } from './cades';
import { nameAttribute, parseHolder } from './certificate';

const OID_COMMON_NAME = '2.5.4.3';
const OID_ORGANIZATION = '2.5.4.10';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
const OID_SIGNATURE_TIMESTAMP = '1.2.840.113549.1.9.16.2.14';

/** The PDF's signatures in signing order; none when it isn't a readable PDF. */
export async function pdfSignatures(pdf: Uint8Array): Promise<DocumentSignature[]> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
  } catch {
    return [];
  }
  const found: { end: number; signature: DocumentSignature }[] = [];
  for (const value of signatureValues(doc)) {
    try {
      const signature = readSignature(value);
      if (signature) found.push({ end: coveredEnd(doc, value), signature });
    } catch {
      // A damaged or unusual signature: leave it out rather than fail the whole list.
    }
  }
  return found.sort((a, b) => a.end - b.end).map((f) => f.signature);
}

/** The signature dictionaries (/V) of the form's signature fields. */
function signatureValues(doc: PDFDocument): PDFDict[] {
  const form = lookupDict(doc, doc.catalog.get(PDFName.of('AcroForm')));
  const out: PDFDict[] = [];
  const seen = new Set<PDFDict>();
  const visit = (fields: PDFObject | undefined, depth: number) => {
    const list = lookup(doc, fields);
    if (!(list instanceof PDFArray) || depth > 16) return;
    for (const item of list.asArray()) {
      const field = lookupDict(doc, item);
      if (!field) continue;
      const value = lookupDict(doc, field.get(PDFName.of('V')));
      if (value?.has(PDFName.of('ByteRange')) && !seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
      visit(field.get(PDFName.of('Kids')), depth + 1);
    }
  };
  visit(form?.get(PDFName.of('Fields')), 0);
  return out;
}

function readSignature(value: PDFDict): DocumentSignature | undefined {
  // Document timestamps (/DocTimeStamp, ETSI.RFC3161) have no signer.
  if (value.get(PDFName.of('Type'))?.toString() === '/DocTimeStamp') return undefined;
  const contents = value.get(PDFName.of('Contents'));
  if (!(contents instanceof PDFHexString || contents instanceof PDFString)) return undefined;
  const { signedData } = parseCades(derOnly(contents.asBytes()));
  const signerInfo = signedData.signerInfos[0];
  if (!signerInfo) return undefined;
  const certificate = signerCertificate(signedData, signerInfo);
  if (!certificate) return undefined;
  const { subject, issuer } = certificate.tbsCertificate;
  const holder = parseHolder(subject);
  const name =
    holder.holderName ??
    nameAttribute(subject, OID_COMMON_NAME) ??
    nameAttribute(subject, OID_ORGANIZATION);
  if (!name) return undefined;

  const timestamp = timestampTime(signerInfo);
  const signedAt = timestamp ?? pdfDateValue(value.get(PDFName.of('M'))) ?? signingTime(signerInfo);
  return {
    name: displayName(name),
    ...(signedAt ? { signedAt: signedAt.toISOString() } : {}),
    timestamped: timestamp !== undefined,
    issuer: nameAttribute(issuer, OID_COMMON_NAME) ?? nameAttribute(issuer, OID_ORGANIZATION) ?? '',
    dnie: isDnie(issuer),
  };
}

/** /Contents is padded with zeros after the DER. */
function derOnly(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== 0x30) return bytes;
  const first = bytes[1];
  if (first < 0x80) return bytes.subarray(0, first + 2);
  const count = first & 0x7f;
  let length = 0;
  for (let i = 0; i < count; i++) length = length * 256 + bytes[2 + i];
  return bytes.subarray(0, Math.min(bytes.length, 2 + count + length));
}

function signerCertificate(
  signedData: cms.SignedData,
  signerInfo: cms.SignerInfo,
): Certificate | undefined {
  const certificates = (signedData.certificates ?? [])
    .map((c) => c.certificate)
    .filter((c): c is Certificate => c !== undefined);
  const byIssuer = signerInfo.sid.issuerAndSerialNumber;
  const byKey = signerInfo.sid.subjectKeyIdentifier;
  const match = certificates.find((cert) => {
    const tbs = cert.tbsCertificate;
    if (byIssuer) {
      return (
        equalBytes(tbs.serialNumber, byIssuer.serialNumber) &&
        equalBytes(AsnConvert.serialize(tbs.issuer), AsnConvert.serialize(byIssuer.issuer))
      );
    }
    if (byKey) {
      const ski = tbs.extensions?.find((e) => e.extnID === '2.5.29.14');
      return ski ? equalBytes(ski.extnValue.buffer.slice(2), byKey.buffer) : false;
    }
    return false;
  });
  return match ?? certificates[0];
}

function equalBytes(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean {
  const x = bytesOf(a);
  const y = bytesOf(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function bytesOf(v: ArrayBuffer | ArrayBufferView): Uint8Array {
  return v instanceof ArrayBuffer
    ? new Uint8Array(v)
    : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/** The genTime of a signature timestamp (PAdES-B-T), from its TSTInfo. */
function timestampTime(signerInfo: cms.SignerInfo): Date | undefined {
  const token = signerInfo.unsignedAttrs?.find((a) => a.attrType === OID_SIGNATURE_TIMESTAMP)
    ?.attrValues[0];
  if (!token) return undefined;
  const { content } = parseCades(new Uint8Array(token));
  if (!content) return undefined;
  const tstInfo = asn1js.fromBER(new Uint8Array(content));
  if (tstInfo.offset === -1 || !(tstInfo.result instanceof asn1js.Sequence)) return undefined;
  const genTime = tstInfo.result.valueBlock.value[4];
  return genTime instanceof asn1js.GeneralizedTime ? genTime.toDate() : undefined;
}

/** CMS signing-time (PAdES leaves it out for /M; plain PKCS#7 signatures have it). */
function signingTime(signerInfo: cms.SignerInfo): Date | undefined {
  const value = signerInfo.signedAttrs?.find((a) => a.attrType === OID_SIGNING_TIME)?.attrValues[0];
  if (!value) return undefined;
  const parsed = asn1js.fromBER(new Uint8Array(value));
  const time = parsed.result;
  return time instanceof asn1js.UTCTime || time instanceof asn1js.GeneralizedTime
    ? time.toDate()
    : undefined;
}

/** A PDF date (`D:YYYYMMDDHHmmSS+HH'mm'`, every part after the year optional). */
function pdfDateValue(value: PDFObject | undefined): Date | undefined {
  if (!(value instanceof PDFString || value instanceof PDFHexString)) return undefined;
  const m = value
    .decodeText()
    .match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz]|[+-]\d{2}'?(?:\d{2}'?)?)?/);
  if (!m) return undefined;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', zone] = m;
  let offset = 'Z';
  if (zone && !/^[Zz]$/.test(zone)) {
    const digits = zone.replace(/'/g, '');
    offset = `${digits.slice(0, 3)}:${digits.slice(3, 5) || '00'}`;
  }
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The DNIe's CAs: "AC DNIE 00x", O=DIRECCION GENERAL DE LA POLICIA. */
function isDnie(issuer: Name): boolean {
  const cn = nameAttribute(issuer, OID_COMMON_NAME) ?? '';
  const org = nameAttribute(issuer, OID_ORGANIZATION) ?? '';
  return /^AC DNIE\b/i.test(cn) || /DIRECCION GENERAL DE LA POLICIA/i.test(org);
}

/** Where the signed bytes end, to sort signatures in the order they were made. */
function coveredEnd(doc: PDFDocument, value: PDFDict): number {
  const range = lookup(doc, value.get(PDFName.of('ByteRange')));
  if (!(range instanceof PDFArray) || range.size() !== 4) return 0;
  const [, , c, d] = range.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : 0));
  return c + d;
}

function lookup(doc: PDFDocument, obj: PDFObject | undefined): PDFObject | undefined {
  return obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
}

function lookupDict(doc: PDFDocument, obj: PDFObject | undefined): PDFDict | undefined {
  const v = lookup(doc, obj);
  return v instanceof PDFDict ? v : undefined;
}
