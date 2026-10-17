import { describe, expect, it } from 'vitest';
import { extractPdfText, normalizePdfText, sha256, verificationCodes } from '../../src/rules/pdf';
import { buildPdf, reportPdf } from './support/pdf';

describe('extractPdfText', () => {
  it('extracts the text of every page, accents included', async () => {
    const text = await extractPdfText(reportPdf({ csv: '0123456789ABCDEF' }));
    expect(text).toContain('LUCÍA MORENO CASTILLO');
    expect(text).toContain('TOTAL DÍAS: 3.851');
    expect(text).toContain('Anexo');
  });

  it('refuses bytes that are not a PDF', async () => {
    await expect(extractPdfText(new TextEncoder().encode('hello'))).rejects.toThrow(/%PDF-/);
  });

  it('refuses a damaged PDF', async () => {
    const bytes = reportPdf({ csv: '0123456789ABCDEF' }).slice(0, 200);
    await expect(extractPdfText(bytes)).rejects.toThrow();
  });

  it('hashes bytes', () => {
    expect(sha256(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('verificationCodes', () => {
  it('finds the code printed after the label, on every page', async () => {
    const text = await extractPdfText(reportPdf({ csv: '0123456789ABCDEF' }));
    expect(verificationCodes(text)).toEqual(['0123456789ABCDEF']);
  });

  it('lists distinct codes', async () => {
    const text = await extractPdfText(
      buildPdf([
        ['Código Seguro de Verificación (CSV): AAAA1111BBBB2222'],
        ['Código Seguro de Verificación (CSV): CCCC3333DDDD4444'],
      ]),
    );
    expect(verificationCodes(text).sort()).toEqual(['AAAA1111BBBB2222', 'CCCC3333DDDD4444']);
  });

  it('ignores a PDF without the label', async () => {
    const text = await extractPdfText(buildPdf([['Informe', 'Código: 0123456789ABCDEF']]));
    expect(verificationCodes(text)).toEqual([]);
  });

  it('is not tied to accents or spacing', () => {
    expect(verificationCodes('CODIGO   SEGURO DE VERIFICACION  CSV: ab12cd34ef56')).toEqual([
      'ab12cd34ef56',
    ]);
    expect(normalizePdfText('Verificación\n  de   código')).toBe('Verificacion de codigo');
  });
});
