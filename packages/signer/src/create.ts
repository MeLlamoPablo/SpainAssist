/**
 * A new PDF written from Markdown (the agent's `api.documents.create`): headings, paragraphs,
 * lists, tables, rules and quotes, laid out by pdfmake on A4 in the caller's font.
 *
 * Two additions to Markdown:
 * - `___` (three or more underscores), optionally `___[Label]`: a blank to fill in. It becomes an
 *   AcroForm text field named after its label (else the words before it), with the label as its
 *   tooltip. pdfmake can't draw fields, so the blank is an underlined run carrying a private link;
 *   pdf-lib then swaps each link annotation for a field of the same size.
 * - `:::columns`, `|||` between columns and `:::`, each on a line of its own: blocks side by side
 *   (a contract's signatures).
 *
 * No images and no network or file access: nothing in the Markdown can make it load anything.
 */
/// <reference path="./types/pdfmake.d.ts" />
import { Lexer, type Token, type Tokens } from 'marked';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import pdfmake from 'pdfmake';

/** The document's font family (TrueType). Without it, Helvetica. */
export interface DocumentFonts {
  regular: Uint8Array;
  italic: Uint8Array;
  bold: Uint8Array;
  boldItalic: Uint8Array;
}

export interface CreateResult {
  pdf: Uint8Array;
  pages: number;
  /** The fillable fields' names, in reading order. */
  fields: string[];
}

const FIELD_LINK = 'sa-field:';
const INK = '#1c1c1c';
const RULE = '#8a8a8a';

const HELVETICA = {
  normal: 'Helvetica',
  bold: 'Helvetica-Bold',
  italics: 'Helvetica-Oblique',
  bolditalics: 'Helvetica-BoldOblique',
};
const FONT_FILES = {
  normal: 'doc-regular.ttf',
  bold: 'doc-bold.ttf',
  italics: 'doc-italic.ttf',
  bolditalics: 'doc-bold-italic.ttf',
};

// Fonts come from memory; the only "files" pdfkit may open are its own standard fonts.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => Object.values(HELVETICA).includes(path));

export async function createDocument(
  markdown: string,
  o: { title?: string; fonts?: DocumentFonts } = {},
): Promise<CreateResult> {
  const blanks: { label: string; length: number }[] = [];
  let previousEnd = 0;
  // Blanks become placeholders first, so Markdown never reads their underscores as emphasis.
  const marked = markdown
    .replace(/\r\n?/g, '\n')
    .replace(
      /_{3,}(?:\[([^\]\n]{1,80})\])?/g,
      (run: string, label: string | undefined, offset: number, all: string) => {
        const from = Math.max(all.lastIndexOf('\n', offset) + 1, previousEnd);
        previousEnd = offset + run.length;
        blanks.push({
          label: label?.trim() || wordsBefore(all.slice(from, offset)),
          length: run.split('[')[0]!.length,
        });
        return `${blanks.length - 1}`;
      },
    );
  const content: Node[] = [];
  for (const b of blocks(marked)) {
    if (typeof b === 'string') {
      content.push(...convert(new Lexer({ gfm: true }).lex(b), blanks, 1));
      continue;
    }
    const columns = {
      columns: b.map((col) => ({
        width: '*',
        stack: convert(new Lexer({ gfm: true }).lex(col), blanks, b.length),
      })),
      columnGap: 28,
      margin: [0, 6, 0, 10],
    };
    // Columns stay together, and with the paragraph that leads into them ("Y en prueba de…").
    const before = content.pop();
    content.push({ stack: before ? [before, columns] : [columns], unbreakable: true });
  }
  if (content.length === 0) throw new Error('The document is empty.');

  if (o.fonts) {
    const vfs = pdfmake.sharedVirtualfs;
    vfs.writeFileSync(FONT_FILES.normal, Buffer.from(o.fonts.regular));
    vfs.writeFileSync(FONT_FILES.bold, Buffer.from(o.fonts.bold));
    vfs.writeFileSync(FONT_FILES.italics, Buffer.from(o.fonts.italic));
    vfs.writeFileSync(FONT_FILES.bolditalics, Buffer.from(o.fonts.boldItalic));
  }
  pdfmake.setFonts({ Doc: o.fonts ? FONT_FILES : HELVETICA });
  const made = await pdfmake
    .createPdf({
      pageSize: 'A4',
      pageMargins: [72, 72, 72, 72],
      info: { ...(o.title ? { title: o.title } : {}), creator: 'Spain Assist' },
      content,
      // A heading never ends a page.
      pageBreakBefore: (node: {
        headlineLevel?: number;
        startPosition: { verticalRatio: number };
      }) => !!node.headlineLevel && node.startPosition.verticalRatio > 0.85,
      defaultStyle: { font: 'Doc', fontSize: 10.5, lineHeight: 1.3, color: INK },
      footer: (page: number, pages: number) =>
        pages > 1
          ? {
              text: `${page} / ${pages}`,
              alignment: 'center',
              fontSize: 8,
              color: RULE,
              margin: [0, 36, 0, 0],
            }
          : null,
    })
    .getBuffer();

  const pdf = await PDFDocument.load(made);
  const form = pdf.getForm();
  const used = new Set<string>();
  const fields: string[] = [];
  for (const page of pdf.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const blanksHere: {
      label: string;
      rect: { x: number; y: number; width: number; height: number };
    }[] = [];
    // Last to first, so removing one keeps the others' indexes.
    for (let i = (annots?.size() ?? 0) - 1; i >= 0; i--) {
      const annot = annots!.lookup(i, PDFDict);
      const uri = annot.lookupMaybe(PDFName.of('A'), PDFDict)?.lookup(PDFName.of('URI'));
      const target =
        uri instanceof PDFString || uri instanceof PDFHexString ? uri.decodeText() : '';
      if (!target.startsWith(FIELD_LINK)) continue;
      annots!.remove(i);
      blanksHere.unshift({
        label: blanks[Number(target.slice(FIELD_LINK.length))]?.label ?? '',
        rect: annot.lookup(PDFName.of('Rect'), PDFArray).asRectangle(),
      });
    }
    for (const { label, rect } of blanksHere) {
      const base = label.replace(/\./g, ' ').trim() || 'Campo';
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base} ${n}`;
      used.add(name);
      const field = form.createTextField(name);
      field.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(label || name));
      field.addToPage(page, { ...rect, borderWidth: 0 });
      field.setFontSize(10);
      fields.push(name);
    }
  }
  return { pdf: await pdf.save(), pages: pdf.getPageCount(), fields };
}

/** The Markdown, with `:::columns` sections split into their columns. */
function blocks(markdown: string): (string | string[])[] {
  const out: (string | string[])[] = [];
  let text: string[] = [];
  let columns: string[][] | null = null;
  for (const line of markdown.split('\n')) {
    if (!columns && /^:::\s*columns\s*$/i.test(line)) {
      out.push(text.join('\n'));
      text = [];
      columns = [[]];
    } else if (columns && /^\|\|\|\s*$/.test(line)) columns.push([]);
    else if (columns && /^:::\s*$/.test(line)) {
      out.push(columns.map((c) => c.join('\n')));
      columns = null;
    } else (columns ? columns[columns.length - 1]! : text).push(line);
  }
  if (columns) out.push(columns.map((c) => c.join('\n')));
  out.push(text.join('\n'));
  return out.filter((b) => (typeof b === 'string' ? b.trim() : b.length));
}

/** A blank's name when it has no label: the last words before it on its line ("con DNI"). */
function wordsBefore(line: string): string {
  const words = line
    .replace(/[*_#>|`]/g, ' ')
    .replace(/[\s.;:,]+$/, '')
    .split(/[.;:,()]/)
    .pop()!
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(-4).join(' ');
}

type Node = Record<string, unknown> | string;

function convert(tokens: Token[], blanks: { length: number }[], columns: number): Node[] {
  const out: Node[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading;
        const size = h.depth === 1 ? 15 : h.depth === 2 ? 12 : 10.5;
        out.push({
          text: inline(h.tokens, blanks, columns),
          bold: true,
          fontSize: size,
          alignment: h.depth === 1 ? 'center' : 'left',
          margin: h.depth === 1 ? [0, 0, 0, 16] : [0, 10, 0, 5],
          headlineLevel: h.depth,
        });
        break;
      }
      case 'paragraph':
      case 'text': {
        const p = t as Tokens.Paragraph | Tokens.Text;
        out.push({
          text: inline(p.tokens ?? [{ type: 'text', raw: p.text, text: p.text }], blanks, columns),
          alignment: columns > 1 ? 'left' : 'justify',
          margin: [0, 0, 0, t.type === 'paragraph' ? 7 : 2],
        });
        break;
      }
      case 'list': {
        const l = t as Tokens.List;
        const items = l.items.map((item) => ({ stack: convert(item.tokens, blanks, columns) }));
        out.push({
          [l.ordered ? 'ol' : 'ul']: items,
          ...(l.ordered && typeof l.start === 'number' ? { start: l.start } : {}),
          margin: [0, 0, 0, 7],
        });
        break;
      }
      case 'table': {
        const tb = t as Tokens.Table;
        const cell = (c: Tokens.TableCell, bold: boolean) => ({
          text: inline(c.tokens, blanks, columns * tb.header.length),
          bold,
        });
        out.push({
          table: {
            headerRows: 1,
            widths: tb.header.map(() => '*'),
            body: [
              tb.header.map((c) => cell(c, true)),
              ...tb.rows.map((r) => r.map((c) => cell(c, false))),
            ],
          },
          layout: {
            hLineWidth: (i: number) => (i === 1 ? 0.8 : 0.4),
            vLineWidth: () => 0,
            hLineColor: () => RULE,
            paddingTop: () => 4,
            paddingBottom: () => 4,
          },
          margin: [0, 2, 0, 10],
        });
        break;
      }
      case 'blockquote':
        out.push({
          stack: convert((t as Tokens.Blockquote).tokens, blanks, columns),
          italics: true,
          margin: [16, 0, 0, 7],
        });
        break;
      case 'hr':
        out.push({
          table: { widths: ['*'], body: [['']] },
          layout: {
            hLineWidth: (i: number) => (i === 0 ? 0.6 : 0),
            vLineWidth: () => 0,
            hLineColor: () => RULE,
          },
          margin: [0, 6, 0, 6],
        });
        break;
      case 'code':
        out.push({
          text: (t as Tokens.Code).text,
          margin: [0, 0, 0, 7],
          preserveLeadingSpaces: true,
        });
        break;
      case 'space':
      case 'def':
        break;
      default:
        if ('text' in t && typeof t.text === 'string')
          out.push({ text: t.text, margin: [0, 0, 0, 7] });
    }
  }
  return out;
}

/** Runs of text, each with its whole style (pdfmake doesn't pass styles down to nested runs). */
function inline(
  tokens: Token[],
  blanks: { length: number }[],
  columns: number,
  style: Record<string, unknown> = {},
): Node[] {
  const out: Node[] = [];
  for (const t of tokens) {
    const nested = (more: Record<string, unknown>) =>
      'tokens' in t && t.tokens?.length
        ? inline(t.tokens, blanks, columns, { ...style, ...more })
        : text(decode('text' in t ? String(t.text) : t.raw), blanks, columns, {
            ...style,
            ...more,
          });
    switch (t.type) {
      case 'strong':
        out.push(...nested({ bold: true }));
        break;
      case 'em':
        out.push(...nested({ italics: true }));
        break;
      case 'del':
        out.push(...nested({ decoration: 'lineThrough' }));
        break;
      case 'link':
        out.push(...nested({ link: (t as Tokens.Link).href }));
        break;
      case 'br':
        out.push({ text: '\n', ...style });
        break;
      case 'image':
        out.push({ text: (t as Tokens.Image).text, ...style });
        break;
      default:
        out.push(...nested({}));
    }
  }
  return out;
}

/** Plain text, with its blanks as underlined runs that carry their field link. */
function text(
  s: string,
  blanks: { length: number }[],
  columns: number,
  style: Record<string, unknown>,
): Node[] {
  return s.split(/(\d+)/).map((part, i) => {
    if (i % 2 === 0) return { text: part, ...style };
    // About an underscore's width per underscore, kept within a column.
    const width = Math.min(
      Math.max(blanks[Number(part)]!.length * 2, 24),
      Math.floor(150 / columns),
    );
    return {
      ...style,
      text: ' '.repeat(width),
      decoration: 'underline',
      decorationColor: RULE,
      link: `${FIELD_LINK}${part}`,
    };
  });
}

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
