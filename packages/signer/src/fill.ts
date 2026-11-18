/**
 * Filling in a PDF the way a person does with a pen: the agent looks at a page and points where
 * a value goes, and the value lands in what is under the point. No field names, no labels: the
 * PDF's own geometry decides, in this order:
 *
 * 1. a form field (AcroForm widget) under the point, or for a tick the nearest checkbox or radio
 *    button: the value is set in the field itself, which stays editable;
 * 2. a box drawn on the page (a rectangle of the page's content), the smallest under the point,
 *    or for a tick the nearest small square: the text is written inside it, sized to fit;
 * 3. a line to write on (a stroked or hairline rule, or a run of underscores or dots) just under
 *    the point: the text sits on it;
 * 4. otherwise the text starts at the point, vertically centred on it.
 *
 * Points are fractions of the page as displayed (after /Rotate), origin top left, so they don't
 * depend on the size of the image the agent looked at. Each call starts from the given PDF:
 * callers keep the blank and fill it again from scratch to correct a value.
 *
 * Text is Helvetica (Latin-1); text it can't encode (Ł, ș, Cyrillic…) uses the Unicode font the
 * caller passes. Hybrid XFA forms lose their XFA part (Acrobat would otherwise show the old
 * values); XFA-only forms, signed and encrypted PDFs are refused.
 */
import fontkit from '@pdf-lib/fontkit';
import {
  degrees,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  type PDFField,
  type PDFFont,
  PDFName,
  PDFOptionList,
  type PDFPage,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  type PDFWidgetAnnotation,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';

/** One value to put on the page. */
export interface FillEdit {
  /** From 1. */
  page: number;
  /** Fractions (0..1) of the displayed page's width and height, from its top left corner. */
  x: number;
  y: number;
  /** Text to write (`\n` for more lines). */
  text?: string;
  /** A tick (an X in a box, or the checkbox or radio button under the point). */
  check?: boolean;
}

/** Where an edit landed. */
export interface FillPlacement {
  /** Index into the edits. */
  edit: number;
  target: 'field' | 'box' | 'line' | 'point';
  /** The form field's name (`field` only). */
  field?: string;
}

export interface FillResult {
  pdf: Uint8Array;
  /** The pages written on (from 1), in order. */
  pages: number[];
  placements: FillPlacement[];
  /** For the agent: values written smaller, cut, or not where they were meant to go. */
  warnings: string[];
}

export type FillErrorCode = 'invalid' | 'signed' | 'encrypted' | 'xfa_only' | 'unreadable';

export class FillError extends Error {
  constructor(
    readonly code: FillErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FillError';
  }
}

/** A rectangle in displayed-page points, origin top left, y down. */
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A horizontal line to write on, in displayed-page points. */
interface Rule {
  x0: number;
  x1: number;
  y: number;
}

interface PageGeometry {
  width: number;
  height: number;
  rotation: number;
  /** Horizontal borders and lines (also lines to write on). */
  rules: Rule[];
  /** Vertical borders. */
  walls: { y0: number; y1: number; x: number }[];
  /** Where text is printed. */
  texts: Rect[];
  /** Boxes printed as characters (□, ☐), to tick. */
  glyphBoxes: Rect[];
  /** Displayed (x, y) → PDF user space. */
  toPdf(x: number, y: number): [number, number];
  /** A user-space rectangle [x1, y1, x2, y2] → displayed. */
  toDisplay(rect: number[]): Rect;
}

interface Widget {
  field: PDFField;
  widget: PDFWidgetAnnotation;
  /** Its index among its field's widgets (a radio group's options). */
  index: number;
  rect: Rect;
}

const MAX_EDITS = 300;
const MAX_TEXT = 2000;
/** Helvetica's cap height, in em. */
const CAP_HEIGHT = 0.718;
const INK = rgb(0, 0, 0);
/** How far outside a field or box a point may fall and still be in it (points). */
const SLACK = 3;
/** How far a tick may be from a checkbox or a small box to snap to it (points). */
const TICK_REACH = 10;
/** Boxes taller than this are frames around a section, not boxes to write in (points). */
const MAX_BOX_HEIGHT = 48;
/** A box no larger than this on both sides is a box to tick (points). */
const MAX_TICK_BOX = 24;
const TEXT_SIZE = 10;
const MIN_TEXT_SIZE = 5;

/** Fills `pdf` with `edits`; throws a FillError for a PDF that can't be filled. */
export async function fillPdf(
  pdf: Uint8Array,
  edits: FillEdit[],
  options: { unicodeFont?: Uint8Array } = {},
): Promise<FillResult> {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_EDITS)
    throw new FillError('invalid', `Give between 1 and ${MAX_EDITS} values.`);

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false });
  } catch (error) {
    if ((error as Error).name === 'EncryptedPDFError')
      throw new FillError('encrypted', 'This PDF is protected against changes.');
    throw new FillError('unreadable', 'This file is not a PDF that can be read.');
  }
  // XFA: read before getForm(), which drops it with a console warning.
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const xfa = acroForm?.has(PDFName.of('XFA')) ?? false;
  acroForm?.delete(PDFName.of('XFA'));
  const form = doc.getForm();
  const fields = form.getFields();
  if (xfa && fields.length === 0)
    throw new FillError('xfa_only', 'This PDF can only be filled in with Adobe Acrobat Reader.');
  if (fields.some((f) => f instanceof PDFSignature && f.acroField.dict.has(PDFName.of('V'))))
    throw new FillError(
      'signed',
      'This PDF is already signed: filling it in would break the signature. Fill in the blank form, then sign it.',
    );

  const pageCount = doc.getPageCount();
  for (const [i, edit] of edits.entries()) validate(edit, i, pageCount);

  const proxy = await getDocumentProxy(new Uint8Array(pdf), { verbosity: 0 });
  const pages = doc.getPages();
  const widgets = widgetsByPage(doc, pages, fields);
  const geometry = new Map<number, { geo: PageGeometry; widgets: Widget[] }>();
  const helvetica = doc.embedStandardFont(StandardFonts.Helvetica);
  const bold = doc.embedStandardFont(StandardFonts.HelveticaBold);
  let unicode: PDFFont | undefined;
  const fontFor = async (text: string, base: PDFFont): Promise<PDFFont> => {
    if (encodes(base, text)) return base;
    if (!options.unicodeFont) return base;
    if (!unicode) {
      doc.registerFontkit(fontkit);
      unicode = await doc.embedFont(options.unicodeFont, { subset: true });
    }
    return unicode;
  };

  const warnings: string[] = [];
  const placements: FillPlacement[] = [];
  const touched = new Set<number>();
  let fieldsNeedUnicode = false;

  for (const [i, edit] of edits.entries()) {
    const label = describe(edit, i);
    let known = geometry.get(edit.page);
    if (!known) {
      const geo = await pageGeometry(proxy, edit.page);
      known = {
        geo,
        widgets: (widgets.get(edit.page) ?? []).map((w) => {
          const { x, y, width, height } = w.widget.getRectangle();
          return { ...w, rect: geo.toDisplay([x, y, x + width, y + height]) };
        }),
      };
      geometry.set(edit.page, known);
    }
    const { geo } = known;
    const px = edit.x * geo.width;
    const py = edit.y * geo.height;
    const check = edit.check === true;
    const text = edit.text ?? '';
    touched.add(edit.page);

    const widget = pickWidget(known.widgets, px, py, check);
    if (widget) {
      placements.push({ edit: i, target: 'field', field: widget.field.getName() });
      const note = setField(widget, edit);
      if (note) warnings.push(`${label}: ${note}`);
      if (edit.text && !encodes(helvetica, edit.text)) fieldsNeedUnicode = true;
      continue;
    }

    const page = pages[edit.page - 1] as PDFPage;
    if (check) {
      const box = pickTickBox(geo, px, py);
      const cx = box ? (box.x0 + box.x1) / 2 : px;
      const cy = box ? (box.y0 + box.y1) / 2 : py;
      const side = box ? Math.min(box.x1 - box.x0, box.y1 - box.y0) : 10;
      const size = (0.7 * side) / CAP_HEIGHT;
      const w = bold.widthOfTextAtSize('X', size);
      draw(page, geo, 'X', bold, size, cx - w / 2, cy + (CAP_HEIGHT * size) / 2);
      placements.push({ edit: i, target: box ? 'box' : 'point' });
      continue;
    }

    const font = await fontFor(text, helvetica);
    if (!encodes(font, text)) {
      warnings.push(`${label}: has characters no font here can write; left out.`);
      continue;
    }
    const lines = text.split('\n');
    const widest = (size: number) => Math.max(...lines.map((l) => font.widthOfTextAtSize(l, size)));
    const fit = (size: number, room: number): number => {
      const w = widest(size);
      if (w <= room) return size;
      const smaller = Math.max(MIN_TEXT_SIZE, (size * room) / w);
      if (widest(smaller) > room + 0.5) warnings.push(`${label}: too long for its space.`);
      else warnings.push(`${label}: written smaller to fit.`);
      return smaller;
    };

    const box = pickBox(geo, px, py);
    if (box) {
      const h = box.y1 - box.y0;
      const room = box.x1 - box.x0 - 4;
      let size = fit(Math.min(11, h * 0.62, TEXT_SIZE + 1), room);
      // Several lines: as many as the box holds, from its top.
      let baseline: number;
      if (lines.length > 1) {
        size = Math.min(size, (h - 2) / (lines.length * 1.2));
        baseline = box.y0 + 1 + size;
      } else baseline = box.y0 + h / 2 + (CAP_HEIGHT * size) / 2;
      lines.forEach((line, n) => {
        draw(page, geo, line, font, size, box.x0 + 2, baseline + n * size * 1.2);
      });
      placements.push({ edit: i, target: 'box' });
      continue;
    }

    const rule = pickRule(geo, px, py);
    if (rule) {
      const size = fit(TEXT_SIZE, rule.x1 - rule.x0 - 3);
      // Centred on the point, on the line.
      const x = Math.max(rule.x0 + 2, Math.min(px - widest(size) / 2, rule.x1 - widest(size) - 1));
      lines.forEach((line, n) => {
        draw(page, geo, line, font, size, x, rule.y - 1.5 + n * size * 1.2);
      });
      placements.push({ edit: i, target: 'line' });
      continue;
    }

    // Centred on the point, inside the page.
    const size = fit(TEXT_SIZE, geo.width - 8);
    const x = Math.max(4, Math.min(px - widest(size) / 2, geo.width - widest(size) - 4));
    lines.forEach((line, n) => {
      draw(page, geo, line, font, size, x, py + (CAP_HEIGHT * size) / 2 + n * size * 1.2);
    });
    placements.push({ edit: i, target: 'point' });
  }

  if (fieldsNeedUnicode && options.unicodeFont) {
    if (!unicode) {
      doc.registerFontkit(fontkit);
      unicode = await doc.embedFont(options.unicodeFont, { subset: true });
    }
    form.updateFieldAppearances(unicode);
  } else form.updateFieldAppearances(helvetica);
  await proxy.cleanup();
  const bytes = await doc.save({ updateFieldAppearances: false });
  return { pdf: bytes, pages: [...touched].sort((a, b) => a - b), placements, warnings };
}

function validate(edit: FillEdit, i: number, pageCount: number): void {
  const where = `Value ${i + 1}`;
  if (!edit || typeof edit !== 'object') throw new FillError('invalid', `${where} is not valid.`);
  if (!Number.isInteger(edit.page) || edit.page < 1 || edit.page > pageCount)
    throw new FillError(
      'invalid',
      `${where}: this PDF has ${pageCount} page${pageCount === 1 ? '' : 's'}; page ${edit.page} doesn't exist.`,
    );
  for (const c of [edit.x, edit.y])
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1)
      throw new FillError('invalid', `${where}: the point is outside the page.`);
  const hasText = typeof edit.text === 'string' && edit.text.trim() !== '';
  if (hasText === (edit.check === true))
    throw new FillError('invalid', `${where}: give either text or check: true.`);
  if (hasText && (edit.text as string).length > MAX_TEXT)
    throw new FillError('invalid', `${where}: the text is too long.`);
}

function describe(edit: FillEdit, i: number): string {
  if (edit.check) return `Value ${i + 1} (tick)`;
  const text = edit.text ?? '';
  return `Value ${i + 1} ("${text.length > 24 ? `${text.slice(0, 24)}…` : text}")`;
}

function encodes(font: PDFFont, text: string): boolean {
  try {
    font.encodeText(text.replace(/\n/g, ''));
    return true;
  } catch {
    return false;
  }
}

/** Draws one line of text whose baseline starts at a displayed point. */
function draw(
  page: PDFPage,
  geo: PageGeometry,
  text: string,
  font: PDFFont,
  size: number,
  x: number,
  baseline: number,
): void {
  if (!text) return;
  const [ux, uy] = geo.toPdf(x, baseline);
  page.drawText(text, {
    x: ux,
    y: uy,
    size,
    font,
    color: INK,
    ...(geo.rotation ? { rotate: degrees(geo.rotation) } : {}),
  });
}

// --- form fields -------------------------------------------------------------------------------

function widgetsByPage(
  doc: PDFDocument,
  pages: PDFPage[],
  fields: PDFField[],
): Map<number, Omit<Widget, 'rect'>[]> {
  const pageOf = new Map<unknown, number>();
  pages.forEach((page, i) => {
    pageOf.set(page.ref, i + 1);
    const annots = page.node.Annots();
    if (annots)
      for (let n = 0; n < annots.size(); n++) {
        const ref = annots.get(n);
        pageOf.set(ref, i + 1);
        pageOf.set(doc.context.lookup(ref), i + 1);
      }
  });
  const out = new Map<number, Omit<Widget, 'rect'>[]>();
  for (const field of fields) {
    field.acroField.getWidgets().forEach((widget, index) => {
      const page = pageOf.get(widget.dict) ?? (widget.P() ? pageOf.get(widget.P()) : undefined);
      if (!page) return;
      const list = out.get(page) ?? [];
      list.push({ field, widget, index });
      out.set(page, list);
    });
  }
  return out;
}

function pickWidget(widgets: Widget[], px: number, py: number, check: boolean): Widget | undefined {
  const inside = widgets
    .filter((w) => contains(w.rect, px, py, SLACK) && !(w.field instanceof PDFButton))
    .sort((a, b) => area(a.rect) - area(b.rect));
  if (inside[0]) return inside[0];
  if (!check) return undefined;
  return widgets
    .filter((w) => w.field instanceof PDFCheckBox || w.field instanceof PDFRadioGroup)
    .map((w) => ({ w, d: distance(w.rect, px, py) }))
    .filter((c) => c.d <= TICK_REACH)
    .sort((a, b) => a.d - b.d)[0]?.w;
}

/** Sets a field from an edit; returns a note for the agent when it did something else. */
function setField(target: Widget, edit: FillEdit): string | undefined {
  const { field } = target;
  const text = edit.text ?? '';
  const ticks = edit.check === true || /^\s*(x|✓|✔|s[ií]|yes|true)\s*$/i.test(text);
  if (field instanceof PDFCheckBox) {
    // Our own vector tick: the form's usually draws a ZapfDingbats glyph, which some viewers
    // (pdf.js without its font data, the agent's page images) leave out.
    if (ticks) {
      field.check();
      redrawTick(field);
    } else return 'is a checkbox: give check: true to tick it; left as it was.';
    return edit.check ? undefined : 'is a checkbox: ticked.';
  }
  if (field instanceof PDFRadioGroup) {
    const option = field.getOptions()[target.index];
    if (option === undefined) return 'is an option that could not be chosen.';
    field.select(option);
    redrawTick(field);
    return ticks ? undefined : 'is an option to choose: chosen.';
  }
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const options = field.getOptions();
    const wanted = fold(text);
    const option =
      options.find((o) => fold(o) === wanted) ?? options.find((o) => fold(o).startsWith(wanted));
    if (option) field.select(option);
    else if (field instanceof PDFDropdown && field.isEditable()) field.select(text);
    else
      return `is a list of options (${options.slice(0, 12).join(', ')}): none matches; left as it was.`;
    return undefined;
  }
  if (field instanceof PDFTextField) {
    const value = edit.check ? 'X' : text;
    const max = field.getMaxLength();
    if (max !== undefined && value.length > max) {
      field.setText(value.slice(0, max));
      return `holds at most ${max} characters: cut.`;
    }
    field.setText(value);
    return undefined;
  }
  if (field instanceof PDFSignature)
    return 'is a signature field: sign the document instead; left as it was.';
  return 'is a field that cannot be filled; left as it was.';
}

/**
 * Redraws a checkbox's or radio button's appearances with pdf-lib's vector tick, keeping the
 * border the form drew (pdf-lib only draws one for a widget that gives its width).
 */
function redrawTick(field: PDFCheckBox | PDFRadioGroup): void {
  for (const widget of field.acroField.getWidgets()) {
    if (widget.getAppearanceCharacteristics()?.getBorderColor() && !widget.getBorderStyle())
      widget.getOrCreateBorderStyle().setWidth(1);
  }
  field.updateAppearances();
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

// --- page geometry -----------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** pdf.js's path operators inside `constructPath` (DrawOPS). */
const MOVE_TO = 0;
const LINE_TO = 1;
const CURVE_TO = 2;
const QUAD_TO = 3;
const CLOSE = 4;

type PdfProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

/** The page's borders, writing lines and printed text, from its content (form fields' own
 *  drawings left out). */
async function pageGeometry(proxy: PdfProxy, pageNumber: number): Promise<PageGeometry> {
  const { OPS } = await getResolvedPDFJS();
  const page = await proxy.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const toDisplay = (rect: number[]): Rect => {
    const [a, b] = viewport.convertToViewportPoint(rect[0] as number, rect[1] as number);
    const [c, d] = viewport.convertToViewportPoint(rect[2] as number, rect[3] as number);
    return { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) };
  };
  const toPdf = (x: number, y: number) => viewport.convertToPdfPoint(x, y) as [number, number];
  const geo: PageGeometry = {
    width: viewport.width,
    height: viewport.height,
    rotation: viewport.rotation,
    rules: [],
    walls: [],
    texts: [],
    glyphBoxes: [],
    toPdf,
    toDisplay,
  };

  const painted = new Set<number>([
    OPS.stroke,
    OPS.closeStroke,
    OPS.fill,
    OPS.eoFill,
    OPS.fillStroke,
    OPS.eoFillStroke,
    OPS.closeFillStroke,
    OPS.closeEOFillStroke,
  ]);
  const list = await page.getOperatorList();
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  let inAnnotation = 0;
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i] as unknown[];
    if (fn === OPS.beginAnnotation) inAnnotation++;
    else if (fn === OPS.endAnnotation) inAnnotation = Math.max(0, inAnnotation - 1);
    else if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? IDENTITY;
    else if (fn === OPS.transform) ctm = multiply(ctm, Array.from(args as number[]) as Matrix);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const matrix = args[0] as ArrayLike<number> | null;
      if (matrix) ctm = multiply(ctm, Array.from(matrix) as Matrix);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? IDENTITY;
    else if (fn === OPS.constructPath && !inAnnotation) {
      const [paint, paths] = args as [number, ArrayLike<number>[] | ArrayLike<number>];
      if (!painted.has(paint)) continue;
      const data = (Array.isArray(paths) ? paths[0] : paths) as ArrayLike<number> | undefined;
      if (!data) continue;
      for (const sub of subpaths(data)) {
        const display = sub.map(([x, y]) => {
          const [ux, uy] = apply(ctm, x, y);
          return viewport.convertToViewportPoint(ux, uy) as [number, number];
        });
        segmentsOf(display, geo);
      }
    }
  }

  const text = await page.getTextContent();
  for (const item of text.items) {
    if (!('str' in item) || !item.str.trim() || item.width <= 0) continue;
    const [a, b, , d, e, f] = item.transform as number[];
    if (Math.abs(b) > 0.01) continue; // only horizontal text
    const size = Math.abs(d) || Math.abs(a) || item.height || 10;
    const runs = [...item.str.matchAll(/_{3,}|\.{5,}|…{2,}/g)];
    for (const run of runs) {
      const start = e + (item.width * (run.index ?? 0)) / item.str.length;
      const end = e + (item.width * ((run.index ?? 0) + run[0].length)) / item.str.length;
      const r = toDisplay([start, f, end, f]);
      geo.rules.push({ x0: r.x0, x1: r.x1, y: r.y0 });
    }
    for (const glyph of item.str.matchAll(/[□☐❑❒▢]/g)) {
      const step = item.width / item.str.length;
      const x = e + step * (glyph.index ?? 0);
      // The glyph's square: about as wide as its advance, from the baseline up.
      geo.glyphBoxes.push(toDisplay([x, f - size * 0.05, x + step, f + size * 0.75]));
    }
    if (item.str.replace(/[_.…□☐❑❒▢\s]/g, '') === '') continue;
    // The glyphs' box: from the baseline up to about the cap height.
    geo.texts.push(toDisplay([e, f, e + item.width, f + size * 0.7]));
  }
  page.cleanup();
  return geo;
}

function* subpaths(data: ArrayLike<number>): Generator<[number, number][]> {
  let current: [number, number][] = [];
  let curved = false;
  const flush = function* () {
    if (current.length > 1 && !curved) yield current;
    current = [];
    curved = false;
  };
  for (let i = 0; i < data.length; ) {
    const op = data[i];
    if (op === MOVE_TO) {
      yield* flush();
      current.push([data[i + 1] as number, data[i + 2] as number]);
      i += 3;
    } else if (op === LINE_TO) {
      current.push([data[i + 1] as number, data[i + 2] as number]);
      i += 3;
    } else if (op === CURVE_TO) {
      curved = true;
      i += 7;
    } else if (op === QUAD_TO) {
      curved = true;
      i += 5;
    } else if (op === CLOSE) {
      if (current[0]) current.push(current[0]);
      i += 1;
    } else break;
  }
  yield* flush();
}

/**
 * The borders in one straight subpath (displayed points): a hairline rectangle is one border, a
 * larger rectangle four, and every horizontal or vertical stroke one. Horizontal ones are also
 * lines to write on.
 */
function segmentsOf(points: [number, number][], geo: PageGeometry): void {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const r: Rect = {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const axisAligned = points.every(
    ([x, y]) =>
      (Math.abs(x - r.x0) < 0.6 || Math.abs(x - r.x1) < 0.6) &&
      (Math.abs(y - r.y0) < 0.6 || Math.abs(y - r.y1) < 0.6),
  );
  if (points.length >= 4 && axisAligned) {
    if (h < 2.5 && w >= 2.5) geo.rules.push({ x0: r.x0, x1: r.x1, y: (r.y0 + r.y1) / 2 });
    else if (w < 2.5 && h >= 2.5) geo.walls.push({ y0: r.y0, y1: r.y1, x: (r.x0 + r.x1) / 2 });
    else if (w >= 2.5 && h >= 2.5) {
      geo.rules.push({ x0: r.x0, x1: r.x1, y: r.y0 }, { x0: r.x0, x1: r.x1, y: r.y1 });
      geo.walls.push({ y0: r.y0, y1: r.y1, x: r.x0 }, { y0: r.y0, y1: r.y1, x: r.x1 });
    }
    return;
  }
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1] as [number, number];
    const [bx, by] = points[i] as [number, number];
    if (Math.abs(ay - by) < 0.6 && Math.abs(ax - bx) >= 2.5)
      geo.rules.push({ x0: Math.min(ax, bx), x1: Math.max(ax, bx), y: (ay + by) / 2 });
    else if (Math.abs(ax - bx) < 0.6 && Math.abs(ay - by) >= 2.5)
      geo.walls.push({ y0: Math.min(ay, by), y1: Math.max(ay, by), x: (ax + bx) / 2 });
  }
}

/**
 * The empty box around a point: the nearest borders above, below, left and right of it (the
 * page's rectangles and table cells alike), when they close a box with no printed text inside.
 */
function cellAt(geo: PageGeometry, px: number, py: number): Rect | undefined {
  const near = 1;
  let top: number | undefined;
  let bottom: number | undefined;
  for (const r of geo.rules) {
    if (px < r.x0 - near || px > r.x1 + near) continue;
    if (r.y <= py && (top === undefined || r.y > top)) top = r.y;
    if (r.y >= py && (bottom === undefined || r.y < bottom)) bottom = r.y;
  }
  let left: number | undefined;
  let right: number | undefined;
  for (const w of geo.walls) {
    if (py < w.y0 - near || py > w.y1 + near) continue;
    if (w.x <= px && (left === undefined || w.x > left)) left = w.x;
    if (w.x >= px && (right === undefined || w.x < right)) right = w.x;
  }
  if (top === undefined || bottom === undefined || left === undefined || right === undefined)
    return undefined;
  const cell = { x0: left, y0: top, x1: right, y1: bottom };
  if (cell.x1 - cell.x0 < 4 || cell.y1 - cell.y0 < 4) return undefined;
  const printed = geo.texts.some((t) => {
    const cx = (t.x0 + t.x1) / 2;
    const cy = (t.y0 + t.y1) / 2;
    return contains(cell, cx, cy, -0.5);
  });
  return printed ? undefined : cell;
}

/** An empty box to write in under the point (a single line high, not a section's frame). */
function pickBox(geo: PageGeometry, px: number, py: number): Rect | undefined {
  const cell = cellAt(geo, px, py);
  return cell && cell.y1 - cell.y0 <= MAX_BOX_HEIGHT ? cell : undefined;
}

/** A small empty box to tick at or near the point. */
function pickTickBox(geo: PageGeometry, px: number, py: number): Rect | undefined {
  const small = (c: Rect | undefined) =>
    c && c.x1 - c.x0 <= MAX_TICK_BOX && c.y1 - c.y0 <= MAX_TICK_BOX ? c : undefined;
  const here = small(cellAt(geo, px, py));
  if (here) return here;
  const glyph = geo.glyphBoxes
    .map((b) => ({ b, d: distance(b, px, py) }))
    .filter((c) => c.d <= TICK_REACH)
    .sort((a, b) => a.d - b.d)[0]?.b;
  if (glyph) return glyph;
  // Missed by a little: look around the point.
  let best: { cell: Rect; d: number } | undefined;
  for (const r of [3, 6, 9]) {
    for (let k = 0; k < 8; k++) {
      const angle = (k * Math.PI) / 4;
      const cell = small(cellAt(geo, px + r * Math.cos(angle), py + r * Math.sin(angle)));
      if (!cell) continue;
      const d = distance(cell, px, py);
      if (d <= TICK_REACH && (!best || d < best.d)) best = { cell, d };
    }
    if (best) return best.cell;
  }
  return undefined;
}

/** A line the point sits just above (or on), the nearest. */
function pickRule(geo: PageGeometry, px: number, py: number): Rule | undefined {
  return geo.rules
    .filter((r) => r.x1 - r.x0 >= 12)
    .filter((r) => px >= r.x0 - 4 && px <= r.x1 + 4 && py >= r.y - 16 && py <= r.y + 4)
    .sort((a, b) => Math.abs(py - a.y) - Math.abs(py - b.y))[0];
}

function contains(r: Rect, x: number, y: number, slack: number): boolean {
  return x >= r.x0 - slack && x <= r.x1 + slack && y >= r.y0 - slack && y <= r.y1 + slack;
}

function area(r: Rect): number {
  return (r.x1 - r.x0) * (r.y1 - r.y0);
}

/** From a point to the nearest point of a rectangle (0 inside). */
function distance(r: Rect, x: number, y: number): number {
  const dx = Math.max(r.x0 - x, 0, x - r.x1);
  const dy = Math.max(r.y0 - y, 0, y - r.y1);
  return Math.hypot(dx, dy);
}
