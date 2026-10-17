import { shorten, testRegex } from '../answers/text';
import type { BenchDownload, BenchWorldState, RunView, VaultDocumentPredicate } from '../contracts';
import { compareValue, resolvePath, showValues } from './path';
import { extractPdfText, normalizePdfText, sha256, verificationCodes } from './pdf';

export type VaultDocument = Awaited<ReturnType<RunView['vaultDocuments']>>[number];

/** What the check needs of the run, resolved lazily and cached by the caller. */
export interface VaultCheckContext {
  documents: readonly VaultDocument[];
  benchState(): Promise<BenchWorldState>;
  /** The PDF's text and the sha256 of its bytes (cached per document id by the caller). */
  pdf(document: VaultDocument): Promise<{ text: string; sha256: string }>;
}

export interface CheckResult {
  value: boolean;
  detail: string;
}

/** Reads a document's PDF text and hash. The engine caches the result by document id. */
export async function readPdf(document: VaultDocument): Promise<{ text: string; sha256: string }> {
  const bytes = await document.read();
  return { text: await extractPdfText(bytes), sha256: sha256(bytes) };
}

function mimeOf(value: string): string {
  return value.split(';')[0]!.trim().toLowerCase();
}

function describeDocument(document: VaultDocument): string {
  return `"${shorten(document.name, 60)}" (${document.mimeType}, ${document.source ?? 'no source'})`;
}

function describeCriteria(where: VaultDocumentPredicate): string {
  const parts = [
    where.mimeType !== undefined ? `mime type ${where.mimeType}` : undefined,
    where.source !== undefined ? `source ${where.source}` : undefined,
    where.nameMatches ? `name ${where.nameMatches}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'any properties';
}

function documentMatchesBasics(document: VaultDocument, where: VaultDocumentPredicate): boolean {
  if (where.mimeType !== undefined && mimeOf(document.mimeType) !== mimeOf(where.mimeType)) {
    return false;
  }
  if (where.source !== undefined && document.source !== where.source) return false;
  if (where.nameMatches !== undefined && !testRegex(where.nameMatches, document.name)) return false;
  return true;
}

/** Whether a download record satisfies every `where` entry (a value is compared by equality, a regex is tested). */
function recordMatches(record: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return mismatches(record, where).length === 0;
}

function mismatches(record: Record<string, unknown>, where: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, expected] of Object.entries(where)) {
    const values = resolvePath(record, key);
    const ok = values.some((value) =>
      expected instanceof RegExp
        ? compareValue(value, { matches: expected })
        : compareValue(value, { equals: expected }),
    );
    if (!ok) {
      const wanted = expected instanceof RegExp ? String(expected) : JSON.stringify(expected);
      out.push(`${key} is ${showValues(values, 60)}, expected ${wanted}`);
    }
  }
  return out;
}

function recordCsv(download: BenchDownload): string | undefined {
  const csv = download.record.csv;
  return typeof csv === 'string' && csv.length > 0 ? csv : undefined;
}

async function verifyPdf(
  document: VaultDocument,
  spec: NonNullable<VaultDocumentPredicate['pdfCsvMatchesBenchDownload']>,
  context: VaultCheckContext,
): Promise<CheckResult> {
  const label = describeDocument(document);
  let pdf: { text: string; sha256: string };
  try {
    pdf = await context.pdf(document);
  } catch (error) {
    return { value: false, detail: `${label}: cannot read the PDF (${(error as Error).message})` };
  }
  const codes = verificationCodes(pdf.text);
  if (codes.length === 0) {
    const chars = normalizePdfText(pdf.text).length;
    return {
      value: false,
      detail: `${label}: no "Código Seguro de Verificación" in the PDF text (${chars} characters read)`,
    };
  }

  const state = await context.benchState();
  const ofSite = state.downloads.filter((download) => download.site === spec.site);
  if (ofSite.length === 0) {
    return {
      value: false,
      detail: `${label}: SpainBench has no download of site "${spec.site}" (the server never sent a report)`,
    };
  }

  const indexOf = (download: BenchDownload) => state.downloads.indexOf(download);
  const hit = ofSite.find((download) => {
    const csv = recordCsv(download);
    return csv !== undefined && codes.includes(csv) && recordMatches(download.record, spec.where);
  });
  if (hit) {
    const csv = recordCsv(hit);
    const bytes =
      hit.sha256 === undefined
        ? ''
        : hit.sha256 === pdf.sha256
          ? '; bytes identical to the emitted file'
          : '; bytes differ from the emitted file';
    return {
      value: true,
      detail: `${label}: code ${csv} is the code of SpainBench download #${indexOf(hit)} of "${spec.site}"${bytes}`,
    };
  }

  const wrongRecord = ofSite.find((download) => {
    const csv = recordCsv(download);
    return csv !== undefined && codes.includes(csv);
  });
  if (wrongRecord) {
    return {
      value: false,
      detail: `${label}: code ${recordCsv(wrongRecord)} is the code of download #${indexOf(wrongRecord)}, which does not satisfy the expectation (${mismatches(wrongRecord.record, spec.where).join('; ')})`,
    };
  }
  const known = ofSite.map(recordCsv).filter((csv): csv is string => csv !== undefined);
  return {
    value: false,
    detail: `${label}: PDF code(s) ${codes.join(', ')} are not the code of any of the ${ofSite.length} SpainBench download(s) of "${spec.site}" (known: ${known.join(', ') || 'none'})`,
  };
}

/** Evaluates a `vaultDocument` condition: some saved document satisfies every property set. */
export async function checkVaultDocument(
  where: VaultDocumentPredicate,
  context: VaultCheckContext,
): Promise<CheckResult> {
  const candidates = context.documents.filter((document) => documentMatchesBasics(document, where));
  if (candidates.length === 0) {
    const saved = context.documents.map(describeDocument);
    return {
      value: false,
      detail: `no saved document with ${describeCriteria(where)}; saved: ${
        saved.length > 0 ? shorten(saved.join(', '), 300) : 'none'
      }`,
    };
  }
  const spec = where.pdfCsvMatchesBenchDownload;
  if (!spec) {
    return { value: true, detail: `document ${describeDocument(candidates[0]!)}` };
  }
  const failures: string[] = [];
  for (const candidate of candidates) {
    const result = await verifyPdf(candidate, spec, context);
    if (result.value) return result;
    failures.push(result.detail);
  }
  return { value: false, detail: failures.join(' | ') };
}
