import { createHash } from 'node:crypto';
import { extractText, getDocumentProxy } from 'unpdf';
import { stripDiacritics } from '../answers/text';

/** Larger PDFs are not read: a vault document may be up to 50 MB, the reports are far smaller. */
const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** The text of every page of a PDF, extracted with unpdf like the agent's `document_read`. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new Error(`the PDF is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB`);
  }
  if (!startsWithPdfMagic(bytes)) throw new Error('the file does not start with %PDF-');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

function startsWithPdfMagic(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Text prepared for label matching: accents removed, whitespace collapsed. */
export function normalizePdfText(text: string): string {
  return stripDiacritics(text).replace(/\s+/g, ' ');
}

// "Código Seguro de Verificación (CSV): <code>", after normalisation.
const LABELLED_CODE =
  /codigo seguro de verificacion ?(?:\(?csv\)?)? ?[:-]? ?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/gi;

/** The verification codes a report prints: the token that follows each "Código Seguro de Verificación" label. */
export function verificationCodes(text: string): string[] {
  const codes = new Set<string>();
  for (const match of normalizePdfText(text).matchAll(LABELLED_CODE)) codes.add(match[1]!);
  return [...codes];
}
