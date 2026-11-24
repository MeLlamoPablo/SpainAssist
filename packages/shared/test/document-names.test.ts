import { describe, expect, it } from 'vitest';
import { findDocumentByName, uniqueDocumentName } from '../src/vault';

const doc = (name: string, previousNames?: string[]) => ({
  name,
  ...(previousNames ? { previousNames } : {}),
});

describe('uniqueDocumentName', () => {
  it('keeps a free name, and numbers a taken one before its extension', () => {
    expect(uniqueDocumentName('Contrato.pdf', ['DNI.jpg'])).toBe('Contrato.pdf');
    expect(uniqueDocumentName('Contrato.pdf', ['Contrato.pdf'])).toBe('Contrato (2).pdf');
    expect(uniqueDocumentName('Contrato.pdf', ['Contrato.pdf', 'Contrato (2).pdf'])).toBe(
      'Contrato (3).pdf',
    );
    expect(uniqueDocumentName('Notas', ['Notas'])).toBe('Notas (2)');
  });

  it('sees "ó" typed either way as the same name', () => {
    expect(uniqueDocumentName('Inspección.jpg', ['Inspección.jpg'])).toBe('Inspección (2).jpg');
  });
});

describe('findDocumentByName', () => {
  const contrato = doc('Contrato de compraventa.jpeg');
  const itv = doc('Tarjeta ITV.jpeg', ['WhatsApp Image 2026-10-15 at 12.26.10.jpeg']);
  const recibo = [doc('Recibo.pdf'), doc('Recibo.jpg')];

  it('finds a document by its whole name, or without its extension', () => {
    expect(findDocumentByName([contrato, itv], 'Contrato de compraventa.jpeg')).toEqual({
      found: contrato,
    });
    expect(findDocumentByName([contrato, itv], 'Contrato de compraventa')).toEqual({
      found: contrato,
    });
  });

  it('asks for the whole name when the short one fits several documents', () => {
    expect(findDocumentByName(recibo, 'Recibo')).toEqual({ ambiguous: recibo });
    expect(findDocumentByName(recibo, 'Recibo.jpg')).toEqual({ found: recibo[1] });
  });

  it('tells a name used before a rename from a name nobody had', () => {
    expect(findDocumentByName([itv], 'WhatsApp Image 2026-10-15 at 12.26.10.jpeg')).toEqual({
      renamed: itv,
    });
    expect(findDocumentByName([itv], 'Permiso de circulación')).toEqual({ missing: true });
  });

  it('prefers a current name to an earlier name of another document', () => {
    const renamedAway = doc('Contrato (firmado).pdf', ['Contrato.pdf']);
    const current = doc('Contrato.pdf');
    expect(findDocumentByName([renamedAway, current], 'Contrato.pdf')).toEqual({ found: current });
  });
});
