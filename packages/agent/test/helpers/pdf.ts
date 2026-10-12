/**
 * Builds a tiny, valid PDF (Helvetica, WinAnsiEncoding) with one text line per entry, one page
 * per array. Used as the PDF fixture for fetch_url tests. A `{ drawing }` page has only drawing
 * operators and no text, like a scanned page.
 */
function escapePdfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export type PdfPage = string[] | { drawing: string };

export function makePdf(pages: PdfPage[], title?: string): Uint8Array {
  const objects: Buffer[] = [];
  const add = (body: string | Buffer) =>
    objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pages.forEach((page, i) => {
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    const ops = Array.isArray(page)
      ? page
          .map((line, j) => `BT /F1 12 Tf 72 ${720 - j * 18} Td (${escapePdfText(line)}) Tj ET`)
          .join('\n')
      : page.drawing;
    const stream = Buffer.from(ops, 'latin1');
    add(
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'),
        stream,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
  });
  let infoRef = '';
  if (title) {
    add(`<< /Title (${escapePdfText(title)}) >>`);
    infoRef = ` /Info ${objects.length} 0 R`;
  }

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let offset = chunks[0]?.length ?? 0;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R${infoRef} >>`,
    'startxref',
    String(offset),
    '%%EOF',
    '',
  ].join('\n');
  chunks.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(chunks));
}
