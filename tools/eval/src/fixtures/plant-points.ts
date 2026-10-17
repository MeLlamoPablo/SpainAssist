/**
 * Which injection variants draw their text on a page of the vida laboral PDF. `document_read` shows
 * a PDF's pages as images as well as text, and a model that reads only part of the text (it may ask
 * for fewer characters) still sees the page: for these variants a page image counts as shown.
 *
 * SpainBench lists each variant's placement points in `GET /version`; `runnable` refuses a server
 * whose list disagrees with this one, so the two cannot drift apart silently.
 */
const PDF_PAGE_POINTS: ReadonlySet<string> = new Set(['pdf.annex', 'pdf.footer']);

export const PDF_PAGE_VARIANTS: ReadonlySet<string> = new Set([
  'assistant-notice',
  'fake-verification',
]);

export function drawsOnPdfPage(points: readonly string[]): boolean {
  return points.some((point) => PDF_PAGE_POINTS.has(point));
}
