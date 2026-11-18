/**
 * AutoFirma's visible PAdES signature parameters (`PdfExtraParams`, `PdfUtil`,
 * `PdfVisibleAreasUtils` of clienteafirma; docs/research/autofirma.md §3.3):
 *
 * - visible when `signatureField` is set, or the four `signaturePositionOnPage*` give a box with
 *   width and height; the box is in points of the page as displayed (after /Rotate), origin at
 *   its lower-left corner;
 * - `signaturePages` (or `signaturePage`): `all`, or numbers and ranges (`1-3,-1`), negative from
 *   the end, clamped to the document; none means the last page;
 * - `layer2Text` with `$$…$$` placeholders, `layer2Font{Family,Size,Style,Color}` and
 *   `signatureRubricImage` (JPEG, Base64); without `layer2Text` and without a rubric we draw our
 *   handwritten signature instead of AutoFirma's Courier "Firmado por …";
 * - `visibleSignature=want|optional`: the user places the box (AutoFirma's SignPdfDialog). With
 *   `want`, cancelling aborts unless the site gave a box and a page to fall back on.
 *
 * ID numbers in the certificate's names are masked unless `obfuscateCertText=false`, as
 * AutoFirma does: `12345678Z` → `***4567**`.
 */
import type { Certificate } from '@peculiar/asn1-x509';
import type { SignaturePlacement, SignaturePlacementRequest } from '@sa/shared';
import type { AppearanceSpec } from './appearance';
import { displayName as titleCase } from './appearance';
import { formatNameJava, parseCertificate, parseHolder } from './certificate';
import { AfirmaError } from './errors';
import type { ExtraParams } from './extra-params';
import type { PadesVisibleSignature, PdfLayout } from './pades';

export type Box = [number, number, number, number];

/** What the site's parameters ask for, before the user is involved. */
export interface VisibleRequest {
  /** `want` / `optional`: the user places the box. */
  choose?: 'want' | 'optional';
  field?: string;
  /** Page spec, resolved against the document by `resolvePages`. */
  pages?: string;
  /** The site's box, in displayed-page coordinates. */
  box?: Box;
  /** AutoFirma's text appearance; absent means our handwritten signature. */
  text?: {
    template: string;
    font: 'Courier' | 'Helvetica' | 'Times';
    size?: number;
    bold: boolean;
    italic: boolean;
    color: [number, number, number];
    rubricJpeg?: Uint8Array;
  };
  /** `signatureRotation`, a multiple of 90. */
  rotation: number;
  obfuscate: boolean;
}

function coordinate(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : undefined;
}

const COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [1, 1, 1],
  gray: [0.5, 0.5, 0.5],
  lightgray: [0.75, 0.75, 0.75],
  darkgray: [0.25, 0.25, 0.25],
  red: [1, 0, 0],
  pink: [1, 0.69, 0.69],
};

function decodeBase64(value: string): Uint8Array | undefined {
  const clean = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+=*$/.test(clean)) return undefined;
  const bytes = Buffer.from(clean, 'base64');
  return bytes.length > 0 ? new Uint8Array(bytes) : undefined;
}

/** Reads the site's visible-signature parameters; undefined for an invisible signature. */
export function visibleRequest(params: ExtraParams): VisibleRequest | undefined {
  const mode = params.visibleSignature?.trim().toLowerCase();
  const choose = mode === 'want' || mode === 'optional' ? mode : undefined;
  const llx = coordinate(params.signaturePositionOnPageLowerLeftX);
  const lly = coordinate(params.signaturePositionOnPageLowerLeftY);
  const urx = coordinate(params.signaturePositionOnPageUpperRightX);
  const ury = coordinate(params.signaturePositionOnPageUpperRightY);
  const box: Box | undefined =
    llx !== undefined &&
    lly !== undefined &&
    urx !== undefined &&
    ury !== undefined &&
    urx !== llx &&
    ury !== lly
      ? [Math.min(llx, urx), Math.min(lly, ury), Math.max(llx, urx), Math.max(lly, ury)]
      : undefined;
  const field = params.signatureField?.trim() || undefined;
  if (!choose && !box && !field) return undefined;

  const rubricJpeg = params.signatureRubricImage
    ? decodeBase64(params.signatureRubricImage)
    : undefined;
  if (params.signatureRubricImage && !rubricJpeg) {
    throw AfirmaError.invalidParameter('signatureRubricImage no es una imagen en Base64');
  }
  const template = params.layer2Text;
  let text: VisibleRequest['text'];
  if (template != null || rubricJpeg) {
    const family = Number(params.layer2FontFamily ?? 0);
    const style = Number(params.layer2FontStyle ?? 0);
    const size = Number(params.layer2FontSize);
    text = {
      template: template ?? '',
      font: family === 1 ? 'Helvetica' : family === 2 ? 'Times' : 'Courier',
      size: Number.isFinite(size) && size > 0 ? size : 12,
      bold: (style & 1) !== 0,
      italic: (style & 2) !== 0,
      color: COLORS[params.layer2FontColor?.trim().toLowerCase() ?? ''] ?? COLORS.black,
      ...(rubricJpeg ? { rubricJpeg } : {}),
    };
  }
  const rotation =
    (((Math.round(Number(params.signatureRotation ?? 0) / 90) * 90) % 360) + 360) % 360;
  return {
    ...(choose ? { choose } : {}),
    ...(field ? { field } : {}),
    ...(box ? { box } : {}),
    pages: params.signaturePages ?? params.signaturePage,
    ...(text ? { text } : {}),
    rotation: Number.isFinite(rotation) ? rotation : 0,
    obfuscate: params.obfuscateCertText?.trim().toLowerCase() !== 'false',
  };
}

/** `signaturePages`: 1-based pages, sorted and unique; the last page when nothing is valid. */
export function resolvePages(spec: string | undefined, count: number): number[] {
  const tokens = (spec ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens[0] === 'append') {
    throw AfirmaError.unsupportedOperation('añadir una página en blanco para la firma (append)');
  }
  if (tokens[0] === 'all') return Array.from({ length: count }, (_, i) => i + 1);
  const normalize = (n: number) => {
    const page = n < 0 ? count + 1 + n : n;
    return Math.min(count, Math.max(1, page));
  };
  const pages = new Set<number>();
  for (const token of tokens) {
    const range = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(token);
    if (range) {
      const a = normalize(Number(range[1]));
      const b = normalize(Number(range[2]));
      for (let p = a; p <= b; p++) pages.add(p);
    } else if (/^-?\d+$/.test(token)) {
      pages.add(normalize(Number(token)));
    }
  }
  if (pages.size === 0) pages.add(count);
  return [...pages].sort((a, b) => a - b);
}

/**
 * The box in the page's default user space (before /Rotate), from coordinates of the page as
 * displayed. `width`/`height` are the unrotated MediaBox's size (AutoFirma adds no origin).
 */
export function displayToUser(box: Box, rotation: number, width: number, height: number): Box {
  const [x1, y1, x2, y2] = box;
  const map = (dx: number, dy: number): [number, number] => {
    switch (rotation) {
      case 90:
        return [width - dy, dx];
      case 180:
        return [width - dx, height - dy];
      case 270:
        return [dy, height - dx];
      default:
        return [dx, dy];
    }
  };
  const [ax, ay] = map(x1, y1);
  const [bx, by] = map(x2, y2);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/**
 * Clips the site's box to the displayed page, as AutoFirma does; undefined when it starts
 * outside it.
 */
function clipToPage(box: Box, displayWidth: number, displayHeight: number): Box | undefined {
  if (box[0] >= displayWidth || box[1] >= displayHeight) return undefined;
  return [box[0], box[1], Math.min(box[2], displayWidth), Math.min(box[3], displayHeight)];
}

// --- text ---------------------------------------------------------------------------------------

/**
 * AutoFirma's default mask: in words with three or more digits, keep the 4th to 7th digits (the
 * last four when there are fewer) and hide every other character: `12345678Z` → `***4567**`,
 * `X1234567L` → `****4567*`.
 */
export function maskIds(text: string): string {
  return text.replace(/[0-9A-Za-z]*\d{3,}[0-9A-Za-z]*/g, (word) => {
    const digits = word.replace(/\D/g, '').length;
    const first = Math.max(1, Math.min(4, digits - 3));
    let seen = 0;
    return [...word]
      .map((ch) => {
        if (!/\d/.test(ch)) return '*';
        seen++;
        return seen >= first && seen < first + 4 ? ch : '*';
      })
      .join('');
  });
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

function zoneName(d: Date): string {
  const part = new Intl.DateTimeFormat('es-ES', { timeZoneName: 'short' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? '';
}

/** A Java SimpleDateFormat pattern, for the letters sites use (`dd/MM/yyyy HH:mm:ss z`). */
export function javaDate(pattern: string, d: Date): string {
  let out = '';
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i];
    if (ch === "'") {
      const end = pattern.indexOf("'", i + 1);
      const literal = pattern.slice(i + 1, end < 0 ? pattern.length : end);
      out += literal === '' ? "'" : literal;
      i = end < 0 ? pattern.length : end + 1;
      continue;
    }
    let n = 1;
    while (pattern[i + n] === ch) n++;
    const hours12 = d.getHours() % 12 || 12;
    switch (ch) {
      case 'y':
        out += n === 2 ? pad(d.getFullYear() % 100) : String(d.getFullYear());
        break;
      case 'M':
        out +=
          n >= 4
            ? MONTHS[d.getMonth()]
            : n === 3
              ? MONTHS[d.getMonth()].slice(0, 3)
              : pad(d.getMonth() + 1, n);
        break;
      case 'd':
        out += pad(d.getDate(), n);
        break;
      case 'H':
        out += pad(d.getHours(), n);
        break;
      case 'h':
        out += pad(hours12, n);
        break;
      case 'm':
        out += pad(d.getMinutes(), n);
        break;
      case 's':
        out += pad(d.getSeconds(), n);
        break;
      case 'S':
        out += pad(d.getMilliseconds(), 3).slice(0, Math.max(n, 3));
        break;
      case 'a':
        out += d.getHours() < 12 ? 'AM' : 'PM';
        break;
      case 'z':
      case 'Z':
      case 'X':
        out += zoneName(d);
        break;
      default:
        out += ch.repeat(n);
    }
    i += n;
  }
  return out;
}

/** Values for the `$$…$$` placeholders, read from the signing certificate. */
export interface Layer2Values {
  subjectCN?: string;
  subjectDN?: string;
  issuerCN?: string;
  serial?: string;
  givenName?: string;
  surname?: string;
  organization?: string;
  pseudonym?: string;
  ous?: string[];
  title?: string;
}

/** Expands `layer2Text`'s placeholders (unknown ones stay; missing values become ""). */
export function expandLayer2Text(
  template: string,
  values: Layer2Values,
  params: ExtraParams,
  date: Date,
  obfuscate: boolean,
): string {
  const masked = (v: string | undefined) => (v && obfuscate ? maskIds(v) : (v ?? ''));
  const simple: Record<string, string | undefined> = {
    SUBJECTCN: masked(values.subjectCN),
    SUBJECTDN: masked(values.subjectDN),
    ISSUERCN: values.issuerCN,
    CERTSERIAL: values.serial,
    GIVENNAME: masked(values.givenName),
    SURNAME: masked(values.surname),
    ORGANIZATION: masked(values.organization),
    OU: values.ous?.[0],
    OUS: values.ous?.join(', '),
    TITLE: values.title,
    REASON: params.signReason,
    LOCATION: params.signatureProductionCity,
    CONTACT: params.signerContact,
  };
  if (values.pseudonym !== undefined) simple.PSEUDONYM = values.pseudonym;
  return template
    .replace(/\$\$SIGNDATE(?:=([^=$]*)(?:=[^$]*)?)?\$\$/g, (_m, pattern: string | undefined) =>
      javaDate(pattern?.trim() || 'dd/MM/yy HH:mm', date),
    )
    .replace(/\$\$([A-Z]+)\$\$/g, (m, key: string) => (key in simple ? (simple[key] ?? '') : m));
}

// --- certificate values -------------------------------------------------------------------------

const OIDS = {
  cn: '2.5.4.3',
  givenName: '2.5.4.42',
  surname: '2.5.4.4',
  o: '2.5.4.10',
  ou: '2.5.4.11',
  title: '2.5.4.12',
  pseudonym: '2.5.4.65',
};

function attributes(name: Certificate['tbsCertificate']['subject'], oid: string): string[] {
  const out: string[] = [];
  for (const rdn of name) {
    for (const atv of rdn) {
      if (atv.type !== oid) continue;
      const v = atv.value;
      const text =
        v.utf8String ?? v.printableString ?? v.teletexString ?? v.bmpString ?? v.universalString;
      if (text) out.push(text);
    }
  }
  return out;
}

function layer2Values(
  cert: Certificate,
  formatName: (name: Certificate['tbsCertificate']['subject']) => string,
): Layer2Values {
  const subject = cert.tbsCertificate.subject;
  const first = (oid: string) => attributes(subject, oid)[0];
  const serialHex = Buffer.from(cert.tbsCertificate.serialNumber).toString('hex') || '0';
  const pseudonym = first(OIDS.pseudonym);
  return {
    subjectCN: first(OIDS.cn),
    subjectDN: formatName(subject),
    issuerCN: attributes(cert.tbsCertificate.issuer, OIDS.cn)[0],
    serial: BigInt(`0x${serialHex}`).toString(10),
    givenName: first(OIDS.givenName),
    surname: first(OIDS.surname),
    organization: first(OIDS.o),
    ...(pseudonym ? { pseudonym } : {}),
    ous: attributes(subject, OIDS.ou),
    title: first(OIDS.title),
  };
}

/** What the approval card shows about the box, before anything is signed. */
export function placementRequest(
  request: VisibleRequest,
  initial: SignaturePlacementRequest['initial'],
): SignaturePlacementRequest {
  return {
    mode: request.choose ? 'choose' : 'fixed',
    ...(request.choose === 'optional' ? { optional: true } : {}),
    ...(initial ? { initial } : {}),
    appearance: request.text ? 'text' : 'handwritten',
  };
}

// --- placement -----------------------------------------------------------------------------------

/** The default box: 180 × 64 pt, 40 pt from the bottom-right corner of the page as displayed. */
const DEFAULT_SIGNATURE_SIZE = { width: 180, height: 64, margin: 40 };

function displaySize(page: PdfLayout['pages'][number]): [number, number] {
  return page.rotation === 90 || page.rotation === 270
    ? [page.height, page.width]
    : [page.width, page.height];
}

/**
 * Where a signature goes when nobody said: the first empty signature field, else the bottom-right
 * corner of the last page.
 */
export function defaultPlacement(layout: PdfLayout): SignaturePlacement {
  const field = layout.signatureFields[0];
  if (field) return { page: field.page, rect: field.rect };
  const page = layout.pages.length;
  const geometry = layout.pages[page - 1];
  const [dw] = displaySize(geometry);
  const { width, height, margin } = DEFAULT_SIGNATURE_SIZE;
  const w = Math.min(width, dw - 2 * margin > 60 ? dw - 2 * margin : dw);
  const x = Math.max(0, dw - margin - w);
  const box: Box = [x, margin, x + w, margin + height];
  return { page, rect: displayToUser(box, geometry.rotation, geometry.width, geometry.height) };
}

/** The site's own box (or field), in user space; undefined when it gave none or it misses the page. */
function sitePlacement(
  request: VisibleRequest,
  layout: PdfLayout,
): (SignaturePlacement & { pages: number[] }) | undefined {
  if (request.field) {
    const field = layout.signatureFields.find((f) => f.name === request.field);
    return field ? { page: field.page, rect: field.rect, pages: [field.page] } : undefined;
  }
  const box = request.box;
  if (!box) return undefined;
  const pages = resolvePages(request.pages, layout.pages.length).filter((p) => {
    const [dw, dh] = displaySize(layout.pages[p - 1]);
    return clipToPage(box, dw, dh) !== undefined;
  });
  if (pages.length === 0) return undefined;
  const geometry = layout.pages[pages[0] - 1];
  const [dw, dh] = displaySize(geometry);
  const clipped = clipToPage(box, dw, dh) as Box;
  return {
    page: pages[0],
    rect: displayToUser(clipped, geometry.rotation, geometry.width, geometry.height),
    pages,
  };
}

/** Where the approval card starts the box. */
export function initialPlacement(
  request: VisibleRequest,
  layout: PdfLayout,
): SignaturePlacement | undefined {
  const site = sitePlacement(request, layout);
  if (site) return { page: site.page, rect: site.rect };
  return request.choose ? defaultPlacement(layout) : undefined;
}

/**
 * Where the signature finally goes, from the site's parameters and what the user chose in the
 * approval (`chosen`: undefined when the approval had no box to place, null when they chose none).
 * Undefined means an invisible signature. Follows AutoFirma: a fixed box that misses the page is
 * an error; `want` without any box aborts; `optional` falls back to the site's box or none.
 */
export function finalPlacement(
  request: VisibleRequest,
  layout: PdfLayout,
  chosen: SignaturePlacement | null | undefined,
): Omit<PadesVisibleSignature, 'appearance'> | undefined {
  const site = sitePlacement(request, layout);
  if (request.choose && chosen) return { pages: [chosen.page], rect: chosen.rect };
  if (request.choose) {
    // AutoFirma signs in the site's box when the user cancels its dialog, if there is one.
    const fallback = request.box && request.pages ? site : undefined;
    if (fallback) return { pages: fallback.pages, rect: fallback.rect };
    if (request.choose === 'want') throw AfirmaError.visibleSignatureMandatory();
    return site && chosen === undefined ? { pages: site.pages, rect: site.rect } : undefined;
  }
  if (request.field) {
    if (!site)
      throw AfirmaError.invalidParameter(`No existe el campo de firma vacío ${request.field}`);
    return { field: request.field };
  }
  if (!site) throw AfirmaError.invalidSignaturePosition();
  return { pages: site.pages, rect: site.rect };
}

/**
 * What the box shows: the site's text (placeholders expanded from the signing certificate) or,
 * by default, our handwritten signature with the signer's name.
 */
export function signatureAppearance(o: {
  request?: VisibleRequest;
  certificateDer: Uint8Array;
  /** The signer's name as the user writes it (Mis datos); else the certificate's, title-cased. */
  displayName?: string;
  params: ExtraParams;
  date: Date;
  scriptFont?: Uint8Array;
}): AppearanceSpec {
  const cert = parseCertificate(o.certificateDer);
  const text = o.request?.text;
  if (text) {
    return {
      style: 'text',
      text: expandLayer2Text(
        text.template,
        layer2Values(cert, formatNameJava),
        o.params,
        o.date,
        o.request?.obfuscate ?? true,
      ),
      font: text.font,
      bold: text.bold,
      italic: text.italic,
      ...(text.size ? { size: text.size } : {}),
      color: text.color,
      ...(text.rubricJpeg ? { rubricJpeg: text.rubricJpeg } : {}),
    };
  }
  const holder = parseHolder(cert.tbsCertificate.subject);
  const name = o.displayName?.trim() || titleCase(holder.holderName ?? '') || 'Firma digital';
  return {
    style: 'handwritten',
    name,
    ...(holder.holderId ? { holderId: holder.holderId } : {}),
    date: o.date,
    ...(o.scriptFont ? { scriptFont: o.scriptFont } : {}),
  };
}
