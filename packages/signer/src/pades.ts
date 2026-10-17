/**
 * PAdES-BES/EPES (invisible signature) as an incremental update, the way AutoFirma (iText)
 * structures it:
 *  - signature dictionary: /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached
 *    (or adbe.pkcs7.detached on request), /ByteRange, /Contents (27000 bytes reserved),
 *    /M, /Name (signer CN), /Reason (dropped with a policy), /Location, /ContactInfo;
 *  - an invisible widget/field "SignatureN" (/Rect [0 0 0 0], /F 132) on page 1, AcroForm
 *    /SigFlags 3, and the /Extensions /ESIC (BaseVersion 1.7, ExtensionLevel 1) catalog entry;
 *  - the CMS is CAdES detached over the ByteRange with content-type, message-digest,
 *    signing-certificate-v2 and the optional policy: no signing-time and no content-hints.
 *
 * The original bytes are kept untouched (existing signatures stay valid). pdf-lib is used only to
 * read objects; the update section (classic xref table, or an xref stream when the file uses
 * them) is written here.
 *
 * Not supported (documented gaps): visible signatures, encrypted PDFs, certification (DocMDP),
 * timestamps / LTV.
 */
import crypto from 'node:crypto';
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
import type { ResolvedAlgorithm } from './algorithms';
import { createCades } from './cades';
import { nameAttribute, OID_COMMON_NAME, parseCertificate } from './certificate';
import { AfirmaError } from './errors';
import { type ExtraParams, isTrue } from './extra-params';
import type { KeySigner } from './key';
import { isPdf } from './mime';
import type { SignaturePolicy } from './policy';

export interface PadesSignOptions {
  pdf: Buffer;
  algorithm: ResolvedAlgorithm;
  signer: KeySigner;
  /** Leaf first. */
  chain: Buffer[];
  /** extraParams after policy expansion. */
  params: ExtraParams;
  policy?: SignaturePolicy | null;
  signingTime?: Date;
  /**
   * Index of `pdf` among the documents the user approved: the signer then gets a `pades`
   * binding, so a key that checks what it signs (the phone) can verify the signature covers it.
   */
  document?: number;
}

const DEFAULT_RESERVED_BYTES = 27000;
const SUBFILTERS = new Set(['ETSI.CAdES.detached', 'adbe.pkcs7.detached']);

/** PDF date: D:YYYYMMDDHHmmSS+HH'mm' (local time). */
function pdfDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return (
    `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}'${pad(abs % 60)}'`
  );
}

/** PDF text string: literal for plain ASCII, UTF-16BE hex otherwise. */
function pdfText(text: string): PDFObject {
  if (/^[\x20-\x7e]*$/.test(text) && !/[()\\]/.test(text)) return PDFString.of(text);
  return PDFHexString.fromText(text);
}

function findStartXref(pdf: Buffer): number {
  const tail = pdf.subarray(Math.max(0, pdf.length - 4096)).toString('latin1');
  const all = [...tail.matchAll(/startxref\s+(\d+)/g)];
  const last = all[all.length - 1];
  if (!last) throw AfirmaError.notPdf();
  return Number(last[1]);
}

function previousSize(pdf: Buffer, startXref: number): number {
  const chunk = pdf
    .subarray(startXref, Math.min(pdf.length, startXref + 64 * 1024))
    .toString('latin1');
  if (chunk.startsWith('xref')) {
    const m = /trailer[\s\S]*?\/Size\s+(\d+)/.exec(chunk);
    return m ? Number(m[1]) : 0;
  }
  const m = /\/Size\s+(\d+)/.exec(chunk.slice(0, 4096));
  return m ? Number(m[1]) : 0;
}

function lookupDict(doc: PDFDocument, obj: PDFObject | undefined): PDFDict | undefined {
  if (!obj) return undefined;
  const v = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return v instanceof PDFDict ? v : undefined;
}

function lookupArray(doc: PDFDocument, obj: PDFObject | undefined): PDFArray | undefined {
  if (!obj) return undefined;
  const v = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return v instanceof PDFArray ? v : undefined;
}

/** Names of existing fields (to pick an unused "SignatureN"). */
function fieldNames(doc: PDFDocument, fields: PDFArray | undefined): Set<string> {
  const names = new Set<string>();
  const visit = (arr: PDFArray | undefined, depth: number) => {
    if (!arr || depth > 10) return;
    for (let i = 0; i < arr.size(); i++) {
      const field = lookupDict(doc, arr.get(i));
      if (!field) continue;
      const t = field.get(PDFName.of('T'));
      if (t instanceof PDFString || t instanceof PDFHexString) names.add(t.decodeText());
      visit(lookupArray(doc, field.get(PDFName.of('Kids'))), depth + 1);
    }
  };
  visit(fields, 0);
  return names;
}

/** Refuses PDFs certified with "no changes allowed" (DocMDP P=1), like AutoFirma. */
function checkCertification(doc: PDFDocument, catalog: PDFDict, params: ExtraParams): void {
  const perms = lookupDict(doc, catalog.get(PDFName.of('Perms')));
  const docMdp = perms && lookupDict(doc, perms.get(PDFName.of('DocMDP')));
  if (!docMdp || isTrue(params.allowSigningCertifiedPdfs)) return;
  const refs = lookupArray(doc, docMdp.get(PDFName.of('Reference')));
  for (let i = 0; refs && i < refs.size(); i++) {
    const ref = lookupDict(doc, refs.get(i));
    const tp = ref && lookupDict(doc, ref.get(PDFName.of('TransformParams')));
    const p = tp?.get(PDFName.of('P'));
    if (p instanceof PDFNumber && p.asNumber() === 1) {
      throw new AfirmaError(
        'java.lang.Exception',
        'El PDF esta certificado y no admite nuevas firmas',
        'AF510007',
      );
    }
  }
}

interface PendingObject {
  ref: PDFRef;
  body: Buffer;
}

export async function createPades(opts: PadesSignOptions): Promise<Buffer> {
  const { params } = opts;
  if (!isPdf(opts.pdf)) throw AfirmaError.notPdf();
  const subFilter = params.signatureSubFilter?.trim() || 'ETSI.CAdES.detached';
  if (!SUBFILTERS.has(subFilter)) {
    throw AfirmaError.invalidParameter(`Subfiltro de firma PDF no soportado: ${subFilter}`);
  }
  const reserved =
    Number(params.signReservedSize) > 0 ? Number(params.signReservedSize) : DEFAULT_RESERVED_BYTES;

  if (!Number.isSafeInteger(reserved) || reserved < 1024 || reserved > 1024 * 1024) {
    throw AfirmaError.invalidParameter('signReservedSize debe estar entre 1024 y 1048576 bytes');
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(opts.pdf, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
  } catch {
    throw AfirmaError.notPdf();
  }
  if (doc.isEncrypted || doc.context.trailerInfo.Encrypt) {
    throw AfirmaError.unsupportedOperation('firma de PDF cifrados (ownerPassword/userPassword)');
  }
  const ctx = doc.context;
  const rootRef = ctx.trailerInfo.Root;
  if (!(rootRef instanceof PDFRef)) throw AfirmaError.notPdf();
  const catalog = ctx.lookup(rootRef, PDFDict);
  checkCertification(doc, catalog, params);
  const pages = doc.getPages();
  if (pages.length === 0) throw AfirmaError.notPdf();
  const page = pages[0];

  const original = opts.pdf;
  const prevXref = findStartXref(original);
  const prevIsStream = original.subarray(prevXref, prevXref + 4).toString('latin1') !== 'xref';
  let nextNumber = Math.max(ctx.largestObjectNumber + 1, previousSize(original, prevXref));
  const newRef = () => PDFRef.of(nextNumber++, 0);
  const pending: PendingObject[] = [];
  const write = (ref: PDFRef, obj: PDFObject | string) =>
    pending.push({ ref, body: Buffer.from(obj.toString(), 'latin1') });

  const sigRef = newRef();
  const widgetRef = newRef();

  // AcroForm and field name
  const acroFormEntry = catalog.get(PDFName.of('AcroForm'));
  let acroForm = lookupDict(doc, acroFormEntry);
  if (!acroForm) {
    acroForm = ctx.obj({});
    catalog.set(PDFName.of('AcroForm'), acroForm);
  }
  const fieldsEntry = acroForm.get(PDFName.of('Fields'));
  let fields = lookupArray(doc, fieldsEntry);
  const taken = fieldNames(doc, fields);
  let n = 1;
  while (taken.has(`Signature${n}`)) n++;
  const fieldName = `Signature${n}`;
  if (!fields) {
    fields = ctx.obj([]);
    acroForm.set(PDFName.of('Fields'), fields);
  }
  fields.push(widgetRef);
  acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  if (fieldsEntry instanceof PDFRef) write(fieldsEntry, fields);
  if (acroFormEntry instanceof PDFRef) write(acroFormEntry, acroForm);

  // ESIC developer extension (AutoFirma adds it to every signature) and PDF 1.7
  const extEntry = catalog.get(PDFName.of('Extensions'));
  let extensions = lookupDict(doc, extEntry);
  if (!extensions) {
    extensions = ctx.obj({});
    catalog.set(PDFName.of('Extensions'), extensions);
  }
  extensions.set(
    PDFName.of('ESIC'),
    ctx.obj({ BaseVersion: PDFName.of('1.7'), ExtensionLevel: PDFNumber.of(1) }),
  );
  if (extEntry instanceof PDFRef) write(extEntry, extensions);
  const header = /%PDF-(\d)\.(\d)/.exec(original.subarray(0, 32).toString('latin1'));
  const version = header ? Number(header[1]) * 10 + Number(header[2]) : 17;
  if (version < 17) catalog.set(PDFName.of('Version'), PDFName.of('1.7'));
  // Usage rights would be broken by the new revision (AutoFirma removes them too).
  const perms = lookupDict(doc, catalog.get(PDFName.of('Perms')));
  if (perms && (perms.has(PDFName.of('UR')) || perms.has(PDFName.of('UR3')))) {
    perms.delete(PDFName.of('UR'));
    perms.delete(PDFName.of('UR3'));
    if (catalog.get(PDFName.of('Perms')) instanceof PDFRef) {
      write(catalog.get(PDFName.of('Perms')) as PDFRef, perms);
    }
  }
  write(rootRef, catalog);

  // Page annotations
  const annotsEntry = page.node.get(PDFName.of('Annots'));
  const annots = lookupArray(doc, annotsEntry);
  if (annots) {
    annots.push(widgetRef);
    if (annotsEntry instanceof PDFRef) write(annotsEntry, annots);
    else write(page.ref, page.node);
  } else {
    page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
    write(page.ref, page.node);
  }

  // Widget / field
  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    T: PDFString.of(fieldName),
    V: sigRef,
    Rect: [0, 0, 0, 0],
    F: 132,
    P: page.ref,
  });
  write(widgetRef, widget);

  // Signature dictionary with placeholders
  const leaf = parseCertificate(opts.chain[0]);
  const signerName = nameAttribute(leaf.tbsCertificate.subject, OID_COMMON_NAME);
  const time = opts.signingTime ?? new Date();
  const contentsPlaceholder = `<${'0'.repeat(reserved * 2)}>`;
  const byteRangePlaceholder = `[0 ${'0'.repeat(10)} ${'0'.repeat(10)} ${'0'.repeat(10)}]`;
  const extra: string[] = [];
  extra.push(`/M ${PDFString.of(pdfDate(time)).toString()}`);
  if (signerName) extra.push(`/Name ${pdfText(signerName).toString()}`);
  if (params.signReason && !opts.policy)
    extra.push(`/Reason ${pdfText(params.signReason).toString()}`);
  if (params.signatureProductionCity) {
    extra.push(`/Location ${pdfText(params.signatureProductionCity).toString()}`);
  }
  if (params.signerContact) extra.push(`/ContactInfo ${pdfText(params.signerContact).toString()}`);
  const sigBody =
    `<<\n/Type /Sig\n/Filter /Adobe.PPKLite\n/SubFilter /${subFilter}\n` +
    `/ByteRange ${byteRangePlaceholder}\n/Contents ${contentsPlaceholder}\n${extra.join('\n')}\n>>`;
  write(sigRef, sigBody);

  // Assemble the incremental update
  const parts: Buffer[] = [original];
  let offset = original.length;
  const lastByte = original[original.length - 1];
  if (lastByte !== 0x0a && lastByte !== 0x0d) {
    parts.push(Buffer.from('\n'));
    offset += 1;
  }
  const offsets = new Map<number, { offset: number; gen: number }>();
  let sigObjectOffset = -1;
  for (const obj of pending) {
    const head = Buffer.from(`${obj.ref.objectNumber} ${obj.ref.generationNumber} obj\n`, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    offsets.set(obj.ref.objectNumber, { offset, gen: obj.ref.generationNumber });
    if (obj.ref === sigRef) sigObjectOffset = offset + head.length;
    parts.push(head, obj.body, tail);
    offset += head.length + obj.body.length + tail.length;
  }

  const id0 = (() => {
    const id = ctx.trailerInfo.ID;
    const arr = id instanceof PDFArray ? id : undefined;
    const first = arr?.get(0);
    return first ? first.toString() : `<${crypto.randomBytes(16).toString('hex')}>`;
  })();
  const id1 = `<${crypto.createHash('md5').update(original).update(String(time.getTime())).digest('hex')}>`;
  const info = ctx.trailerInfo.Info ? `/Info ${ctx.trailerInfo.Info.toString()}\n` : '';
  const xrefStart = offset;
  if (prevIsStream) {
    const xrefRef = newRef();
    offsets.set(xrefRef.objectNumber, { offset: xrefStart, gen: 0 });
    const numbers = [...offsets.keys()].sort((a, b) => a - b);
    const rows = numbers.map((num) => {
      const e = offsets.get(num) as { offset: number; gen: number };
      const row = Buffer.alloc(7);
      row[0] = 1;
      row.writeUInt32BE(e.offset, 1);
      row.writeUInt16BE(e.gen, 5);
      return row;
    });
    const data = Buffer.concat(rows);
    const index = numbers.map((num) => `${num} 1`).join(' ');
    const dict =
      `<<\n/Type /XRef\n/Size ${nextNumber}\n/W [1 4 2]\n/Index [${index}]\n/Root ${rootRef.toString()}\n` +
      `${info}/ID [${id0} ${id1}]\n/Prev ${prevXref}\n/Length ${data.length}\n>>`;
    parts.push(
      Buffer.from(`${xrefRef.objectNumber} 0 obj\n${dict}\nstream\n`, 'latin1'),
      data,
      Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefStart}\n%%EOF\n`, 'latin1'),
    );
  } else {
    const numbers = [...offsets.keys()].sort((a, b) => a - b);
    let table = 'xref\n';
    for (let i = 0; i < numbers.length; ) {
      let j = i;
      while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
      table += `${numbers[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) {
        const e = offsets.get(numbers[k]) as { offset: number; gen: number };
        table += `${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n\r\n`;
      }
      i = j + 1;
    }
    table +=
      `trailer\n<<\n/Size ${nextNumber}\n/Root ${rootRef.toString()}\n${info}` +
      `/ID [${id0} ${id1}]\n/Prev ${prevXref}\n>>\nstartxref\n${xrefStart}\n%%EOF\n`;
    parts.push(Buffer.from(table, 'latin1'));
  }
  const out = Buffer.concat(parts);

  // ByteRange and signature
  const sigText = out.subarray(sigObjectOffset, sigObjectOffset + 256).toString('latin1');
  const brRel = sigText.indexOf('/ByteRange ');
  const contentsRel = sigText.indexOf('/Contents <');
  if (brRel < 0 || contentsRel < 0) throw AfirmaError.internal('Error preparando la firma PDF');
  const contentsStart = sigObjectOffset + contentsRel + '/Contents '.length;
  const contentsEnd = contentsStart + contentsPlaceholder.length;
  const byteRange = [0, contentsStart, contentsEnd, out.length - contentsEnd];
  const brText = `[${byteRange.join(' ')}`;
  const brSlot = sigObjectOffset + brRel + '/ByteRange '.length;
  out.write(brText.padEnd(byteRangePlaceholder.length - 1, ' '), brSlot, 'latin1');

  const signedBytes = Buffer.concat([out.subarray(0, contentsStart), out.subarray(contentsEnd)]);
  const cms = await createCades({
    data: signedBytes,
    implicit: false,
    algorithm: opts.algorithm,
    signer: opts.signer,
    chain: opts.chain,
    // The signed PDF is the original plus this incremental update (placeholder still zeros).
    ...(opts.document !== undefined
      ? {
          binding: {
            kind: 'pades' as const,
            document: opts.document,
            update: Buffer.from(out.subarray(original.length)),
            byteRange: byteRange as [number, number, number, number],
          },
        }
      : {}),
    includeOnlySigningCertificate: isTrue(params.includeOnlySignningCertificate),
    attributes: {
      policy: opts.policy,
      signingTime: null,
      contentHints: null,
      claimedRoles: params.signerClaimedRoles?.split('|').filter(Boolean),
      includeCertificatePolicies: !isTrue(params.doNotIncludePolicyOnSigningCertificate),
    },
  });
  const hex = cms.toString('hex');
  if (hex.length > reserved * 2) {
    throw AfirmaError.invalidParameter(
      'La firma no cabe en el espacio reservado (signReservedSize)',
    );
  }
  out.write(hex, contentsStart + 1, 'latin1');
  return out;
}
