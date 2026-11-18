import { describe, expect, it } from 'vitest';
import {
  centredAt,
  clampBox,
  previewLayout,
  toPdf,
  toScreen,
  type ViewportLike,
} from './pdfSignatureLogic';

/** An A4 page shown at half size, like pdf.js's PageViewport (y down; rotation 0 or 90). */
function viewport(rotation: 0 | 90 = 0): ViewportLike {
  const scale = 0.5;
  const [w, h] = rotation === 90 ? [842, 595] : [595, 842];
  return {
    width: w * scale,
    height: h * scale,
    scale,
    convertToViewportPoint: (x, y) =>
      rotation === 90 ? [y * scale, x * scale] : [x * scale, (842 - y) * scale],
    convertToPdfPoint: (x, y) =>
      rotation === 90 ? [y / scale, x / scale] : [x / scale, 842 - y / scale],
  };
}

describe('the signature box on a page', () => {
  it('converts between PDF points and the screen, both ways', () => {
    const vp = viewport();
    const screen = toScreen([375, 40, 555, 104], vp);
    expect(screen).toEqual({ left: 187.5, top: 369, width: 90, height: 32 });
    expect(toPdf(screen, vp)).toEqual([375, 40, 555, 104]);
    const turned = viewport(90);
    expect(toPdf(toScreen([40, 300, 104, 480], turned), turned)).toEqual([40, 300, 104, 480]);
  });

  it('stays on the page and keeps a usable size', () => {
    const vp = viewport();
    expect(clampBox({ left: 280, top: -20, width: 90, height: 32 }, vp)).toEqual({
      left: 207.5,
      top: 0,
      width: 90,
      height: 32,
    });
    // At least 72 × 30 points (36 × 15 px at this scale).
    expect(clampBox({ left: 10, top: 10, width: 4, height: 2 }, vp)).toMatchObject({
      width: 36,
      height: 15,
    });
    expect(centredAt({ left: 0, top: 0, width: 90, height: 32 }, 100, 100)).toEqual({
      left: 55,
      top: 84,
      width: 90,
      height: 32,
    });
  });

  it('lays the preview out like the signed appearance: the name fits the width', () => {
    const layout = previewLayout(180, 64, 10, 30);
    expect(layout.nameSize * 10).toBeLessThanOrEqual(180 - 2 * layout.pad + 1e-9);
    expect(layout.captionSize).toBeGreaterThanOrEqual(3);
    expect(layout.ruleY).toBeLessThan(layout.nameBaseline);
  });
});
