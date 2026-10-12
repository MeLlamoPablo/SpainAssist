/** A QR-looking SVG (finder patterns + pseudo-random modules). It does not encode anything. */
import { createHash } from 'node:crypto';
import { html, raw, type SafeHtml } from './html';

const SIZE = 29;

export function fakeQrSvg(seed: string, label: string): SafeHtml {
  const bits: boolean[] = [];
  let block = createHash('sha256').update(seed).digest();
  while (bits.length < SIZE * SIZE) {
    for (const byte of block) for (let b = 0; b < 8; b++) bits.push(((byte >> b) & 1) === 1);
    block = createHash('sha256').update(block).digest();
  }
  const inFinder = (x: number, y: number) =>
    (x < 8 && y < 8) || (x >= SIZE - 8 && y < 8) || (x < 8 && y >= SIZE - 8);
  const rects: string[] = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!inFinder(x, y) && bits[y * SIZE + x]) rects.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  const finder = (x: number, y: number) =>
    `<rect x="${x}" y="${y}" width="7" height="7" fill="#000"/>` +
    `<rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/>` +
    `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="#000"/>`;
  return html`<svg class="qr" role="img" aria-label="${label}" viewBox="-2 -2 ${SIZE + 4} ${SIZE + 4}" width="232" height="232" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
    <rect x="-2" y="-2" width="${SIZE + 4}" height="${SIZE + 4}" fill="#fff"/>
    ${raw(finder(0, 0) + finder(SIZE - 7, 0) + finder(0, SIZE - 7))}
    <path d="${rects.join('')}" fill="#000"/>
  </svg>`;
}
