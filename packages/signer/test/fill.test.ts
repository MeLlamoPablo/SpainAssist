import { readFileSync } from 'node:fs';
import { degrees, PDFArray, PDFDocument, PDFName, PDFString, rgb, StandardFonts } from 'pdf-lib';
import { getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { type FillEdit, FillError, fillPdf } from '../src/fill';

const NOTO = new Uint8Array(
  readFileSync(new URL('../assets/noto-sans-regular.ttf', import.meta.url)),
);

const W = 595;
const H = 842;
/** A point given in PDF points of an upright A4 page (origin bottom left), as fill takes it. */
const at = (page: number, x: number, y: number) => ({ page, x: x / W, y: 1 - y / H });

/**
 * A form of every kind fill handles: on page 1 an empty box, a box with its label printed
 * inside, a line to write on, a small square to tick, a run of underscores and the form's own
 * fields (a text field, a checkbox, two radio buttons, a dropdown); page 2 is shown rotated.
 */
async function sampleForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([W, H]);
  const black = rgb(0, 0, 0);
  page.drawText('Nombre', { x: 40, y: 705, size: 9, font });
  page.drawRectangle({
    x: 100,
    y: 700,
    width: 200,
    height: 18,
    borderColor: black,
    borderWidth: 0.5,
  });
  page.drawRectangle({
    x: 100,
    y: 660,
    width: 200,
    height: 18,
    borderColor: black,
    borderWidth: 0.5,
  });
  page.drawText('Apellidos', { x: 104, y: 665, size: 9, font });
  page.drawText('Domicilio', { x: 40, y: 622, size: 9, font });
  page.drawLine({
    start: { x: 100, y: 620 },
    end: { x: 400, y: 620 },
    thickness: 0.5,
    color: black,
  });
  // A square drawn as four separate hairlines, like a table's cell.
  for (const [x, y, w, h] of [
    [400, 700, 10, 0.4],
    [400, 709.6, 10, 0.4],
    [400, 700, 0.4, 10],
    [409.6, 700, 0.4, 10],
  ] as const)
    page.drawRectangle({ x, y, width: w, height: h, color: black });
  page.drawText('Fdo.: ______________________', { x: 40, y: 560, size: 10, font });

  const form = doc.getForm();
  form.createTextField('nombre').addToPage(page, { x: 100, y: 450, width: 200, height: 18 });
  form.createCheckBox('acepto').addToPage(page, { x: 400, y: 450, width: 12, height: 12 });
  const sexo = form.createRadioGroup('sexo');
  sexo.addOptionToPage('H', page, { x: 100, y: 400, width: 12, height: 12 });
  sexo.addOptionToPage('M', page, { x: 140, y: 400, width: 12, height: 12 });
  const via = form.createDropdown('via');
  via.addOptions(['Calle', 'Avenida', 'Plaza']);
  via.addToPage(page, { x: 100, y: 350, width: 120, height: 18 });

  const rotated = doc.addPage([W, H]);
  rotated.setRotation(degrees(90));
  return doc.save();
}

interface Placed {
  str: string;
  /** Displayed points, origin top left: where the text starts, on its baseline. */
  x: number;
  y: number;
  width: number;
  /** Upright as displayed. */
  upright: boolean;
}

async function textOf(pdf: Uint8Array, pageNumber: number): Promise<Placed[]> {
  const proxy = await getDocumentProxy(new Uint8Array(pdf));
  const page = await proxy.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const { items } = await page.getTextContent();
  return items.flatMap((item) => {
    if (!('str' in item) || !item.str.trim()) return [];
    const [a, b, , , e, f] = item.transform as number[];
    const [x, y] = viewport.convertToViewportPoint(e, f);
    const [x2, y2] = viewport.convertToViewportPoint(e + (a as number), f + (b as number));
    return [{ str: item.str, x, y, width: item.width, upright: Math.abs(y2 - y) < 0.01 && x2 > x }];
  });
}

const find = (placed: Placed[], str: string) => {
  const hit = placed.find((p) => p.str === str);
  if (!hit) throw new Error(`"${str}" is not on the page: ${placed.map((p) => p.str).join(' | ')}`);
  return hit;
};

describe('fillPdf', () => {
  it('writes into the empty box under the point, left-aligned and centred in its height', async () => {
    // Pointed at the right half of the box: the text still starts at its left edge.
    const out = await fillPdf(await sampleForm(), [{ ...at(1, 250, 709), text: 'Lucía' }]);
    expect(out.placements).toEqual([{ edit: 0, target: 'box' }]);
    expect(out.pages).toEqual([1]);
    const text = find(await textOf(out.pdf, 1), 'Lucía');
    expect(text.x).toBeCloseTo(102, 0);
    // Baseline inside the box (displayed y of the box: 124..142).
    expect(text.y).toBeGreaterThan(130);
    expect(text.y).toBeLessThan(142);
  });

  it('never takes a box with printed text inside for an empty one', async () => {
    const out = await fillPdf(await sampleForm(), [{ ...at(1, 250, 669), text: 'Pérez' }]);
    expect(out.placements[0]?.target).not.toBe('box');
  });

  it('writes on the line under the point, centred on it', async () => {
    const out = await fillPdf(await sampleForm(), [{ ...at(1, 250, 626), text: 'Calle Mayor 5' }]);
    expect(out.placements[0]?.target).toBe('line');
    const text = find(await textOf(out.pdf, 1), 'Calle Mayor 5');
    expect(text.x + text.width / 2).toBeCloseTo(250, 0);
    // Just above the line (displayed y 222).
    expect(text.y).toBeGreaterThan(218);
    expect(text.y).toBeLessThan(222);
  });

  it('writes on a run of underscores', async () => {
    const out = await fillPdf(await sampleForm(), [{ ...at(1, 120, 566), text: 'Ana' }]);
    expect(out.placements[0]?.target).toBe('line');
  });

  it('ticks a square of four hairlines with an X, also when the point misses it a little', async () => {
    const out = await fillPdf(await sampleForm(), [{ ...at(1, 398, 712), check: true }]);
    expect(out.placements[0]?.target).toBe('box');
    const x = find(await textOf(out.pdf, 1), 'X');
    // Centred in the square (displayed x 400..410).
    expect(x.x + x.width / 2).toBeCloseTo(405, 0);
  });

  it('puts text with nothing under it centred on the point', async () => {
    const out = await fillPdf(await sampleForm(), [{ ...at(1, 300, 200), text: 'Madrid' }]);
    expect(out.placements[0]?.target).toBe('point');
    const text = find(await textOf(out.pdf, 1), 'Madrid');
    expect(text.x + text.width / 2).toBeCloseTo(300, 0);
  });

  it("sets the form's own fields: text, a near-missed checkbox, a radio button, a dropdown", async () => {
    const out = await fillPdf(await sampleForm(), [
      { ...at(1, 150, 459), text: 'Lucía Pérez' },
      { ...at(1, 398, 456), check: true },
      { ...at(1, 146, 406), check: true },
      { ...at(1, 160, 359), text: 'avenida' },
    ]);
    expect(out.placements.map((p) => p.field)).toEqual(['nombre', 'acepto', 'sexo', 'via']);
    expect(out.warnings).toEqual([]);
    const form = (await PDFDocument.load(out.pdf)).getForm();
    expect(form.getTextField('nombre').getText()).toBe('Lucía Pérez');
    expect(form.getCheckBox('acepto').isChecked()).toBe(true);
    expect(form.getRadioGroup('sexo').getSelected()).toBe('M');
    expect(form.getDropdown('via').getSelected()).toEqual(['Avenida']);
  });

  it('says so when a value does not suit its field', async () => {
    const out = await fillPdf(await sampleForm(), [
      { ...at(1, 406, 456), text: 'Lucía' },
      { ...at(1, 160, 359), text: 'Camino' },
    ]);
    expect(out.warnings).toEqual([
      'Value 1 ("Lucía"): is a checkbox: give check: true to tick it; left as it was.',
      'Value 2 ("Camino"): is a list of options (Calle, Avenida, Plaza): none matches; left as it was.',
    ]);
  });

  it('writes names Helvetica cannot with the Unicode font, and leaves them out without it', async () => {
    const edits: FillEdit[] = [
      { ...at(1, 250, 709), text: 'Łucja Wiśniewska' },
      { ...at(1, 150, 459), text: 'Ștefan Ionescu' },
    ];
    const out = await fillPdf(await sampleForm(), edits, { unicodeFont: NOTO });
    expect(out.warnings).toEqual([]);
    expect((await textOf(out.pdf, 1)).map((t) => t.str)).toContain('Łucja Wiśniewska');
    expect((await PDFDocument.load(out.pdf)).getForm().getTextField('nombre').getText()).toBe(
      'Ștefan Ionescu',
    );

    const without = await fillPdf(await sampleForm(), [edits[0] as FillEdit]);
    expect(without.warnings).toEqual([
      'Value 1 ("Łucja Wiśniewska"): has characters no font here can write; left out.',
    ]);
  });

  it('makes long text smaller to fit its box', async () => {
    const long = 'Calle de la Virgen de los Peligros, 12, escalera B';
    const out = await fillPdf(await sampleForm(), [{ ...at(1, 150, 709), text: long }]);
    expect(out.warnings).toEqual([`Value 1 ("${long.slice(0, 24)}…"): written smaller to fit.`]);
    const text = find(await textOf(out.pdf, 1), long);
    expect(text.x + text.width).toBeLessThanOrEqual(300);
  });

  it('writes upright on a page shown rotated', async () => {
    // Displayed, page 2 is landscape: 842 wide, 595 high.
    const out = await fillPdf(await sampleForm(), [{ page: 2, x: 0.5, y: 0.5, text: 'Girada' }]);
    const text = find(await textOf(out.pdf, 2), 'Girada');
    expect(text.upright).toBe(true);
    expect(text.x + text.width / 2).toBeCloseTo(421, 0);
  });

  it('refuses what it cannot fill', async () => {
    const form = await sampleForm();
    const refusal = (edits: FillEdit[], pdf = form) =>
      fillPdf(pdf, edits).then(
        () => undefined,
        (e: FillError) => [e.code, e.message],
      );
    expect(await refusal([{ page: 3, x: 0.5, y: 0.5, text: 'x' }])).toEqual([
      'invalid',
      "Value 1: this PDF has 2 pages; page 3 doesn't exist.",
    ]);
    expect(await refusal([{ page: 1, x: 1.2, y: 0.5, text: 'x' }])).toEqual([
      'invalid',
      'Value 1: the point is outside the page.',
    ]);
    expect(await refusal([{ page: 1, x: 0.5, y: 0.5 }])).toEqual([
      'invalid',
      'Value 1: give either text or check: true.',
    ]);
    expect(
      await refusal([{ page: 1, x: 0.5, y: 0.5, text: 'x' }], new Uint8Array([1, 2, 3])),
    ).toEqual(['unreadable', 'This file is not a PDF that can be read.']);

    // Signed: a signature field with a value.
    const signed = await PDFDocument.load(form);
    const sig = signed.context.obj({
      FT: 'Sig',
      T: PDFString.of('Firma1'),
      V: signed.context.obj({ Type: 'Sig' }),
    });
    signed
      .getForm()
      .acroForm.dict.lookup(PDFName.of('Fields'), PDFArray)
      .push(signed.context.register(sig));
    expect((await refusal([{ ...at(1, 300, 200), text: 'x' }], await signed.save()))?.[0]).toBe(
      'signed',
    );

    // XFA only: no AcroForm fields to fill, only the XFA's placeholder page.
    const xfa = await PDFDocument.create();
    xfa.addPage([W, H]);
    xfa.catalog.set(
      PDFName.of('AcroForm'),
      xfa.context.obj({ Fields: [], XFA: xfa.context.obj([]) }),
    );
    expect(await refusal([{ ...at(1, 300, 200), text: 'x' }], await xfa.save())).toEqual([
      'xfa_only',
      'This PDF can only be filled in with Adobe Acrobat Reader.',
    ]);
  });

  it('drops the XFA part of a hybrid form, so viewers show the values filled in', async () => {
    const hybrid = await PDFDocument.load(await sampleForm());
    hybrid.getForm().acroForm.dict.set(PDFName.of('XFA'), hybrid.context.obj([]));
    const out = await fillPdf(await hybrid.save(), [{ ...at(1, 150, 459), text: 'Ana' }]);
    const form = (await PDFDocument.load(out.pdf)).getForm();
    expect(form.hasXFA()).toBe(false);
    expect(form.getTextField('nombre').getText()).toBe('Ana');
  });

  it('leaves the given PDF as it was', async () => {
    const blank = await sampleForm();
    const copy = blank.slice();
    await fillPdf(blank, [{ ...at(1, 150, 459), text: 'Ana' }]);
    expect(Buffer.from(blank).equals(Buffer.from(copy))).toBe(true);
    expect(FillError).toBeDefined();
  });
});
