/** Receipts ("justificantes") as PDF, generated with pdf-lib. */
import { PDFDocument, type PDFFont, rgb, StandardFonts } from 'pdf-lib';
import { MINISTRY } from './views';

export interface ReceiptPdf {
  /** Document title, e.g. "Justificante de presentación". */
  title: string;
  /** Big identifier under the title (registration number / appointment code). */
  reference: { label: string; value: string };
  sections: { heading: string; rows: [string, string][] }[];
  notes?: string[];
  /** PDF metadata title/subject/keywords. */
  metadata: { title: string; subject: string; keywords?: string[] };
  createdAt: Date;
}

const EXTRA_WIN_ANSI = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** Standard PDF fonts only encode WinAnsi; replace anything else. */
function safe(text: string): string {
  return [...text.normalize('NFC')]
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      if (
        (code >= 0x20 && code <= 0x7e) ||
        (code >= 0xa0 && code <= 0xff) ||
        EXTRA_WIN_ANSI.has(ch)
      ) {
        return ch;
      }
      return code === 0x0a ? ' ' : '?';
    })
    .join('');
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = safe(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // Hard-break very long tokens (hashes, base64...).
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > maxWidth) {
      let cut = rest.length;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export async function renderReceiptPdf(receipt: ReceiptPdf): Promise<Uint8Array<ArrayBuffer>> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(safe(receipt.metadata.title));
  pdf.setSubject(safe(receipt.metadata.subject));
  pdf.setAuthor(safe(`${MINISTRY} (ficticio)`));
  pdf.setCreator('Mock sede - SpainAssist');
  pdf.setProducer('pdf-lib');
  pdf.setKeywords((receipt.metadata.keywords ?? []).map(safe));
  pdf.setCreationDate(receipt.createdAt);
  pdf.setModificationDate(receipt.createdAt);

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [width, height] = [595.28, 841.89]; // A4
  const margin = 50;
  const contentWidth = width - margin * 2;
  let page = pdf.addPage([width, height]);
  let y = height - margin;

  const ensure = (needed: number) => {
    if (y - needed < margin + 40) {
      page = pdf.addPage([width, height]);
      y = height - margin;
    }
  };
  const text = (
    value: string,
    opts: { font?: PDFFont; size?: number; x?: number; color?: number } = {},
  ) => {
    const size = opts.size ?? 10;
    const font = opts.font ?? regular;
    const x = opts.x ?? margin;
    for (const line of wrap(value, font, size, width - margin - x)) {
      ensure(size + 4);
      page.drawText(line, {
        x,
        y: y - size,
        size,
        font,
        color: rgb(opts.color ?? 0, opts.color ?? 0, opts.color ?? 0),
      });
      y -= size + 4;
    }
  };

  // Header band
  page.drawRectangle({ x: 0, y: height - 70, width, height: 70, color: rgb(0.48, 0.07, 0.11) });
  page.drawText(safe(MINISTRY), {
    x: margin,
    y: height - 35,
    size: 13,
    font: bold,
    color: rgb(1, 1, 1),
  });
  page.drawText(safe('Sede electrónica · Entorno de pruebas'), {
    x: margin,
    y: height - 53,
    size: 10,
    font: regular,
    color: rgb(1, 1, 1),
  });
  y = height - 100;

  text(receipt.title, { font: bold, size: 18 });
  y -= 6;
  text(`${receipt.reference.label}: ${receipt.reference.value}`, { font: bold, size: 12 });
  y -= 10;

  for (const section of receipt.sections) {
    ensure(40);
    y -= 6;
    text(section.heading, { font: bold, size: 12 });
    page.drawLine({
      start: { x: margin, y: y + 2 },
      end: { x: margin + contentWidth, y: y + 2 },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    y -= 4;
    for (const [label, value] of section.rows) {
      const labelLines = wrap(label, bold, 9, 150);
      const valueLines = wrap(value || '-', regular, 10, contentWidth - 160);
      const rows = Math.max(labelLines.length, valueLines.length);
      ensure(rows * 14);
      for (let i = 0; i < rows; i++) {
        if (labelLines[i])
          page.drawText(labelLines[i]!, { x: margin, y: y - 10, size: 9, font: bold });
        if (valueLines[i])
          page.drawText(valueLines[i]!, { x: margin + 160, y: y - 10, size: 10, font: regular });
        y -= 14;
      }
    }
  }

  if (receipt.notes?.length) {
    y -= 10;
    for (const note of receipt.notes) text(note, { size: 9, color: 0.3 });
  }

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawText(
      safe(
        `Documento ficticio generado por un entorno de pruebas. Sin validez legal. Página ${i + 1} de ${pages.length}`,
      ),
      { x: margin, y: 30, size: 8, font: regular, color: rgb(0.4, 0.4, 0.4) },
    );
  });
  return new Uint8Array(await pdf.save());
}
