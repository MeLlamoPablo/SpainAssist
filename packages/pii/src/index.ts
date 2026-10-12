/**
 * @sa/pii — personal data detection and scrubbing for Spanish text. Used by the desktop app
 * (before sending feedback) and by the feedback server (defense in depth). Pure TS, no deps,
 * runs in Node and browsers.
 *
 * Layers: (1) exact match of the caller's known values (the user's vault), (2) checksum-validated
 * identifiers (DNI, NIE, CIF, IBAN, CCC, NUSS, cards), (3) patterns with context words (phones,
 * emails, addresses, postal codes, plates, cadastral refs, birth dates, passports, case numbers,
 * names after "me llamo"/"Sr."…, IPs, URL parameters). Overlapping findings are merged into one
 * redaction. Names without context are not detected: pass them as known values.
 */
import { detectPatterns, urlParamsOffset } from './detectors';
import { detectKnownValues } from './known';
import type { PiiFinding, PiiType, ScrubOptions, ScrubResult, Span } from './types';

export { knownValueKeys } from './known';
export type { PiiFinding, PiiType, ScrubOptions, ScrubResult } from './types';
export { PII_TYPES } from './types';
export {
  isLuhn,
  isValidCcc,
  isValidCif,
  isValidDni,
  isValidIban,
  isValidKlmNif,
  isValidNie,
  isValidNuss,
} from './validators';

/** Default replacements. URL parameters are removed rather than replaced. */
export const DEFAULT_PLACEHOLDERS: Readonly<Record<PiiType, string>> = {
  dni: '[DNI]',
  nie: '[NIE]',
  cif: '[CIF]',
  passport: '[PASAPORTE]',
  nuss: '[NUSS]',
  iban: '[IBAN]',
  ccc: '[CUENTA BANCARIA]',
  card: '[TARJETA]',
  phone: '[TELÉFONO]',
  email: '[EMAIL]',
  address: '[DIRECCIÓN]',
  postal_code: '[CÓDIGO POSTAL]',
  plate: '[MATRÍCULA]',
  cadastral_ref: '[REF. CATASTRAL]',
  date_of_birth: '[FECHA DE NACIMIENTO]',
  case_number: '[REFERENCIA]',
  name: '[NOMBRE]',
  url_params: '',
  ip: '[IP]',
  known_value: '[DATO PERSONAL]',
};

/** When overlapping findings are equally long, the more specific type labels the redaction. */
const PRIORITY: readonly PiiType[] = [
  'iban',
  'ccc',
  'card',
  'nuss',
  'dni',
  'nie',
  'cif',
  'passport',
  'cadastral_ref',
  'email',
  'phone',
  'ip',
  'plate',
  'date_of_birth',
  'case_number',
  'address',
  'postal_code',
  'name',
  'known_value',
  'url_params',
];

/**
 * Merges overlapping spans into one redaction covering their union, labelled with the longest
 * span (ties: the most specific type).
 */
function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  let cluster: Span[] = [];
  let end = -1;
  const flush = () => {
    if (cluster.length === 0) return;
    const label = cluster.reduce((best, s) => {
      const len = s.end - s.start;
      const bestLen = best.end - best.start;
      if (len !== bestLen) return len > bestLen ? s : best;
      return PRIORITY.indexOf(s.type) < PRIORITY.indexOf(best.type) ? s : best;
    });
    out.push({ type: label.type, start: cluster[0]!.start, end });
  };
  for (const s of sorted) {
    if (cluster.length > 0 && s.start < end) {
      cluster.push(s);
      end = Math.max(end, s.end);
    } else {
      flush();
      cluster = [s];
      end = s.end;
    }
  }
  flush();
  return out;
}

/** Joins name parts split only by spaces ("Pablo" + "Rodríguez") into one redaction. */
function coalesce(text: string, spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const prev = out.at(-1);
    if (
      prev &&
      prev.type === s.type &&
      (s.type === 'known_value' || s.type === 'name') &&
      /^[ \t]+$/.test(text.slice(prev.end, s.start))
    ) {
      prev.end = s.end;
    } else out.push({ ...s });
  }
  return out;
}

/** Finds personal data in `text`. Findings never overlap and are sorted by position. */
export function detectPii(text: string, opts: ScrubOptions = {}): PiiFinding[] {
  if (!text) return [];
  const allow = new Set(opts.allow ?? []);
  const spans = detectPatterns(text);
  if (opts.knownValues?.length) spans.push(...detectKnownValues(text, opts.knownValues));
  return coalesce(text, merge(spans.filter((s) => !allow.has(s.type)))).map((s) => ({
    ...s,
    match: text.slice(s.start, s.end),
  }));
}

/** Replaces personal data with placeholders such as "[DNI]" or "[DATO PERSONAL]". */
export function scrubPii(text: string, opts: ScrubOptions = {}): ScrubResult {
  const findings = detectPii(text, opts);
  const placeholder = opts.placeholder ?? ((type: PiiType) => DEFAULT_PLACEHOLDERS[type]);
  let out = '';
  let pos = 0;
  for (const f of findings) {
    out += text.slice(pos, f.start) + placeholder(f.type);
    pos = f.end;
  }
  out += text.slice(pos);
  return { text: out, findings: findings.map(({ type, start, end }) => ({ type, start, end })) };
}

/** Removes query strings and fragments: https://x.gob.es/a?id=1#b -> https://x.gob.es/a */
export function stripUrlParams(url: string): string {
  // Credentials in the authority ("https://user:pass@host") go too.
  const u = url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s?#]+@/i, '$1');
  const q = urlParamsOffset(u);
  return q >= 0 ? u.slice(0, q) : u;
}
