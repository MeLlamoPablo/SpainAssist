/**
 * Geometry of the visible-signature box on a rendered PDF page. The box is kept in the page's
 * PDF user space (what the signer writes); on screen it is a rectangle in the page's viewport
 * (CSS pixels, y down), and pdf.js's viewport converts between them (rotation included).
 */

export type Rect = [number, number, number, number];

/** pdf.js's PageViewport, as far as the box needs it. */
export interface ViewportLike {
  width: number;
  height: number;
  scale: number;
  convertToViewportPoint(x: number, y: number): number[];
  convertToPdfPoint(x: number, y: number): number[];
}

/** Screen rectangle: left, top, width, height in CSS pixels. */
export interface ScreenBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The smallest box the user can make, in points (AutoFirma's dialog asks for about this). */
const MIN_BOX = { width: 72, height: 30 };

export function toScreen(rect: Rect, viewport: ViewportLike): ScreenBox {
  const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

export function toPdf(box: ScreenBox, viewport: ViewportLike): Rect {
  const [ax, ay] = viewport.convertToPdfPoint(box.left, box.top);
  const [bx, by] = viewport.convertToPdfPoint(box.left + box.width, box.top + box.height);
  const r = (n: number) => Math.round(n * 100) / 100;
  return [r(Math.min(ax, bx)), r(Math.min(ay, by)), r(Math.max(ax, bx)), r(Math.max(ay, by))];
}

/** Keeps a screen box inside its page and at least MIN_BOX big. */
export function clampBox(box: ScreenBox, viewport: ViewportLike): ScreenBox {
  const minW = Math.min(MIN_BOX.width * viewport.scale, viewport.width);
  const minH = Math.min(MIN_BOX.height * viewport.scale, viewport.height);
  const width = Math.min(Math.max(box.width, minW), viewport.width);
  const height = Math.min(Math.max(box.height, minH), viewport.height);
  return {
    width,
    height,
    left: Math.min(Math.max(box.left, 0), viewport.width - width),
    top: Math.min(Math.max(box.top, 0), viewport.height - height),
  };
}

/** The box moved so its centre is at (x, y), same size. */
export function centredAt(box: ScreenBox, x: number, y: number): ScreenBox {
  return { ...box, left: x - box.width / 2, top: y - box.height / 2 };
}

/**
 * What the handwritten preview draws, in points of a `w` × `h` box: the same layout as the
 * signer's (`packages/signer/src/appearance.ts`), so the preview matches the signed PDF.
 * `nameWidth` is the name's width at 1 pt of the script font.
 */
export function previewLayout(w: number, h: number, nameWidth: number, captionWidth: number) {
  const pad = Math.min(w, h) * 0.07;
  const innerW = w - 2 * pad;
  const captionSize = Math.max(3, Math.min(h * 0.085, 9, innerW / Math.max(captionWidth, 1)));
  const leading = captionSize * 1.25;
  const ruleY = pad + leading * 2 + captionSize * 0.6;
  const bottom = ruleY + captionSize * 0.2;
  // Great Vibes: glyphs reach about 0.8 em above the baseline and 0.32 em below.
  const above = 0.8;
  const below = 0.32;
  const nameSize = Math.max(
    1,
    Math.min(innerW / Math.max(nameWidth, 0.01), (h - pad - bottom) / (above + below * 0.66)),
  );
  return {
    pad,
    captionSize,
    leading,
    ruleY,
    nameSize,
    nameBaseline: bottom + below * 0.66 * nameSize,
  };
}
