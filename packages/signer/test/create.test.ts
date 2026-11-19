import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFTextField } from 'pdf-lib';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { createDocument, type DocumentFonts } from '../src/create';
import { fillPdf } from '../src/fill';

const font = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../assets/source-serif-4-${name}.ttf`, import.meta.url)));
const FONTS: DocumentFonts = {
  regular: font('regular'),
  italic: font('italic'),
  bold: font('semibold'),
  boldItalic: font('semibold-italic'),
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
    expect(fontNames.some((n) => n.includes('SourceSerif4'))).toBe(true);
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
    // The blank's underscores are gone: they are an underlined field now.
    expect(await textOf(pdf)).not.toContain('___');

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

  it('sets columns side by side, kept with the paragraph before them', async () => {
    const { pdf } = await createDocument(
      'Y en prueba de conformidad, firman.\n\n:::columns\n**El prestamista**\n|||\n**El prestatario**\n:::\n',
      { fonts: FONTS },
    );
    const page = await (await getDocumentProxy(new Uint8Array(pdf))).getPage(1);
    const items = (await page.getTextContent()).items as { str: string; transform: number[] }[];
    const left = items.find((i) => i.str.includes('prestamista'))!;
    const right = items.find((i) => i.str.includes('prestatario'))!;
    expect(left.transform[5]).toBe(right.transform[5]);
    expect(right.transform[4]).toBeGreaterThan(left.transform[4]! + 150);
  });

  it('loads nothing the Markdown points at, and refuses an empty document', async () => {
    const { pdf } = await createDocument(
      '![logo](https://example.com/logo.png) [web](https://example.com)',
    );
    expect(await textOf(pdf)).toContain('logo');
    await expect(createDocument('\n\n')).rejects.toThrow('empty');
  });
});
