import { loadImage } from '@napi-rs/canvas';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import {
  documentForField,
  type FixtureDocument,
  renderDocument,
} from '../../src/documents';
import { euros, inWords, slashDate } from '../../src/documents/format';
import { renderFactura, renderModelo621, renderTasa791 } from '../../src/documents/pdf';
import { renderPhoto } from '../../src/documents/photo';
import {
  contrato,
  DANIEL,
  factura,
  itp,
  MARTA,
  SALE_IBIZA,
  SALE_ZIP,
  tasa,
} from '../../src/fixtures/transferencia-data';

async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text as string[];
}

const ITP = itp(
  SALE_IBIZA,
  DANIEL,
  {
    number: '6212410375938',
    accrual: '2026-10-12',
    declaredValue: 8900,
    paidAt: '2026-10-16T11:42',
    nrc: '6210263048B7KQ29X0M4A1',
  },
  { saved: true },
);

describe('format', () => {
  it('writes amounts and dates as Spanish documents do', () => {
    expect(euros(8900)).toBe('8.900,00');
    expect(euros(27.85)).toBe('27,85');
    expect(slashDate('2026-10-12')).toBe('12/10/2026');
    expect(inWords(8900)).toBe('ocho mil novecientos');
    expect(inWords(13400)).toBe('trece mil cuatrocientos');
    expect(inWords(21000)).toBe('veintiún mil');
    expect(inWords(31000)).toBe('treinta y un mil');
    expect(inWords(650)).toBe('seiscientos cincuenta');
    expect(inWords(100)).toBe('cien');
  });
});

describe('PDFs', () => {
  it('draw the modelo 621 receipt with its number, parties, vehicle and 4 % quota', async () => {
    const [page] = await pdfPages(renderDocument(ITP).bytes);
    for (const text of [
      '6212410375938',
      '31285746L',
      '52617394H',
      '4821KZT',
      '8.900,00 €',
      '356,00 €',
      '6210263048B7KQ29X0M4A1',
    ]) {
      expect(page).toContain(text);
    }
  });

  it('draw the 791 fee receipt with its 12-digit number on the last page', async () => {
    const pages = await pdfPages(renderDocument(tasa(SALE_ZIP, MARTA, { saved: true })).bytes);
    expect(pages).toHaveLength(3);
    expect(pages.at(-1)).toContain('791263044609');
    expect(pages.at(-1)).toContain('27,85 €');
    expect(pages[1]).toContain('Ejemplar para el Interesado');
  });

  it("draw the dealer's invoice with VAT and no ITP", async () => {
    const [page] = await pdfPages(renderDocument(factura(MARTA, { saved: true })).bytes);
    for (const text of ['B41735929', '2753MJN', '18.181,82 €', '3.818,18 €', '22.000,00 €']) {
      expect(page).toContain(text);
    }
  });

  it('are the same bytes every time', () => {
    const spec = ITP.spec as Parameters<typeof renderModelo621>[0];
    expect(Buffer.compare(renderModelo621(spec), renderModelo621(spec))).toBe(0);
    const fee = tasa(SALE_IBIZA, DANIEL, { saved: true }).spec as Parameters<
      typeof renderTasa791
    >[0];
    expect(Buffer.compare(renderTasa791(fee), renderTasa791(fee))).toBe(0);
    const invoice = factura(MARTA, { saved: true }).spec as Parameters<typeof renderFactura>[0];
    expect(Buffer.compare(renderFactura(invoice), renderFactura(invoice))).toBe(0);
  });
});

describe('photos', () => {
  const photo = contrato(
    SALE_IBIZA,
    DANIEL,
    { place: 'Dos Hermanas', date: '2026-10-12', time: '18:30', price: 8900, km: 68420 },
    { saved: true, name: 'contrato.jpeg', seed: 7 },
  );

  it('are JPEGs of a phone photo that decode', async () => {
    const file = renderDocument(photo);
    expect(file.mimeType).toBe('image/jpeg');
    expect([...file.bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const image = await loadImage(Buffer.from(file.bytes));
    expect([image.width, image.height]).toEqual([1536, 2048]);
  });

  it('are the same picture for the same spec, and another for another seed', () => {
    const spec = photo.spec as Parameters<typeof renderPhoto>[0];
    const again = renderPhoto(spec);
    expect(Buffer.compare(renderPhoto(spec), again)).toBe(0);
    const other = renderPhoto({ ...spec, photo: { ...spec.photo, seed: 8 } } as typeof spec);
    expect(Buffer.compare(other, again)).not.toBe(0);
  });
});

describe('documentForField', () => {
  const documents: FixtureDocument[] = [
    photo('contrato', 'contrato|compraventa'),
    photo('itp', '\\bitp\\b|621|impuesto'),
    photo('tasa', 'tasa|791'),
  ];
  function photo(key: string, match: string): FixtureDocument {
    return { ...ITP, key, match };
  }

  it('matches the label or the key, ignoring accents and case', () => {
    const pick = (label: string, key = 'f') => documentForField({ key, label }, documents)?.key;
    expect(pick('Contrato de compraventa firmado')).toBe('contrato');
    expect(pick('Justificante del IMPUESTO de transmisiones')).toBe('itp');
    expect(pick('Archivo', 'justificante_tasa')).toBe('tasa');
    expect(pick('Modelo 621')).toBe('itp');
    expect(pick('Foto del DNI')).toBeUndefined();
  });

  it('skips the documents already taken', () => {
    const field = { key: 'x', label: 'Tasa o contrato' };
    expect(documentForField(field, documents)?.key).toBe('contrato');
    expect(documentForField(field, documents, new Set(['contrato']))?.key).toBe('tasa');
  });
});
