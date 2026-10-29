/**
 * Phone photos of paper documents: the contract of sale (a printed form filled in by hand), the
 * permiso de circulación and the ficha técnica. Each paper is drawn flat, then "photographed": put
 * askew on a table, lit unevenly, with a little sensor noise, and saved as a JPEG. Everything that
 * varies comes from the spec's seed, so a spec is always the same picture on a given machine.
 * Plain text and boxes only: no coats of arms, logos or seals.
 */
import { type Canvas, createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { dateParts, dottedDate, euros, inWords, slashDate, thousands } from './format';
import type {
  ContratoSpec,
  DocumentParty,
  DocumentVehicle,
  FichaSpec,
  PermisoSpec,
  PhotoLook,
} from './spec';

/** A4 at 150 dpi. */
const PAPER_W = 1240;
const PAPER_H = 1754;
const PHOTO_W = 1536;
const PHOTO_H = 2048;
const JPEG_QUALITY = 84;

const PRINT = 'Helvetica, Arial, sans-serif';
const SERIF = 'Times New Roman, Times, serif';
/** A handwriting face where the system has one; any cursive face otherwise. */
const HAND = 'Bradley Hand, Noteworthy, Marker Felt, Comic Sans MS, cursive';
const INK = '#1d3c8f';

/** A small deterministic random source (mulberry32). */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;

function paper(tint: string): { canvas: Canvas; ctx: SKRSContext2D } {
  const canvas = createCanvas(PAPER_W, PAPER_H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, PAPER_W, PAPER_H);
  ctx.textBaseline = 'alphabetic';
  return { canvas, ctx };
}

function print(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  options: { bold?: boolean; family?: string; color?: string; align?: CanvasTextAlign } = {},
): number {
  ctx.font = `${options.bold ? 'bold ' : ''}${size}px ${options.family ?? PRINT}`;
  ctx.fillStyle = options.color ?? '#1a1a1a';
  ctx.textAlign = options.align ?? 'left';
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
  return ctx.measureText(text).width;
}

/** Handwritten text: blue ink, each word a little off the line. */
function hand(ctx: SKRSContext2D, text: string, x: number, y: number, size: number, rnd: Random) {
  ctx.font = `${size}px ${HAND}`;
  ctx.fillStyle = INK;
  let cursor = x;
  for (const word of text.split(' ')) {
    ctx.save();
    ctx.translate(cursor, y + (rnd() - 0.5) * 3);
    ctx.rotate((rnd() - 0.5) * 0.03);
    ctx.fillText(word, 0, 0);
    ctx.restore();
    cursor += ctx.measureText(`${word} `).width;
  }
  return cursor - x;
}

function handWidth(ctx: SKRSContext2D, text: string, size: number): number {
  ctx.font = `${size}px ${HAND}`;
  return ctx.measureText(text).width;
}

/** A signature: a few quick loops in ink. */
function signature(ctx: SKRSContext2D, x: number, y: number, width: number, rnd: Random) {
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  let px = x;
  const loops = 5 + Math.floor(rnd() * 4);
  for (let i = 0; i < loops; i++) {
    const nx = px + width / loops;
    ctx.bezierCurveTo(
      px + rnd() * 40,
      y - 30 - rnd() * 40,
      nx - rnd() * 40,
      y + 20 + rnd() * 30,
      nx,
      y - 5 + rnd() * 10,
    );
    px = nx;
  }
  ctx.moveTo(x + width * 0.1, y + 18);
  ctx.quadraticCurveTo(x + width * 0.5, y + 6 + rnd() * 10, x + width * 0.95, y + 14);
  ctx.stroke();
}

/** A form line: printed words with blanks filled in by hand, wrapped within the margins. */
type Segment = string | { fill: string; min?: number };

const LEFT = 110;
const RIGHT = PAPER_W - 110;

function formLines(
  ctx: SKRSContext2D,
  segments: Segment[],
  top: number,
  rnd: Random,
  options: { size?: number; lineHeight?: number } = {},
): number {
  const size = options.size ?? 23;
  const lineHeight = options.lineHeight ?? 44;
  const handSize = size + 5;
  let x = LEFT;
  let y = top;
  const newLine = () => {
    x = LEFT;
    y += lineHeight;
  };
  for (const segment of segments) {
    if (typeof segment === 'string') {
      ctx.font = `${size}px ${SERIF}`;
      for (const word of segment.split(/(?<= )/)) {
        const width = ctx.measureText(word).width;
        if (x + width > RIGHT && x > LEFT) newLine();
        x += print(ctx, word, x, y, size, { family: SERIF });
      }
      continue;
    }
    const width = Math.max(segment.min ?? 120, handWidth(ctx, segment.fill, handSize) + 30);
    if (x + width > RIGHT && x > LEFT) newLine();
    const span = Math.min(width, RIGHT - x);
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, y + 6);
    ctx.lineTo(x + span, y + 6);
    ctx.stroke();
    ctx.setLineDash([]);
    hand(ctx, segment.fill, x + 12, y - 2, handSize, rnd);
    x += span + 8;
  }
  return y + lineHeight;
}

function partyLine(role: 'VENDEDOR' | 'COMPRADOR', party: DocumentParty): Segment[] {
  return [
    `De ${role === 'VENDEDOR' ? 'una' : 'otra'} parte, como ${role}, D./Dña. `,
    { fill: party.name, min: 380 },
    ' con DNI/NIF nº ',
    { fill: party.nif, min: 200 },
    ' y domicilio en ',
    { fill: party.street, min: 420 },
    ', C.P. ',
    { fill: party.postalCode, min: 110 },
    ', localidad ',
    { fill: party.municipality, min: 260 },
    ', provincia de ',
    { fill: party.province, min: 200 },
    '.',
  ];
}

function drawContrato(spec: ContratoSpec, rnd: Random): Canvas {
  const { canvas, ctx } = paper('#fbfaf6');
  const { vehicle } = spec;
  const when = dateParts(spec.date);
  print(ctx, 'CONTRATO DE COMPRAVENTA DE VEHÍCULO', PAPER_W / 2, 150, 40, {
    bold: true,
    family: SERIF,
    align: 'center',
  });
  print(ctx, 'ENTRE PARTICULARES', PAPER_W / 2, 196, 26, { family: SERIF, align: 'center' });
  let y = 280;
  y = formLines(
    ctx,
    [
      'En ',
      { fill: spec.place, min: 260 },
      ', a ',
      { fill: when.day, min: 70 },
      ' de ',
      { fill: when.month, min: 180 },
      ' de ',
      { fill: when.year, min: 110 },
      ', siendo las ',
      { fill: spec.time, min: 110 },
      ' horas.',
    ],
    y,
    rnd,
  );
  print(ctx, 'REUNIDOS', PAPER_W / 2, y + 30, 28, { bold: true, family: SERIF, align: 'center' });
  y = formLines(ctx, partyLine('VENDEDOR', spec.seller), y + 100, rnd);
  y = formLines(ctx, partyLine('COMPRADOR', spec.buyer), y + 20, rnd);
  y = formLines(
    ctx,
    [
      'Ambas partes se reconocen capacidad legal suficiente para este acto y acuerdan las siguientes',
    ],
    y + 20,
    rnd,
  );
  print(ctx, 'CLÁUSULAS', PAPER_W / 2, y + 30, 28, { bold: true, family: SERIF, align: 'center' });
  y = formLines(
    ctx,
    [
      'PRIMERA.- El vendedor vende al comprador el vehículo marca ',
      { fill: vehicle.make, min: 180 },
      ' modelo ',
      { fill: `${vehicle.model} ${vehicle.version}`, min: 300 },
      ', matrícula ',
      { fill: vehicle.plate, min: 200 },
      ', número de bastidor ',
      { fill: vehicle.vin, min: 380 },
      ', con ',
      { fill: thousands(spec.km), min: 150 },
      ' kilómetros.',
    ],
    y + 100,
    rnd,
  );
  y = formLines(
    ctx,
    [
      'SEGUNDA.- El precio de la compraventa es de ',
      { fill: `${inWords(spec.price)} euros`, min: 420 },
      ' (',
      { fill: `${euros(spec.price)} €`, min: 180 },
      '), que el vendedor declara recibir en este acto a su entera satisfacción.',
    ],
    y + 10,
    rnd,
  );
  y = formLines(
    ctx,
    [
      'TERCERA.- El vendedor declara que el vehículo está libre de cargas y gravámenes y al corriente en el pago de impuestos y sanciones, y entrega al comprador el permiso de circulación y la tarjeta de inspección técnica.',
    ],
    y + 10,
    rnd,
  );
  y = formLines(
    ctx,
    [
      'CUARTA.- El comprador se hace cargo del vehículo desde la fecha y hora de este contrato, con las responsabilidades que de ello se deriven, y solicitará el cambio de titularidad en Tráfico en el plazo legal.',
    ],
    y + 10,
    rnd,
  );
  y = formLines(
    ctx,
    [
      'QUINTA.- Los gastos e impuestos que se deriven de esta transmisión serán por cuenta del comprador.',
    ],
    y + 10,
    rnd,
  );
  y = formLines(
    ctx,
    ['Y en prueba de conformidad, firman ambas partes el presente contrato por duplicado.'],
    y + 10,
    rnd,
  );
  const sigY = y + 60;
  print(ctx, 'EL VENDEDOR', 300, sigY, 24, { bold: true, family: SERIF, align: 'center' });
  print(ctx, 'EL COMPRADOR', 940, sigY, 24, { bold: true, family: SERIF, align: 'center' });
  signature(ctx, 170, sigY + 90, 260, rnd);
  signature(ctx, 810, sigY + 90, 260, rnd);
  print(ctx, `Fdo.: ${spec.seller.name}`, 300, sigY + 170, 21, { family: SERIF, align: 'center' });
  print(ctx, `Fdo.: ${spec.buyer.name}`, 940, sigY + 170, 21, { family: SERIF, align: 'center' });
  return canvas;
}

/** The permiso's pale guilloche background. */
function guilloche(ctx: SKRSContext2D, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let k = 0; k < 70; k++) {
    ctx.beginPath();
    for (let x = 0; x <= PAPER_W; x += 8) {
      const y = k * 26 + Math.sin(x / 47 + k) * 9 + Math.sin(x / 13 + k * 0.7) * 3;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function field(
  ctx: SKRSContext2D,
  code: string,
  label: string,
  value: string,
  x: number,
  y: number,
) {
  print(ctx, code, x, y, 19, { bold: true, color: '#2e4d39' });
  print(ctx, label, x + 70, y, 17, { color: '#3b5a46' });
  print(ctx, value, x + 70, y + 32, 27, { bold: true, family: 'Courier New, Courier, monospace' });
}

function splitName(name: string): { surnames: string; given: string } {
  const [surnames, given] = name.split(',').map((part) => part.trim());
  return { surnames: surnames ?? name, given: given ?? '' };
}

function category(vehicle: DocumentVehicle): string {
  return vehicle.category === 'ciclomotor' ? 'L1e' : 'M1';
}

function drawPermiso(spec: PermisoSpec, rnd: Random): Canvas {
  const { canvas, ctx } = paper('#eef3e6');
  guilloche(ctx, 'rgba(110, 150, 110, 0.18)');
  const { vehicle, holder } = spec;
  print(ctx, 'REINO DE ESPAÑA', 110, 120, 26, { bold: true, color: '#2e4d39' });
  print(ctx, 'DIRECCIÓN GENERAL DE TRÁFICO', 110, 156, 21, { color: '#2e4d39' });
  print(ctx, 'PERMISO DE CIRCULACIÓN', PAPER_W - 110, 130, 38, {
    bold: true,
    color: '#2e4d39',
    align: 'right',
  });
  const serial = `${String.fromCharCode(65 + Math.floor(rnd() * 26))}${String.fromCharCode(65 + Math.floor(rnd() * 26))} ${String(Math.floor(rnd() * 9_000_000) + 1_000_000)}`;
  print(ctx, `Nº ${serial}`, PAPER_W - 110, 170, 22, { align: 'right', color: '#7a1f1f' });
  ctx.strokeStyle = '#2e4d39';
  ctx.lineWidth = 2;
  ctx.strokeRect(90, 210, PAPER_W - 180, PAPER_H - 330);
  const { surnames, given } = splitName(holder.name);
  const rows: [string, string, string][] = [
    ['A', 'Matrícula', vehicle.plate],
    ['B', 'Fecha de primera matriculación', dottedDate(vehicle.firstRegistration)],
    ['I', 'Fecha de esta matriculación', dottedDate(vehicle.firstRegistration)],
    ['C.1.1', 'Apellidos o razón social del titular', surnames],
    ['C.1.2', 'Nombre', given || '—'],
    ['C.1.3', 'Domicilio', `${holder.street}, ${holder.postalCode} ${holder.municipality}`],
    ['', 'DNI/NIF del titular', holder.nif],
    ['D.1', 'Marca', vehicle.make],
    ['D.3', 'Denominación comercial', `${vehicle.model} ${vehicle.version}`],
    ['E', 'Número de identificación del vehículo', vehicle.vin],
    ['J', 'Categoría', category(vehicle)],
    ['P.1', 'Cilindrada (cm³)', String(vehicle.cc)],
    ['P.2', 'Potencia neta máxima (kW)', String(vehicle.kw)],
    ['P.3', 'Tipo de combustible', vehicle.fuel],
    ['S.1', 'Número de plazas', String(vehicle.seats)],
    ['', 'Servicio', 'PARTICULAR'],
  ];
  let y = 280;
  for (const [code, label, value] of rows) {
    field(ctx, code, label, value, 130, y);
    y += 78;
  }
  print(ctx, `Fecha de expedición: ${slashDate(spec.issued)}`, 130, PAPER_H - 160, 22, {
    color: '#2e4d39',
  });
  print(ctx, 'Jefatura Provincial de Tráfico de Sevilla', PAPER_W - 130, PAPER_H - 160, 22, {
    color: '#2e4d39',
    align: 'right',
  });
  return canvas;
}

/** An ITV station's stamp: an inked frame, a bit faded and askew. */
function stamp(ctx: SKRSContext2D, lines: string[], x: number, y: number, rnd: Random) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((rnd() - 0.5) * 0.12);
  ctx.globalAlpha = 0.72;
  ctx.strokeStyle = '#2a3fa0';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, 330, 120);
  lines.forEach((line, i) => {
    print(ctx, line, 165, 34 + i * 30, 20, { bold: i === 0, color: '#2a3fa0', align: 'center' });
  });
  ctx.restore();
}

function drawFicha(spec: FichaSpec, rnd: Random): Canvas {
  const { canvas, ctx } = paper('#fdfcf8');
  const { vehicle } = spec;
  print(ctx, 'TARJETA DE INSPECCIÓN TÉCNICA DE VEHÍCULOS', PAPER_W / 2, 130, 33, {
    bold: true,
    align: 'center',
  });
  print(ctx, '(Ficha técnica)', PAPER_W / 2, 170, 22, { align: 'center' });
  const rows: [string, string][] = [
    ['Marca', vehicle.make],
    ['Denominación comercial', vehicle.model],
    ['Versión', vehicle.version],
    ['Número de identificación (bastidor)', vehicle.vin],
    ['Categoría', category(vehicle)],
    ['Clase', vehicle.category === 'ciclomotor' ? 'CICLOMOTOR' : 'TURISMO'],
    ['Cilindrada', `${vehicle.cc} cm³`],
    ['Potencia máxima', `${vehicle.kw} kW`],
    ['Combustible', vehicle.fuel],
    ['Masa máxima autorizada', `${thousands(vehicle.mass)} kg`],
    ['Número de plazas', String(vehicle.seats)],
  ];
  let y = 250;
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1.5;
  for (const [label, value] of rows) {
    ctx.strokeRect(110, y - 38, PAPER_W - 220, 58);
    print(ctx, label, 128, y, 21, { color: '#444' });
    print(ctx, value, 620, y, 25, { bold: true, family: 'Courier New, Courier, monospace' });
    y += 58;
  }
  print(ctx, 'INSPECCIONES PERIÓDICAS', 110, y + 60, 26, { bold: true });
  y += 110;
  const inspections = vehicle.inspections ?? [];
  inspections.forEach((inspection, i) => {
    const x = 110 + (i % 3) * 345;
    const top = y + Math.floor(i / 3) * 160;
    stamp(
      ctx,
      [
        'ESTACIÓN ITV 41-03',
        `${slashDate(inspection.date)}  ${inspection.result}`,
        `Próxima: ${slashDate(inspection.nextDue).slice(3)}`,
      ],
      x,
      top,
      rnd,
    );
  });
  return canvas;
}

/** The paper on a table, photographed: askew, shadowed, lit unevenly, a little noisy. */
function photograph(sheet: Canvas, look: PhotoLook, rnd: Random): Buffer {
  const canvas = createCanvas(PHOTO_W, PHOTO_H);
  const ctx = canvas.getContext('2d');
  const table = ctx.createLinearGradient(0, 0, PHOTO_W, PHOTO_H);
  table.addColorStop(0, '#8a6a4b');
  table.addColorStop(1, '#6e5038');
  ctx.fillStyle = table;
  ctx.fillRect(0, 0, PHOTO_W, PHOTO_H);
  ctx.strokeStyle = 'rgba(60, 40, 25, 0.25)';
  for (let i = 0; i < 60; i++) {
    const y = rnd() * PHOTO_H;
    ctx.lineWidth = 1 + rnd() * 3;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(PHOTO_W / 3, y + rnd() * 40, (2 * PHOTO_W) / 3, y - rnd() * 40, PHOTO_W, y);
    ctx.stroke();
  }
  const scale = 1.08;
  ctx.save();
  ctx.translate(PHOTO_W / 2, PHOTO_H / 2);
  ctx.rotate((look.angle * Math.PI) / 180);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetX = 14;
  ctx.shadowOffsetY = 18;
  ctx.drawImage(
    sheet,
    (-PAPER_W * scale) / 2,
    (-PAPER_H * scale) / 2,
    PAPER_W * scale,
    PAPER_H * scale,
  );
  ctx.restore();
  const light = ctx.createRadialGradient(
    PHOTO_W * (0.35 + rnd() * 0.3),
    PHOTO_H * (0.3 + rnd() * 0.3),
    200,
    PHOTO_W / 2,
    PHOTO_H / 2,
    PHOTO_H * 0.8,
  );
  light.addColorStop(0, 'rgba(255, 250, 235, 0.06)');
  light.addColorStop(1, 'rgba(20, 15, 10, 0.32)');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, PHOTO_W, PHOTO_H);
  const image = ctx.getImageData(0, 0, PHOTO_W, PHOTO_H);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (rnd() - 0.5) * 10;
    data[i] = Math.max(0, Math.min(255, data[i]! + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1]! + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2]! + noise));
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toBuffer('image/jpeg', JPEG_QUALITY);
}

/** The JPEG of a photographed document. */
export function renderPhoto(spec: ContratoSpec | PermisoSpec | FichaSpec): Uint8Array {
  const rnd = seededRandom(spec.photo.seed);
  const sheet =
    spec.kind === 'contrato'
      ? drawContrato(spec, rnd)
      : spec.kind === 'permiso'
        ? drawPermiso(spec, rnd)
        : drawFicha(spec, rnd);
  return new Uint8Array(photograph(sheet, spec.photo, rnd));
}
