import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFTextField } from 'pdf-lib';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { createDocument, type DocumentFonts } from '../src/create';
import { fillPdf } from '../src/fill';

const font = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../assets/lora-${name}.ttf`, import.meta.url)));
const FONTS: DocumentFonts = {
  regular: font('regular'),
  italic: font('italic'),
  bold: font('bold'),
  boldItalic: font('bold-italic'),
};

async function textOf(pdf: Uint8Array): Promise<string> {
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf)), {
    mergePages: true,
  });
  return text;
}

describe('createDocument', () => {
  it('writes Markdown in the document font, with Spanish text intact', async () => {
    const { pdf, pages, fields } = await createDocument(
      '# Contrato de préstamo\n\nEntre **Pablo** y *Ricardo*: 4.000 € «sin intereses».\n\n- uno\n- dos\n\n| A | B |\n|---|---|\n| ñ | ü |',
      { title: 'Contrato', fonts: FONTS },
    );
    expect(pages).toBe(1);
    expect(fields).toEqual([]);
    const text = await textOf(pdf);
    for (const part of [
      'Contrato de préstamo',
      'Pablo',
      'Ricardo',
      '4.000 €',
      '«sin intereses»',
      'ñ',
    ])
      expect(text).toContain(part);
    const doc = await PDFDocument.load(pdf);
    expect(doc.getTitle()).toBe('Contrato');
    const fontNames = doc.context
      .enumerateIndirectObjects()
      .map(([, o]) =>
        String((o as { get?: (n: PDFName) => unknown }).get?.(PDFName.of('BaseFont')) ?? ''),
      )
      .filter(Boolean);
    expect(fontNames.some((n) => n.includes('Lora-Regular'))).toBe(true);
  });

  it('turns blanks into labelled fields in reading order, which fill can fill in', async () => {
    const { pdf, fields } = await createDocument(
      'Domicilio: ____________[Domicilio del prestatario]\n\ncon DNI ______ y teléfono ______\n\nFirma: ______ Firma: ______',
      { fonts: FONTS },
    );
    expect(fields).toEqual([
      'Domicilio del prestatario',
      'con DNI',
      'y teléfono',
      'Firma',
      'Firma 2',
    ]);
    const form = (await PDFDocument.load(pdf)).getForm();
    const field = form.getField('Domicilio del prestatario') as PDFTextField;
    expect(field).toBeInstanceOf(PDFTextField);
    expect(field.acroField.dict.get(PDFName.of('TU'))?.toString()).toContain('FEFF');
    const page = (await PDFDocument.load(pdf)).getPage(0);
    const rect = field.acroField.getWidgets()[0]!.getRectangle();
    const { width, height } = page.getSize();
    const filled = await fillPdf(pdf, [
      {
        page: 1,
        x: (rect.x + rect.width / 2) / width,
        y: 1 - (rect.y + rect.height / 2) / height,
        text: 'C. Mayor 1, Sevilla',
      },
    ]);
    expect(filled.placements).toEqual([
      { edit: 0, target: 'field', field: 'Domicilio del prestatario' },
    ]);
  });

  it('keeps a blank at the end of a line whole, without squashing the line', async () => {
    // Blanks of spaces counted as trimmable whitespace: this line overfilled (its words ran
    // together) and its last blank split into two fields.
    const { pdf, fields } = await createDocument(
      'De una parte, D. Pablo Rodríguez, mayor de edad, con DNI ____________ y domicilio en ____________, en adelante el prestamista.',
      { fonts: FONTS },
    );
    expect(fields).toEqual(['con DNI', 'y domicilio en']);
    const page = await (await getDocumentProxy(new Uint8Array(pdf))).getPage(1);
    const items = (await page.getTextContent()).items as {
      str: string;
      width: number;
      transform: number[];
    }[];
    const y = items.find((i) => i.str.startsWith('De'))!.transform[5];
    const line = items.filter((i) => i.str.trim() && i.transform[5] === y);
    expect(line.length).toBeGreaterThan(5);
    for (let i = 1; i < line.length; i++) {
      const prev = line[i - 1]!;
      expect(line[i]!.transform[4]).toBeGreaterThanOrEqual(prev.transform[4] + prev.width - 0.01);
    }
  });

  async function sideBySide(markdown: string) {
    const { pdf, fields } = await createDocument(markdown, { fonts: FONTS });
    const page = await (await getDocumentProxy(new Uint8Array(pdf))).getPage(1);
    const items = (await page.getTextContent()).items as { str: string; transform: number[] }[];
    const left = items.find((i) => i.str.includes('prestamista'))!;
    const right = items.find((i) => i.str.includes('prestatario'))!;
    expect(left.transform[5]).toBe(right.transform[5]);
    expect(right.transform[4]).toBeGreaterThan(left.transform[4]! + 150);
    const text = await textOf(pdf);
    expect(text).not.toContain('<');
    expect(text).not.toContain('**');
    return { text, fields };
  }

  it('sets the children of a columns div side by side, as Markdown', async () => {
    const { text, fields } = await sideBySide(
      'Y en prueba de conformidad, firman.\n\n<div class="columns">\n<div>\n\n**El prestamista**\n\nFirma: ___[Firma del prestamista]\n\n</div>\n<div>\n\n**El prestatario**\n\nFirma: ___\n\n</div>\n</div>\n\nFin.',
    );
    expect(text).toContain('conformidad');
    expect(text).toContain('Fin.');
    expect(fields).toEqual(['Firma del prestamista', 'Firma']);
  });

  it('takes the flex and grid divs models write, with or without blank lines', async () => {
    await sideBySide(
      '<div style="display: flex; gap: 40px">\n    <div style="flex: 1">**El prestamista**</div>\n    <div style="flex: 1">\n        **El prestatario**\n        - D. Ricardo\n    </div>\n</div>',
    );
    await sideBySide(
      "<DIV style='display:grid;grid-template-columns:1fr 1fr'><div>**El prestamista**</div><div><div>**El prestatario**</div></div></DIV>",
    );
  });

  it('keeps columns with the paragraph before them', async () => {
    // In Helvetica, 25 clauses leave room on page 1 for the paragraph but not the columns.
    const filler = Array.from({ length: 25 }, (_, i) => `Cláusula ${i + 1}.`).join('\n\n');
    const { pdf } = await createDocument(
      `${filler}\n\nY en prueba de conformidad, firman.\n\n<div class="columns"><div>**El prestamista**</div><div>**El prestatario**</div></div>`,
    );
    const doc = await getDocumentProxy(new Uint8Array(pdf));
    expect(doc.numPages).toBe(2);
    const last = (await (await doc.getPage(2)).getTextContent()).items as { str: string }[];
    expect(last.map((i) => i.str).join(' ')).toContain('conformidad');
  });

  it('leaves any other HTML as text', async () => {
    const text = await textOf(
      (
        await createDocument(
          '<div>uno</div>\n\nA <b>dos</b>.\n\n<img src="https://example.com/x.png">',
        )
      ).pdf,
    );
    expect(text).toContain('<div>uno</div>');
    expect(text).toContain('<b>dos</b>');
  });

  it('loads nothing the Markdown points at, and refuses an empty document', async () => {
    const { pdf } = await createDocument(
      '![logo](https://example.com/logo.png) [web](https://example.com)',
    );
    expect(await textOf(pdf)).toContain('logo');
    await expect(createDocument('\n\n')).rejects.toThrow('empty');
  });
});
