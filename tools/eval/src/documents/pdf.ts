/**
 * The PDFs a person downloads after paying online: the modelo 621 receipt (ITP on a used vehicle,
 * Andalucía), the DGT fee receipt (modelo 791) and a dealer's invoice. Drawn with Skia's PDF
 * backend (`@napi-rs/canvas`): real text that `document_read` extracts, no dates or ids in the
 * file, so a spec always gives the same bytes. Plain text and boxes only: no logos or seals.
 */
import { PDFDocument } from '@napi-rs/canvas';
import { euros, slashDate, slashDateTime, thousands } from './format';
import type { DocumentParty, FacturaSpec, Modelo621Spec, Tasa791Spec } from './spec';

const W = 595;
const H = 842;
const FONT = 'Helvetica, Arial, sans-serif';
const MONO = 'Courier New, Courier, monospace';

type Ctx = ReturnType<PDFDocument['beginPage']>;

function text(
  ctx: Ctx,
  value: string,
  x: number,
  y: number,
  size: number,
  options: { bold?: boolean; align?: CanvasTextAlign; family?: string; color?: string } = {},
) {
  ctx.font = `${options.bold ? 'bold ' : ''}${size}px ${options.family ?? FONT}`;
  ctx.fillStyle = options.color ?? '#111111';
  ctx.textAlign = options.align ?? 'left';
  ctx.fillText(value, x, y);
  ctx.textAlign = 'left';
}

function box(ctx: Ctx, x: number, y: number, w: number, h: number, fill?: string) {
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
  }
  ctx.strokeStyle = '#555555';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(x, y, w, h);
}

/** A labelled cell: small grey label on top, the value under it. */
function cell(ctx: Ctx, label: string, value: string, x: number, y: number, w: number) {
  box(ctx, x, y, w, 30);
  text(ctx, label, x + 4, y + 9, 6.5, { color: '#555555' });
  text(ctx, value, x + 4, y + 23, 9.5, { bold: true });
}

function section(ctx: Ctx, title: string, y: number) {
  box(ctx, 40, y, W - 80, 16, '#e3e7ea');
  text(ctx, title, 46, y + 11.5, 8.5, { bold: true });
}

function partyCells(ctx: Ctx, party: DocumentParty, y: number) {
  cell(ctx, 'NIF', party.nif, 40, y, 110);
  cell(ctx, 'Apellidos y nombre o razón social', party.name, 150, y, W - 190);
  cell(ctx, 'Domicilio', party.street, 40, y + 30, 260);
  cell(ctx, 'Código postal', party.postalCode, 300, y + 30, 70);
  cell(ctx, 'Municipio', party.municipality, 370, y + 30, 110);
  cell(ctx, 'Provincia', party.province, 480, y + 30, W - 520);
}

function pdf(title: string, pages: ((ctx: Ctx) => void)[]): Uint8Array {
  const doc = new PDFDocument({ title, creator: 'Oficina Virtual', producer: 'Oficina Virtual' });
  for (const draw of pages) {
    const ctx = doc.beginPage(W, H);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    draw(ctx);
    doc.endPage();
  }
  return new Uint8Array(doc.close());
}

/** A barcode-like strip from the digits of `value` (decoration: no scanner reads it). */
function barcode(ctx: Ctx, value: string, x: number, y: number, h: number) {
  ctx.fillStyle = '#000000';
  let cursor = x;
  for (const digit of value.replace(/\D/g, '')) {
    const d = Number(digit);
    for (const width of [1 + (d % 3), 1, 2 + (d % 2), 1]) {
      ctx.fillRect(cursor, y, width * 0.8, h);
      cursor += width * 0.8 + 1.2;
    }
  }
}

export function renderModelo621(spec: Modelo621Spec): Uint8Array {
  const quota = Math.round(spec.base * spec.rate) / 100;
  const { vehicle } = spec;
  return pdf(`Modelo 621 - ${spec.number}`, [
    (ctx) => {
      text(ctx, 'Junta de Andalucía', 40, 50, 13, { bold: true });
      text(ctx, 'Agencia Tributaria de Andalucía', 40, 66, 10);
      text(ctx, 'MODELO', W - 40, 46, 8, { align: 'right' });
      text(ctx, '621', W - 40, 72, 28, { bold: true, align: 'right' });
      text(
        ctx,
        'IMPUESTO SOBRE TRANSMISIONES PATRIMONIALES Y ACTOS JURÍDICOS DOCUMENTADOS',
        40,
        98,
        8.5,
        {
          bold: true,
        },
      );
      text(
        ctx,
        'Transmisiones Patrimoniales Onerosas. Compraventa de determinados medios de transporte usados',
        40,
        111,
        8,
      );
      cell(ctx, 'Nº de documento', spec.number, 40, 122, 170);
      cell(ctx, 'Fecha de devengo', slashDate(spec.accrual), 210, 122, 110);
      cell(ctx, 'Oficina competente', 'SEVILLA', 320, 122, W - 360);
      barcode(ctx, spec.number, 40, 160, 22);

      section(ctx, 'SUJETO PASIVO (ADQUIRENTE)', 196);
      partyCells(ctx, spec.buyer, 214);
      section(ctx, 'TRANSMITENTE', 284);
      partyCells(ctx, spec.seller, 302);

      section(ctx, 'DATOS DEL MEDIO DE TRANSPORTE', 372);
      cell(ctx, 'Tipo', vehicle.category === 'ciclomotor' ? 'CICLOMOTOR' : 'TURISMO', 40, 390, 110);
      cell(ctx, 'Marca', vehicle.make, 150, 390, 120);
      cell(ctx, 'Modelo', `${vehicle.model} ${vehicle.version}`, 270, 390, W - 310);
      cell(ctx, 'Matrícula', vehicle.plate, 40, 420, 110);
      cell(ctx, 'Fecha 1ª matriculación', slashDate(vehicle.firstRegistration), 150, 420, 120);
      cell(ctx, 'Nº de bastidor', vehicle.vin, 270, 420, 170);
      cell(ctx, 'Cilindrada (cm³)', String(vehicle.cc), 440, 420, W - 480);

      section(ctx, 'LIQUIDACIÓN', 462);
      const rows: [string, string][] = [
        ['Valor declarado', `${euros(spec.declaredValue)} €`],
        ['Base imponible', `${euros(spec.base)} €`],
        ['Tipo de gravamen', `${euros(spec.rate)} %`],
        ['Cuota tributaria', `${euros(quota)} €`],
        ['Recargo', '0,00 €'],
        ['Intereses de demora', '0,00 €'],
        ['TOTAL A INGRESAR', `${euros(quota)} €`],
      ];
      rows.forEach(([label, value], i) => {
        const y = 480 + i * 20;
        box(ctx, 40, y, W - 80, 20);
        text(ctx, label, 46, y + 13.5, 9, { bold: i === rows.length - 1 });
        text(ctx, value, W - 46, y + 13.5, 9.5, { bold: true, align: 'right' });
      });

      section(ctx, 'JUSTIFICANTE DE PRESENTACIÓN Y PAGO', 632);
      cell(ctx, 'Fecha y hora de presentación', slashDateTime(spec.paidAt), 40, 650, 170);
      cell(ctx, 'Importe ingresado', `${euros(quota)} €`, 210, 650, 110);
      cell(ctx, 'Forma de pago', 'Pago con tarjeta', 320, 650, W - 360);
      cell(ctx, 'Número de Referencia Completo (NRC)', spec.nrc, 40, 680, W - 80);
      text(
        ctx,
        'La Agencia Tributaria de Andalucía ha recibido la presentación de esta autoliquidación por medios telemáticos.',
        40,
        730,
        7.5,
      );
      text(
        ctx,
        'El presente documento sirve como justificante de la presentación y del ingreso realizado.',
        40,
        742,
        7.5,
      );
      text(ctx, 'Ejemplar para el interesado', W - 40, 800, 8, { bold: true, align: 'right' });
    },
  ]);
}

const TASA_NAMES: Record<Tasa791Spec['tasa'], string> = {
  '1.5': 'Cambios de titularidad y otros',
  '1.2': 'Cambio de titularidad de ciclomotores',
  '4.1': 'Informes y certificados',
};

export function renderTasa791(spec: Tasa791Spec): Uint8Array {
  const year = spec.paidAt.slice(0, 4);
  const header = (ctx: Ctx, copy: string) => {
    text(ctx, 'MINISTERIO DEL INTERIOR', 40, 50, 9, { bold: true });
    box(ctx, 140, 30, 150, 44, '#eeeeee');
    text(ctx, 'CENTRO GESTOR:', 215, 47, 8, { bold: true, align: 'center' });
    text(ctx, 'JEFATURA CENTRAL DE TRÁFICO', 215, 60, 8, { bold: true, align: 'center' });
    box(ctx, 300, 30, 170, 44);
    text(ctx, 'TASAS DE LA JEFATURA', 385, 44, 9, { bold: true, align: 'center' });
    text(ctx, 'CENTRAL DE TRÁFICO', 385, 56, 9, { bold: true, align: 'center' });
    text(ctx, 'CÓDIGO 502', 385, 69, 8, { align: 'center' });
    box(ctx, 480, 30, 75, 44, '#eeeeee');
    text(ctx, 'Modelo', 517, 42, 7, { align: 'center' });
    text(ctx, '791', 517, 66, 20, { bold: true, align: 'center' });
    text(ctx, copy, W - 40, 810, 8, { bold: true, align: 'right' });
  };
  const form = (copy: string) => (ctx: Ctx) => {
    header(ctx, copy);
    cell(ctx, 'Ejercicio', year, 40, 90, 80);
    cell(ctx, 'NIF', spec.payer.nif, 120, 90, 110);
    cell(ctx, 'Apellidos y nombre o razón social', spec.payer.name, 230, 90, W - 270);
    cell(ctx, 'Calle/Plaza/Avda.', spec.payer.street, 40, 120, 300);
    cell(ctx, 'Código postal', spec.payer.postalCode, 340, 120, 80);
    cell(ctx, 'Municipio', spec.payer.municipality, 420, 120, W - 460);
    section(ctx, 'AUTOLIQUIDACIÓN. Listado de tasas', 166);
    const columns: [string, string, number][] = [
      ['Cantidad', '1', 70],
      ['Tasa', spec.tasa, 170],
      ['Cuantía', `${euros(spec.amount)} €`, 300],
      ['Total', `${euros(spec.amount)} €`, 430],
    ];
    for (const [label, value, x] of columns) {
      text(ctx, label, x, 200, 8.5, { bold: true });
      text(ctx, value, x, 218, 9.5);
    }
    text(ctx, TASA_NAMES[spec.tasa], 70, 240, 8.5, { color: '#444444' });
    section(ctx, 'INGRESO', 280);
    text(
      ctx,
      'Ingreso efectuado a favor del Tesoro Público, cuenta restringida de la A.E.A.T. para la recaudación de tasas.',
      46,
      312,
      8,
    );
    cell(ctx, 'Importe euros', `${euros(spec.amount)} €`, 40, 326, 160);
    cell(ctx, 'Forma de pago', 'Tarjeta de crédito o débito', 200, 326, 200);
    cell(ctx, 'Fecha', slashDateTime(spec.paidAt), 400, 326, W - 440);
    text(
      ctx,
      'Este documento no será válido sin la certificación mecánica o, en su defecto, firma autorizada.',
      40,
      790,
      7,
    );
  };
  return pdf(`Justificante de pago de tasa ${spec.number}`, [
    form('Ejemplar para la Administración'),
    form('Ejemplar para el Interesado'),
    (ctx) => {
      header(ctx, 'Relación de tasas adquiridas');
      text(ctx, 'Número de tasa', 40, 110, 10, { bold: true });
      text(ctx, 'Tasa', 200, 110, 10, { bold: true });
      text(ctx, 'Fecha de compra', 260, 110, 10, { bold: true });
      text(ctx, 'Importe', 400, 110, 10, { bold: true });
      barcode(ctx, spec.number, 40, 122, 26);
      text(ctx, spec.number, 40, 166, 13, { bold: true, family: MONO });
      text(ctx, spec.tasa, 200, 166, 11);
      text(ctx, slashDateTime(spec.paidAt), 260, 166, 11);
      text(ctx, `${euros(spec.amount)} €`, 400, 166, 11);
      text(
        ctx,
        'Para realizar un trámite por Internet, introduzca el número de tasa (12 dígitos) en el formulario del trámite.',
        40,
        210,
        8.5,
      );
      text(
        ctx,
        'Cada tasa solo puede aplicarse a un trámite. Revise que el tipo de tasa corresponde al trámite que va a realizar.',
        40,
        224,
        8.5,
      );
    },
  ]);
}

export function renderFactura(spec: FacturaSpec): Uint8Array {
  const base = Math.round((spec.total / (1 + spec.vatRate / 100)) * 100) / 100;
  const vat = Math.round((spec.total - base) * 100) / 100;
  const { dealer, buyer, vehicle } = spec;
  return pdf(`Factura ${spec.number}`, [
    (ctx) => {
      text(ctx, dealer.name, 40, 56, 16, { bold: true });
      text(ctx, `CIF ${dealer.nif}`, 40, 72, 9);
      text(
        ctx,
        `${dealer.street}, ${dealer.postalCode} ${dealer.municipality} (${dealer.province})`,
        40,
        85,
        9,
      );
      text(ctx, `Tel. ${dealer.phone} · ${dealer.email}`, 40, 98, 9);
      text(ctx, 'FACTURA', W - 40, 60, 22, { bold: true, align: 'right' });
      text(ctx, `Nº ${spec.number}`, W - 40, 78, 10, { align: 'right' });
      text(ctx, `Fecha: ${slashDate(spec.date)}`, W - 40, 92, 10, { align: 'right' });

      section(ctx, 'CLIENTE', 124);
      partyCells(ctx, buyer, 142);

      section(ctx, 'CONCEPTO', 214);
      const lines = [
        `Venta de vehículo de ocasión ${vehicle.make} ${vehicle.model} ${vehicle.version}`,
        `Matrícula ${vehicle.plate} · Bastidor ${vehicle.vin}`,
        `Fecha de primera matriculación ${slashDate(vehicle.firstRegistration)} · ${thousands(spec.km)} km · ${vehicle.fuel}`,
        'Garantía de 12 meses según el Real Decreto Legislativo 1/2007.',
      ];
      lines.forEach((line, i) => {
        text(ctx, line, 46, 248 + i * 15, 9.5);
      });
      text(ctx, `${euros(base)} €`, W - 46, 248, 9.5, { align: 'right' });

      const totals: [string, string][] = [
        ['Base imponible', `${euros(base)} €`],
        [`IVA (${spec.vatRate} %)`, `${euros(vat)} €`],
        ['TOTAL FACTURA', `${euros(spec.total)} €`],
      ];
      totals.forEach(([label, value], i) => {
        const y = 340 + i * 22;
        box(ctx, 330, y, W - 370, 22);
        text(ctx, label, 336, y + 15, 9.5, { bold: i === 2 });
        text(ctx, value, W - 46, y + 15, 10, { bold: true, align: 'right' });
      });
      text(ctx, 'Forma de pago: transferencia bancaria (pagada).', 40, 430, 9);
      text(
        ctx,
        'Operación sujeta a IVA. El vehículo se entrega con la documentación necesaria para su cambio de titularidad.',
        40,
        446,
        8.5,
      );
      text(ctx, `${dealer.name} · Inscrita en el Registro Mercantil de Sevilla`, W / 2, 800, 7, {
        align: 'center',
        color: '#555555',
      });
    },
  ]);
}
