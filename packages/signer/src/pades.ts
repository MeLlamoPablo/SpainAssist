/**
 * PAdES-BES/EPES (invisible signature) as an incremental update, the way AutoFirma (iText)
 * structures it:
 *  - signature dictionary: /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached
 *    (or adbe.pkcs7.detached on request), /ByteRange, /Contents (27000 bytes reserved),
 *    /M, /Name (signer CN), /Reason (dropped with a policy), /Location, /ContactInfo;
 *  - an invisible widget/field "SignatureN" (/Rect [0 0 0 0], /F 132) on page 1, AcroForm
 *    /SigFlags 3, and the /Extensions /ESIC (BaseVersion 1.7, ExtensionLevel 1) catalog entry;
 *  - or, for a visible signature, the widget on the chosen page(s) with its /Rect and an
 *    appearance (/AP /N, a Form XObject from `appearance.ts`, drawn upright on rotated pages),
 *    or an existing empty signature field (AutoFirma's `signatureField`);
 *  - the CMS is CAdES detached over the ByteRange with content-type, message-digest,
 *    signing-certificate-v2 and the optional policy: no signing-time and no content-hints.
 *
 * The original bytes are kept untouched (existing signatures stay valid). pdf-lib is used only to
 * read objects; the update section (classic xref table, or an xref stream when the file uses
 * them) is written here.
 *
 * Not supported (documented gaps): encrypted PDFs, certification (DocMDP), timestamps / LTV.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
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
import { type AppearanceSpec, buildAppearance } from './appearance';
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
  /** Makes the signature visible; without it the signature is invisible, on page 1. */
  visible?: PadesVisibleSignature;
}

export interface PadesVisibleSignature {
  appearance: AppearanceSpec;
  /**
   * Where: an existing empty signature field by name (AutoFirma's `signatureField`), or the
   * 1-based pages (usually one; AutoFirma's `signaturePages` repeats it) and the box's lower-left
   * and upper-right corners in the page's default user space (points, origin at its lower-left
   * corner, before /Rotate).
   */
  field?: string;
  pages?: number[];
  rect?: [number, number, number, number];
  /** Quarter turns of the content, counter-clockwise, in degrees (AutoFirma's signatureRotation). */
  rotation?: number;
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

/** A number for a PDF dictionary: at most two decimals. */
function pdfNumber(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
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

interface SignatureField {
  fieldRef: PDFRef;
  field: PDFDict;
  widgetRef: PDFRef;
  widget: PDFDict;
  pageIndex: number;
  rect: [number, number, number, number];
}

/** Empty signature fields (`/FT /Sig` without `/V`) with their first widget, in form order. */
function emptySignatureFields(
  doc: PDFDocument,
  catalog: PDFDict,
): (SignatureField & { name: string })[] {
  const acroForm = lookupDict(doc, catalog.get(PDFName.of('AcroForm')));
  const fields = lookupArray(doc, acroForm?.get(PDFName.of('Fields')));
  const pages = doc.getPages();
  const out: (SignatureField & { name: string })[] = [];
  const visit = (
    arr: PDFArray | undefined,
    prefix: string,
    inheritedFt: PDFObject | undefined,
    depth: number,
  ) => {
    if (!arr || depth > 10) return;
    for (let i = 0; i < arr.size(); i++) {
      const ref = arr.get(i);
      const field = lookupDict(doc, ref);
      if (!field || !(ref instanceof PDFRef)) continue;
      const t = field.get(PDFName.of('T'));
      const partial = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : '';
      const name = prefix && partial ? `${prefix}.${partial}` : partial || prefix;
      const ft = field.get(PDFName.of('FT')) ?? inheritedFt;
      const kids = lookupArray(doc, field.get(PDFName.of('Kids')));
      const kidIsWidget =
        kids && kids.size() > 0 && !lookupDict(doc, kids.get(0))?.has(PDFName.of('T'));
      if (kids && !kidIsWidget) {
        visit(kids, name, ft, depth + 1);
        continue;
      }
      if (!(ft instanceof PDFName) || ft.asString() !== '/Sig' || field.has(PDFName.of('V')))
        continue;
      const widgetRef = kidIsWidget ? kids.get(0) : ref;
      const widget = lookupDict(doc, widgetRef);
      if (!widget || !(widgetRef instanceof PDFRef)) continue;
      const rectArr = lookupArray(doc, widget.get(PDFName.of('Rect')));
      const nums = [0, 1, 2, 3].map((k) => {
        const v = rectArr?.get(k);
        return v instanceof PDFNumber ? v.asNumber() : 0;
      });
      const p = widget.get(PDFName.of('P'));
      let pageIndex = pages.findIndex((page) => p instanceof PDFRef && page.ref === p);
      if (pageIndex < 0) {
        pageIndex = pages.findIndex((page) => {
          const annots = lookupArray(doc, page.node.get(PDFName.of('Annots')));
          for (let k = 0; annots && k < annots.size(); k++)
            if (annots.get(k) === widgetRef) return true;
          return false;
        });
      }
      out.push({
        name,
        fieldRef: ref,
        field,
        widgetRef,
        widget,
        pageIndex: Math.max(0, pageIndex),
        rect: [
          Math.min(nums[0], nums[2]),
          Math.min(nums[1], nums[3]),
          Math.max(nums[0], nums[2]),
          Math.max(nums[1], nums[3]),
        ],
      });
    }
  };
  visit(fields, '', undefined, 0);
  return out;
}

function findSignatureField(
  doc: PDFDocument,
  catalog: PDFDict,
  name: string,
): SignatureField | undefined {
  return emptySignatureFields(doc, catalog).find((f) => f.name === name);
}

/** A page's unrotated MediaBox size and its /Rotate. */
interface PageGeometry {
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

/** What placing a visible signature needs to know about a PDF. */
export interface PdfLayout {
  pages: PageGeometry[];
  /** Empty signature fields with a box, where a signature is expected. */
  signatureFields: { name: string; page: number; rect: [number, number, number, number] }[];
}

export async function pdfLayout(pdf: Uint8Array): Promise<PdfLayout> {
  if (!isPdf(Buffer.from(pdf))) throw AfirmaError.notPdf();
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
  } catch {
    throw AfirmaError.notPdf();
  }
  const pages = doc.getPages().map((page) => {
    const box = page.getMediaBox();
    const angle = (((page.getRotation().angle % 360) + 360) % 360) as PageGeometry['rotation'];
    return { width: box.width, height: box.height, rotation: angle };
  });
  const rootRef = doc.context.trailerInfo.Root;
  const catalog = rootRef instanceof PDFRef ? doc.context.lookup(rootRef, PDFDict) : undefined;
  const signatureFields = catalog
    ? emptySignatureFields(doc, catalog)
        .filter((f) => f.rect[2] > f.rect[0] && f.rect[3] > f.rect[1])
        .map((f) => ({ name: f.name, page: f.pageIndex + 1, rect: f.rect }))
    : [];
  return { pages, signatureFields };
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

  const original = opts.pdf;
  const prevXref = findStartXref(original);
  const prevIsStream = original.subarray(prevXref, prevXref + 4).toString('latin1') !== 'xref';
  let nextNumber = Math.max(ctx.largestObjectNumber + 1, previousSize(original, prevXref));
  const newRef = () => PDFRef.of(nextNumber++, 0);
  const pending: PendingObject[] = [];
  const write = (ref: PDFRef, obj: PDFObject | string) =>
    pending.push({ ref, body: Buffer.from(obj.toString(), 'latin1') });
  const writeStream = (ref: PDFRef, dict: string, data: Buffer) =>
    pending.push({
      ref,
      body: Buffer.concat([
        Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
        data,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    });
  let pendingFieldName: string | undefined;

  const sigRef = newRef();
  const visible = opts.visible;
  const existing = visible?.field ? findSignatureField(doc, catalog, visible.field) : undefined;
  if (visible?.field && !existing) {
    throw AfirmaError.invalidParameter(`No existe el campo de firma vacío ${visible.field}`);
  }

  // AcroForm and field name
  const acroFormEntry = catalog.get(PDFName.of('AcroForm'));
  let acroForm = lookupDict(doc, acroFormEntry);
  if (!acroForm) {
    acroForm = ctx.obj({});
    catalog.set(PDFName.of('AcroForm'), acroForm);
  }
  acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  const fieldRef = existing?.fieldRef ?? newRef();
  if (!existing) {
    const fieldsEntry = acroForm.get(PDFName.of('Fields'));
    let fields = lookupArray(doc, fieldsEntry);
    const taken = fieldNames(doc, fields);
    let n = 1;
    while (taken.has(`Signature${n}`)) n++;
    if (!fields) {
      fields = ctx.obj([]);
      acroForm.set(PDFName.of('Fields'), fields);
    }
    fields.push(fieldRef);
    if (fieldsEntry instanceof PDFRef) write(fieldsEntry, fields);
    pendingFieldName = `Signature${n}`;
  }
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

  // Widgets on their pages, with the appearance when visible
  const addAnnotation = (pageIndex: number, ref: PDFRef) => {
    const page = pages[pageIndex];
    const annotsEntry = page.node.get(PDFName.of('Annots'));
    const annots = lookupArray(doc, annotsEntry);
    if (annots) {
      annots.push(ref);
      if (annotsEntry instanceof PDFRef) write(annotsEntry, annots);
      else write(page.ref, page.node);
    } else {
      page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
      write(page.ref, page.node);
    }
  };
  const appearanceFor = (pageIndex: number, rect: number[]): PDFRef | undefined => {
    if (!visible) return undefined;
    // Undo the page's /Rotate, then turn by `rotation` (AutoFirma's signatureRotation).
    const turn = pages[pageIndex].getRotation().angle + (visible.rotation ?? 0);
    const rotation = (((Math.round(turn / 90) * 90) % 360) + 360) % 360;
    const w = Math.abs(rect[2] - rect[0]);
    const h = Math.abs(rect[3] - rect[1]);
    const sideways = rotation === 90 || rotation === 270;
    return writeAppearance(visible, sideways ? h : w, sideways ? w : h, rotation);
  };
  const writeAppearance = (
    v: PadesVisibleSignature,
    w: number,
    h: number,
    rotation: number,
  ): PDFRef => {
    const built = buildAppearance(v.appearance, w, h);
    const fontsDict = Object.entries(built.fonts)
      .map(
        ([key, base]) =>
          `/${key} << /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`,
      )
      .join(' ');
    let xobjects = '';
    if (built.image) {
      const imageRef = newRef();
      const img = built.image;
      writeStream(
        imageRef,
        `/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
          `/ColorSpace /${img.colorSpace} /BitsPerComponent ${img.bits} /Filter /DCTDecode` +
          (img.colorSpace === 'DeviceCMYK' ? ' /Decode [1 0 1 0 1 0 1 0]' : ''),
        Buffer.from(img.jpeg),
      );
      xobjects = ` /XObject << /Im1 ${imageRef.toString()} >>`;
    }
    // Content drawn upright for the reader: rotate it against the page's /Rotate.
    const matrix =
      rotation === 90
        ? '[0 1 -1 0 0 0]'
        : rotation === 180
          ? '[-1 0 0 -1 0 0]'
          : rotation === 270
            ? '[0 -1 1 0 0 0]'
            : '[1 0 0 1 0 0]';
    const formRef = newRef();
    writeStream(
      formRef,
      `/Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 ${pdfNumber(w)} ${pdfNumber(h)}] ` +
        `/Matrix ${matrix} /Resources << /ProcSet [/PDF /Text /ImageB /ImageC] /Font << ${fontsDict} >>${xobjects} >> ` +
        '/Filter /FlateDecode',
      zlib.deflateSync(Buffer.from(built.content, 'latin1')),
    );
    return formRef;
  };

  if (existing) {
    const rect = existing.rect;
    const ap = visible ? appearanceFor(existing.pageIndex, rect) : undefined;
    existing.field.set(PDFName.of('V'), sigRef);
    if (ap && rect[2] !== rect[0] && rect[3] !== rect[1]) {
      existing.widget.set(PDFName.of('AP'), ctx.obj({ N: ap }));
    }
    write(existing.fieldRef, existing.field);
    if (existing.widgetRef !== existing.fieldRef) write(existing.widgetRef, existing.widget);
  } else {
    const fieldName = pendingFieldName as string;
    const targets = visible?.pages?.length ? visible.pages.map((p) => p - 1) : [0];
    for (const index of targets) {
      if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
        throw AfirmaError.invalidParameter(`El PDF no tiene la página ${index + 1}`);
      }
    }
    const rect = visible?.rect
      ? [
          Math.min(visible.rect[0], visible.rect[2]),
          Math.min(visible.rect[1], visible.rect[3]),
          Math.max(visible.rect[0], visible.rect[2]),
          Math.max(visible.rect[1], visible.rect[3]),
        ]
      : [0, 0, 0, 0];
    const shown = visible && rect[2] - rect[0] > 0 && rect[3] - rect[1] > 0;
    const widgetFor = (index: number, parent?: PDFRef) => {
      const widget = ctx.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        Rect: rect,
        F: 132,
        P: pages[index].ref,
      });
      if (shown) {
        const ap = appearanceFor(index, rect);
        if (ap) widget.set(PDFName.of('AP'), ctx.obj({ N: ap }));
      }
      if (parent) widget.set(PDFName.of('Parent'), parent);
      return widget;
    };
    if (targets.length === 1) {
      // One widget: field and widget in the same dictionary, as AutoFirma writes it.
      const widget = widgetFor(targets[0]);
      widget.set(PDFName.of('FT'), PDFName.of('Sig'));
      widget.set(PDFName.of('T'), PDFString.of(fieldName));
      widget.set(PDFName.of('V'), sigRef);
      write(fieldRef, widget);
      addAnnotation(targets[0], fieldRef);
    } else {
      // The same signature shown on several pages: one field, one widget per page.
      const kids = targets.map((index) => {
        const ref = newRef();
        write(ref, widgetFor(index, fieldRef));
        addAnnotation(index, ref);
        return ref;
      });
      write(fieldRef, ctx.obj({ FT: 'Sig', T: PDFString.of(fieldName), V: sigRef, Kids: kids }));
    }
  }

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
