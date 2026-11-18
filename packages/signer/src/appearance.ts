/**
 * What a visible PDF signature shows: the content stream of its appearance (a Form XObject).
 *
 * - `handwritten` (ours, the default): the signer's name in a script font, drawn as vector paths
 *   (no font is embedded), over a hairline and a small Helvetica caption with the full name, the
 *   NIF and the date.
 * - `text`: the site's `layer2Text` (placeholders already expanded) in one of the standard PDF
 *   fonts, with its size, style and colour, over an optional rubric image, the way AutoFirma
 *   lays them out.
 *
 * Sizes are in points of the box as the reader sees it (after the page's /Rotate).
 */
import fontkit from '@pdf-lib/fontkit';
import { StandardFontEmbedder, StandardFonts } from 'pdf-lib';
import { maskIds } from './visible';

type Rgb = [number, number, number];

interface HandwrittenAppearance {
  style: 'handwritten';
  /** The name drawn in the script font ("Pablo Rodríguez Caballero"). */
  name: string;
  /** National ID shown in the caption, masked as AutoFirma does (`***4567**`). */
  holderId?: string;
  date: Date;
  /** A TrueType/OpenType script font. Without it the name is drawn in Helvetica Oblique. */
  scriptFont?: Uint8Array;
}

interface TextAppearance {
  style: 'text';
  text: string;
  font: 'Courier' | 'Helvetica' | 'Times';
  bold?: boolean;
  italic?: boolean;
  /** Points; undefined fits the text to the box. */
  size?: number;
  color: Rgb;
  /** JPEG bytes of the rubric (an image of a handwritten signature), under the text. */
  rubricJpeg?: Uint8Array;
}

export type AppearanceSpec = HandwrittenAppearance | TextAppearance;

export interface BuiltAppearance {
  /** Content stream operators. */
  content: string;
  /** Standard fonts used, by resource name. */
  fonts: Record<string, string>;
  /** The rubric image, when drawn (resource name /Im1). */
  image?: { jpeg: Uint8Array; width: number; height: number; colorSpace: string; bits: number };
}

const INK: Rgb = [0.09, 0.2, 0.47];
const CAPTION: Rgb = [0.27, 0.29, 0.33];
const RULE: Rgb = [0.72, 0.74, 0.78];

const num = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};
const rgb = (c: Rgb, stroke = false): string =>
  `${c.map((v) => num(v)).join(' ')} ${stroke ? 'RG' : 'rg'}`;

/** Spanish date and time, as on a paper signature: 18/11/2026 20:45. */
function signatureDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const PARTICLES = new Set([
  'de',
  'del',
  'la',
  'las',
  'los',
  'y',
  'i',
  'e',
  'da',
  'das',
  'do',
  'dos',
]);

/** "RODRIGUEZ CABALLERO, PABLO" or "PABLO RODRIGUEZ" → "Pablo Rodriguez" (particles lowercase). */
export function displayName(name: string): string {
  const flipped = /^([^,]+),\s*(.+)$/.exec(name.trim());
  const ordered = flipped ? `${flipped[2]} ${flipped[1]}` : name;
  const words = ordered.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const shouting = ordered === ordered.toLocaleUpperCase('es');
  return words
    .map((word, i) => {
      if (!shouting) return word;
      const lower = word.toLocaleLowerCase('es');
      if (i > 0 && PARTICLES.has(lower)) return lower;
      return lower.replace(
        /(^|[-'’])(\p{L})/gu,
        (_m, sep: string, ch: string) => sep + ch.toLocaleUpperCase('es'),
      );
    })
    .join(' ');
}

// --- standard fonts ---------------------------------------------------------------------------

const embedders = new Map<string, StandardFontEmbedder>();
function standardFont(name: string): StandardFontEmbedder {
  let e = embedders.get(name);
  if (!e) {
    e = StandardFontEmbedder.for(name as Parameters<typeof StandardFontEmbedder.for>[0]);
    embedders.set(name, e);
  }
  return e;
}

/** WinAnsi can't show every character: drop accents first, then use '?'. */
function encodable(font: StandardFontEmbedder, text: string): string {
  let out = '';
  for (const ch of text) {
    for (const candidate of [ch, ch.normalize('NFD').replace(/\p{M}/gu, ''), '?']) {
      try {
        if (candidate) font.encodeText(candidate);
        out += candidate;
        break;
      } catch {
        // try the next candidate
      }
    }
  }
  return out;
}

function standardName(font: TextAppearance['font'], bold?: boolean, italic?: boolean): string {
  const slant = font === 'Times' ? 'Italic' : 'Oblique';
  if (font === 'Times') {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  const base = font === 'Courier' ? 'Courier' : 'Helvetica';
  if (bold && italic) return `${base}-Bold${slant}`;
  if (bold) return `${base}-Bold`;
  if (italic) return `${base}-${slant}`;
  return base;
}

function showText(font: StandardFontEmbedder, text: string): string {
  return `${font.encodeText(text).toString()} Tj`;
}

/** Splits `text` into lines no wider than `width` at `size` (breaks at spaces, then anywhere). */
function wrap(font: StandardFontEmbedder, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/ +/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

// --- script name as paths ---------------------------------------------------------------------

interface Outline {
  /** Path operators in font units, baseline at y = 0. */
  ops: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const fonts = new WeakMap<Uint8Array, fontkit.Font>();

function outline(fontBytes: Uint8Array, text: string): Outline | undefined {
  let font = fonts.get(fontBytes);
  if (!font) {
    font = fontkit.create(Buffer.from(fontBytes));
    fonts.set(fontBytes, font);
  }
  const run = font.layout(text);
  const parts: string[] = [];
  let x = 0;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  run.glyphs.forEach((glyph, i) => {
    const pos = run.positions[i];
    const ox = x + pos.xOffset;
    const oy = pos.yOffset;
    let cx = 0;
    let cy = 0;
    // fontkit's typings leave out the path's commands.
    const { commands } = glyph.path as unknown as {
      commands: { command: string; args: number[] }[];
    };
    for (const { command, args } of commands) {
      const p = (k: number) => `${num(args[k] + ox)} ${num(args[k + 1] + oy)}`;
      switch (command) {
        case 'moveTo':
          parts.push(`${p(0)} m`);
          [cx, cy] = [args[0], args[1]];
          break;
        case 'lineTo':
          parts.push(`${p(0)} l`);
          [cx, cy] = [args[0], args[1]];
          break;
        case 'quadraticCurveTo': {
          // Exact cubic for a quadratic: control points 2/3 of the way to the quadratic's.
          const [qx, qy, ex, ey] = args;
          const c1x = cx + (2 / 3) * (qx - cx);
          const c1y = cy + (2 / 3) * (qy - cy);
          const c2x = ex + (2 / 3) * (qx - ex);
          const c2y = ey + (2 / 3) * (qy - ey);
          parts.push(
            `${num(c1x + ox)} ${num(c1y + oy)} ${num(c2x + ox)} ${num(c2y + oy)} ${num(ex + ox)} ${num(ey + oy)} c`,
          );
          [cx, cy] = [ex, ey];
          break;
        }
        case 'bezierCurveTo':
          parts.push(`${p(0)} ${p(2)} ${p(4)} c`);
          [cx, cy] = [args[4], args[5]];
          break;
        case 'closePath':
          parts.push('h');
          break;
      }
    }
    const box = glyph.path.bbox;
    if (Number.isFinite(box.minX) && box.maxX > box.minX) {
      minX = Math.min(minX, box.minX + ox);
      maxX = Math.max(maxX, box.maxX + ox);
      minY = Math.min(minY, box.minY + oy);
      maxY = Math.max(maxY, box.maxY + oy);
    }
    x += pos.xAdvance;
  });
  if (!Number.isFinite(minX)) return undefined;
  return { ops: parts.join('\n'), minX, maxX, minY, maxY };
}

// --- layouts ----------------------------------------------------------------------------------

function handwritten(spec: HandwrittenAppearance, w: number, h: number): BuiltAppearance {
  const pad = Math.min(w, h) * 0.07;
  const innerW = w - 2 * pad;
  const caption = standardFont(StandardFonts.Helvetica);
  const lines = [
    encodable(caption, `Firmado digitalmente por ${spec.name}`),
    encodable(
      caption,
      [spec.holderId ? `NIF ${maskIds(spec.holderId)}` : '', signatureDate(spec.date)]
        .filter(Boolean)
        .join(' · '),
    ),
  ];
  const widest = Math.max(...lines.map((l) => caption.widthOfTextAtSize(l, 1)));
  const captionSize = Math.max(3, Math.min(h * 0.085, 9, innerW / widest));
  const leading = captionSize * 1.25;
  const captionH = leading * lines.length;
  const ops: string[] = [];

  // Caption, bottom up.
  ops.push('BT', rgb(CAPTION), `/F1 ${num(captionSize)} Tf`);
  lines.forEach((line, i) => {
    const y = pad + (lines.length - 1 - i) * leading + captionSize * 0.2;
    ops.push(`1 0 0 1 ${num(pad)} ${num(y)} Tm`, showText(caption, line));
  });
  ops.push('ET');

  // Rule over the caption.
  const ruleY = pad + captionH + captionSize * 0.6;
  ops.push(
    rgb(RULE, true),
    `${num(Math.max(0.4, captionSize * 0.08))} w`,
    `${num(pad)} ${num(ruleY)} m ${num(w - pad)} ${num(ruleY)} l S`,
  );

  // The name, as large as fits above the rule (its descenders may cross it, like ink would).
  const top = h - pad;
  const bottom = ruleY + captionSize * 0.2;
  const shape = spec.scriptFont ? outline(spec.scriptFont, spec.name) : undefined;
  if (shape) {
    const shapeW = shape.maxX - shape.minX;
    const above = shape.maxY;
    const below = Math.max(0, -shape.minY);
    // The baseline sits on `bottom`; let a third of the descenders cross the rule.
    const scale = Math.min(innerW / shapeW, (top - bottom) / (above + below * 0.66));
    if (scale > 0) {
      const x = pad + (innerW - shapeW * scale) / 2 - shape.minX * scale;
      const y = bottom + below * 0.66 * scale;
      ops.push(
        'q',
        rgb(INK),
        `${num(scale)} 0 0 ${num(scale)} ${num(x)} ${num(y)} cm`,
        shape.ops,
        'f',
        'Q',
      );
    }
  } else {
    const oblique = standardFont(StandardFonts.HelveticaOblique);
    const name = encodable(oblique, spec.name);
    const size = Math.max(
      3,
      Math.min((top - bottom) * 0.8, innerW / Math.max(1, oblique.widthOfTextAtSize(name, 1))),
    );
    ops.push(
      'BT',
      rgb(INK),
      `/F2 ${num(size)} Tf`,
      `1 0 0 1 ${num(pad)} ${num(bottom + size * 0.25)} Tm`,
      showText(oblique, name),
      'ET',
    );
    return {
      content: ops.join('\n'),
      fonts: { F1: StandardFonts.Helvetica, F2: StandardFonts.HelveticaOblique },
    };
  }
  return { content: ops.join('\n'), fonts: { F1: StandardFonts.Helvetica } };
}

function jpegInfo(bytes: Uint8Array) {
  // SOFn marker: precision, height, width, components.
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return undefined;
    const marker = bytes[i + 1];
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const bits = bytes[i + 4];
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      const components = bytes[i + 9];
      const colorSpace =
        components === 1 ? 'DeviceGray' : components === 4 ? 'DeviceCMYK' : 'DeviceRGB';
      return { width, height, bits, colorSpace };
    }
    i += 2 + length;
  }
  return undefined;
}

function text(spec: TextAppearance, w: number, h: number): BuiltAppearance {
  const fontName = standardName(spec.font, spec.bold, spec.italic);
  const font = standardFont(fontName);
  const ops: string[] = [];
  let image: BuiltAppearance['image'];
  const textX = 2;
  const textW = w - 4;
  const info = spec.rubricJpeg && jpegInfo(spec.rubricJpeg);
  if (spec.rubricJpeg && info) {
    // AutoFirma: the rubric is centred and scaled to fit (aspect kept), the text drawn over it.
    const scale = Math.min(w / info.width, h / info.height);
    const iw = info.width * scale;
    const ih = info.height * scale;
    ops.push(`q ${num(iw)} 0 0 ${num(ih)} ${num((w - iw) / 2)} ${num((h - ih) / 2)} cm /Im1 Do Q`);
    image = { jpeg: spec.rubricJpeg, ...info };
  }
  const body = spec.text
    .split(/\r?\n/)
    .map((line) => encodable(font, line))
    .join('\n');
  if (body.trim()) {
    // The site's size, shrunk until the text fits the box (AutoFirma would cut it off).
    let size = spec.size && spec.size > 0 ? spec.size : 12;
    let lines = wrap(font, body, size, textW);
    while (size > 3 && lines.length * size * 1.15 > h - 4) {
      size -= 0.5;
      lines = wrap(font, body, size, textW);
    }
    const leading = size * 1.15;
    ops.push('BT', rgb(spec.color), `/F1 ${num(size)} Tf`);
    lines.forEach((line, i) => {
      const y = h - 2 - size * 0.9 - i * leading;
      ops.push(`1 0 0 1 ${num(textX)} ${num(y)} Tm`, showText(font, line));
    });
    ops.push('ET');
  }
  return { content: ops.join('\n'), fonts: { F1: fontName }, image };
}

export function buildAppearance(spec: AppearanceSpec, w: number, h: number): BuiltAppearance {
  return spec.style === 'handwritten' ? handwritten(spec, w, h) : text(spec, w, h);
}
