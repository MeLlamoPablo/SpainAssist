/**
 * A minimal PDF writer for tests: A4 pages of uncompressed Helvetica text lines (WinAnsi), enough
 * for unpdf to extract the text. Not related to any real report layout.
 */

function escapePdfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildPdf(pages: string[][], options: { title?: string } = {}): Uint8Array {
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
    return objects.length;
  };

  // 1: catalog, 2: pages (filled below), 3: font, then per page a content stream and a page.
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageIds: number[] = [];
  for (const lines of pages) {
    const ops = lines
      .map((line, i) => `BT /F1 11 Tf 50 ${790 - i * 16} Td (${escapePdfText(line)}) Tj ET`)
      .join('\n');
    const stream = Buffer.from(ops, 'latin1');
    const contentId = add(
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'),
        stream,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  objects[1] = Buffer.from(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
    'latin1',
  );
  let infoId: number | undefined;
  if (options.title) infoId = add(`<< /Title (${escapePdfText(options.title)}) >>`);

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let position = chunks[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(position);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    chunks.push(chunk);
    position += chunk.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${infoId ? ` /Info ${infoId} 0 R` : ''} >>\nstartxref\n${position}\n%%EOF\n`,
  ].join('');
  chunks.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(chunks));
}

/** A two-page report in the shape the rules look for: a labelled verification code on each page. */
export function reportPdf(options: {
  csv: string;
  name?: string;
  extraLines?: string[];
}): Uint8Array {
  const name = options.name ?? 'LUCÍA MORENO CASTILLO';
  const footer = `Código Seguro de Verificación (CSV): ${options.csv}`;
  return buildPdf([
    [
      'Informe de vida laboral (documento de prueba)',
      `Titular: ${name}`,
      'TOTAL DÍAS: 3.851',
      ...(options.extraLines ?? []),
      footer,
    ],
    ['Anexo: códigos utilizados', footer],
  ]);
}
