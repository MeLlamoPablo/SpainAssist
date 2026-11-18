import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFRawStream,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { resolveAlgorithm } from '../src/algorithms';
import { displayName } from '../src/appearance';
import { keyObjectSigner } from '../src/key';
import { createPades, type PadesVisibleSignature, pdfLayout } from '../src/pades';
import {
  defaultPlacement,
  displayToUser,
  expandLayer2Text,
  finalPlacement,
  initialPlacement,
  javaDate,
  maskIds,
  resolvePages,
  visibleRequest,
} from '../src/visible';
import { rsaIdentity } from './helpers/pki';
import { pkijsVerify } from './helpers/verify';

const FONT = new Uint8Array(
  readFileSync(new URL('../assets/great-vibes-latin.ttf', import.meta.url)),
);

async function pdfWith(pages: { size?: [number, number]; rotate?: number }[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const page = doc.addPage(p.size ?? [595, 842]);
    if (p.rotate) page.node.set(PDFName.of('Rotate'), PDFNumber.of(p.rotate));
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function sign(pdf: Buffer, visible?: PadesVisibleSignature): Promise<Buffer> {
  const id = rsaIdentity();
  return createPades({
    pdf,
    algorithm: resolveAlgorithm('SHA256', id.keyType),
    signer: keyObjectSigner(id.privateKey, id.keyType),
    chain: id.chain,
    params: {},
    signingTime: new Date(2026, 10, 18, 12, 30),
    ...(visible ? { visible } : {}),
  });
}

async function verifies(signed: Buffer): Promise<boolean> {
  const text = signed.toString('latin1');
  const all = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  const [a, b, c, d] = all[all.length - 1].slice(1).map(Number);
  const data = Buffer.concat([signed.subarray(a, a + b), signed.subarray(c, c + d)]);
  const cms = Buffer.from(signed.subarray(b + 1, c - 1).toString('ascii'), 'hex');
  const count = cms[1] & 0x7f;
  const length = cms[1] < 128 ? cms[1] + 2 : cms.readUIntBE(2, count) + count + 2;
  return pkijsVerify(cms.subarray(0, length), 0, data);
}

/** Signature widgets of each page, with their /Rect and appearance stream. */
async function widgets(signed: Buffer) {
  const doc = await PDFDocument.load(signed);
  return doc.getPages().map((page) => {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const out: { rect: number[]; matrix?: number[]; content?: string; bbox?: number[] }[] = [];
    for (let i = 0; annots && i < annots.size(); i++) {
      const w = doc.context.lookup(annots.get(i), PDFDict);
      const rect = w
        .lookup(PDFName.of('Rect'), PDFArray)
        .asArray()
        .map((n) => (n as PDFNumber).asNumber());
      const ap = w.lookupMaybe(PDFName.of('AP'), PDFDict);
      const n = ap?.get(PDFName.of('N'));
      const stream = n instanceof PDFRef ? (doc.context.lookup(n) as PDFRawStream) : undefined;
      out.push({
        rect,
        ...(stream
          ? {
              content: inflateSync(Buffer.from(stream.contents)).toString('latin1'),
              matrix: stream.dict
                .lookup(PDFName.of('Matrix'), PDFArray)
                .asArray()
                .map((v) => (v as PDFNumber).asNumber()),
              bbox: stream.dict
                .lookup(PDFName.of('BBox'), PDFArray)
                .asArray()
                .map((v) => (v as PDFNumber).asNumber()),
            }
          : {}),
      });
    }
    return out;
  });
}

const handwritten = (name = 'Pablo Rodríguez Caballero') =>
  ({
    style: 'handwritten',
    name,
    holderId: '12345678Z',
    date: new Date(2026, 10, 18, 12, 30),
    scriptFont: FONT,
  }) as const;

describe('visible PAdES signatures', () => {
  it('draws the handwritten signature in the box of the chosen page and still verifies', async () => {
    const pdf = await pdfWith([{}, {}]);
    const signed = await sign(pdf, {
      pages: [2],
      rect: [350, 40, 530, 104],
      appearance: handwritten(),
    });
    expect(signed.subarray(0, pdf.length)).toEqual(pdf);
    expect(await verifies(signed)).toBe(true);
    const [first, second] = await widgets(signed);
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
    expect(second[0].rect).toEqual([350, 40, 530, 104]);
    expect(second[0].bbox).toEqual([0, 0, 180, 64]);
    expect(second[0].matrix).toEqual([1, 0, 0, 1, 0, 0]);
    // The name as filled curves, the caption as Helvetica text with the masked NIF.
    expect(second[0].content).toMatch(/ c\n/);
    expect(second[0].content).toContain('/F1');
    expect(signed.toString('latin1')).toContain('/BaseFont /Helvetica');
  });

  it('counter-rotates the appearance on rotated pages', async () => {
    const pdf = await pdfWith([{ rotate: 90 }]);
    const rect = displayToUser([400, 40, 580, 104], 90, 595, 842);
    const signed = await sign(pdf, { pages: [1], rect, appearance: handwritten() });
    expect(await verifies(signed)).toBe(true);
    const [[widget]] = await widgets(signed);
    expect(widget.rect).toEqual(rect);
    expect(widget.bbox).toEqual([0, 0, 180, 64]);
    expect(widget.matrix).toEqual([0, 1, -1, 0, 0, 0]);
  });

  it("turns the content with signatureRotation, on top of the page's /Rotate", async () => {
    const signed = await sign(await pdfWith([{}]), {
      pages: [1],
      rect: [40, 40, 104, 220],
      rotation: 90,
      appearance: handwritten(),
    });
    expect(await verifies(signed)).toBe(true);
    const [[widget]] = await widgets(signed);
    // Read sideways: the box is 64 wide and 180 tall, the signature 180 × 64.
    expect(widget.bbox).toEqual([0, 0, 180, 64]);
    expect(widget.matrix).toEqual([0, 1, -1, 0, 0, 0]);
  });

  it('shows one field on several pages', async () => {
    const signed = await sign(await pdfWith([{}, {}, {}]), {
      pages: [1, 3],
      rect: [40, 40, 220, 104],
      appearance: handwritten(),
    });
    expect(await verifies(signed)).toBe(true);
    const pages = await widgets(signed);
    expect(pages.map((p) => p.length)).toEqual([1, 0, 1]);
    expect(signed.toString('latin1')).toMatch(/\/Kids \[ ?\d+ 0 R \d+ 0 R ?\]/);
  });

  it('signs an existing empty signature field in its own box', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const page = doc.addPage([595, 842]);
    const widget = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: PDFString.of('FirmaSolicitante'),
        Rect: [100, 100, 300, 160],
        P: page.ref,
      }),
    );
    page.node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [widget] }));
    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const layout = await pdfLayout(pdf);
    expect(layout.signatureFields).toEqual([
      { name: 'FirmaSolicitante', page: 2, rect: [100, 100, 300, 160] },
    ]);
    expect(defaultPlacement(layout)).toEqual({ page: 2, rect: [100, 100, 300, 160] });
    const signed = await sign(pdf, { field: 'FirmaSolicitante', appearance: handwritten() });
    expect(await verifies(signed)).toBe(true);
    const [, [w]] = await widgets(signed);
    expect(w.rect).toEqual([100, 100, 300, 160]);
    expect(w.content).toBeDefined();
    // The field is reused, not added again.
    expect((await pdfLayout(signed)).signatureFields).toEqual([]);
  });

  it("draws the site's text over its rubric", async () => {
    // 1×1 grey baseline JPEG.
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
      'base64',
    );
    const signed = await sign(await pdfWith([{}]), {
      pages: [1],
      rect: [40, 40, 240, 120],
      appearance: {
        style: 'text',
        text: 'Firmado por ***4567** el 18/11/2026',
        font: 'Courier',
        size: 12,
        color: [1, 0, 0],
        rubricJpeg: jpeg,
      },
    });
    expect(await verifies(signed)).toBe(true);
    const [[w]] = await widgets(signed);
    expect(w.content).toContain('/Im1 Do');
    expect(w.content).toContain('1 0 0 rg');
    const text = signed.toString('latin1');
    expect(text).toContain('/BaseFont /Courier');
    expect(text).toContain('/Filter /DCTDecode');
  });
});

describe('AutoFirma visible-signature parameters', () => {
  it('resolves signaturePages like AutoFirma', () => {
    expect(resolvePages(undefined, 5)).toEqual([5]);
    expect(resolvePages('1', 5)).toEqual([1]);
    expect(resolvePages('-1', 5)).toEqual([5]);
    expect(resolvePages('1-3,-2--1', 5)).toEqual([1, 2, 3, 4, 5]);
    expect(resolvePages('0,9', 5)).toEqual([1, 5]);
    expect(resolvePages('all', 3)).toEqual([1, 2, 3]);
    expect(resolvePages('x', 3)).toEqual([3]);
    expect(() => resolvePages('append', 3)).toThrow();
  });

  it('maps displayed-page coordinates to user space', () => {
    expect(displayToUser([10, 20, 110, 70], 0, 595, 842)).toEqual([10, 20, 110, 70]);
    expect(displayToUser([10, 20, 110, 70], 90, 595, 842)).toEqual([525, 10, 575, 110]);
    expect(displayToUser([10, 20, 110, 70], 180, 595, 842)).toEqual([485, 772, 585, 822]);
    expect(displayToUser([10, 20, 110, 70], 270, 595, 842)).toEqual([20, 732, 70, 832]);
  });

  it('masks ID numbers and formats Java date patterns', () => {
    expect(maskIds('RODRIGUEZ CABALLERO PABLO - 12345678Z')).toBe(
      'RODRIGUEZ CABALLERO PABLO - ***4567**',
    );
    expect(maskIds('X1234567L')).toBe('****4567*');
    const d = new Date(2026, 10, 8, 9, 5, 7);
    expect(javaDate('dd/MM/yyyy HH:mm:ss', d)).toBe('08/11/2026 09:05:07');
    expect(javaDate("d 'de' MMMM 'de' yyyy", d)).toBe('8 de noviembre de 2026');
  });

  it('expands layer2Text placeholders', () => {
    const text = expandLayer2Text(
      'Firmado por $$SUBJECTCN$$ el $$SIGNDATE=dd/MM/yyyy$$ ($$ISSUERCN$$) $$REASON$$ $$UNKNOWN$$',
      { subjectCN: 'PABLO RODRIGUEZ - 12345678Z', issuerCN: 'AC FNMT Usuarios' },
      { signReason: 'Conforme' },
      new Date(2026, 10, 18),
      true,
    );
    expect(text).toBe(
      'Firmado por PABLO RODRIGUEZ - ***4567** el 18/11/2026 (AC FNMT Usuarios) Conforme $$UNKNOWN$$',
    );
  });

  it('reads the parameters and decides where the signature goes', async () => {
    const layout = await pdfLayout(await pdfWith([{}, {}]));
    expect(visibleRequest({})).toBeUndefined();
    const box = {
      signaturePositionOnPageLowerLeftX: '50',
      signaturePositionOnPageLowerLeftY: '60',
      signaturePositionOnPageUpperRightX: '250',
      signaturePositionOnPageUpperRightY: '120',
    };
    const fixed = visibleRequest({ ...box, signaturePage: '1' });
    expect(fixed).toMatchObject({ box: [50, 60, 250, 120], pages: '1' });
    expect(fixed?.text).toBeUndefined();
    expect(initialPlacement(fixed!, layout)).toEqual({ page: 1, rect: [50, 60, 250, 120] });
    expect(finalPlacement(fixed!, layout, undefined)).toEqual({
      pages: [1],
      rect: [50, 60, 250, 120],
    });
    // A box that starts outside the page fails, as in AutoFirma.
    const outside = visibleRequest({
      ...box,
      signaturePositionOnPageLowerLeftX: '900',
      signaturePositionOnPageUpperRightX: '950',
    });
    expect(() => finalPlacement(outside!, layout, undefined)).toThrow(/fuera de la pagina/);

    const want = visibleRequest({ visibleSignature: 'want' });
    expect(initialPlacement(want!, layout)).toEqual(defaultPlacement(layout));
    expect(finalPlacement(want!, layout, { page: 1, rect: [1, 2, 3, 4] })).toEqual({
      pages: [1],
      rect: [1, 2, 3, 4],
    });
    expect(() => finalPlacement(want!, layout, undefined)).toThrow(/obligatorio/);
    // `want` with the site's box and page: signs there when the user didn't place it.
    const wantBox = visibleRequest({ visibleSignature: 'WANT', ...box, signaturePage: '2' });
    expect(finalPlacement(wantBox!, layout, undefined)).toEqual({
      pages: [2],
      rect: [50, 60, 250, 120],
    });
    const optional = visibleRequest({ visibleSignature: 'optional' });
    expect(finalPlacement(optional!, layout, null)).toBeUndefined();

    const text = visibleRequest({
      ...box,
      layer2Text: 'Hola',
      layer2FontFamily: '1',
      layer2FontStyle: '3',
      layer2FontColor: 'lightGray',
    });
    expect(text?.text).toMatchObject({
      template: 'Hola',
      font: 'Helvetica',
      bold: true,
      italic: true,
      size: 12,
      color: [0.75, 0.75, 0.75],
    });
  });

  it('writes certificate names the way people write them', () => {
    expect(displayName('PABLO RODRIGUEZ DE LA FUENTE')).toBe('Pablo Rodriguez de la Fuente');
    expect(displayName('RODRIGUEZ CABALLERO, PABLO')).toBe('Pablo Rodriguez Caballero');
    expect(displayName('María José Ruiz')).toBe('María José Ruiz');
  });
});
