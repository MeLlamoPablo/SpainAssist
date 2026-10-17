/**
 * Exact-match redaction of caller-supplied values (the user's vault: names, document numbers,
 * address parts, phone, email…). Matching ignores case, accents, whitespace and punctuation
 * ("12.345.678-Z" matches "12345678Z", "MARIA  JOSE" matches "María José") but only whole words
 * ("Ana" never matches inside "Mañana").
 */
import type { Span } from './types';

const WORD = /[\p{L}\p{N}\p{M}]/u;
const ALNUM = /[\p{L}\p{N}]/u;
const MIN_LENGTH = 3;

/**
 * Categorical values that are never identifying on their own but appear in most feedback
 * ("DNI", "España", "soltero"…). Redacting them would destroy the text without protecting anyone.
 */
const GENERIC = new Set(
  (
    'dni nie tie nif cif pasaporte passport documento espana spain espanola espanol spanish ' +
    'hombre mujer masculino femenino varon male female soltero soltera casado casada divorciado ' +
    'divorciada viudo viuda separado separada'
  ).split(' '),
);

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** Lower-case, accent-free letters and digits only (other characters are dropped). */
function fold(value: string): string {
  let out = '';
  for (const ch of value) {
    for (const f of ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()) {
      if (ALNUM.test(f)) out += f;
    }
  }
  return out;
}

/** Folded text plus, for every folded character, its [start, end) in the original text. */
function foldWithMap(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of text) {
    for (const f of ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()) {
      if (ALNUM.test(f)) {
        folded += f;
        starts.push(i);
        ends.push(i + ch.length);
      }
    }
    i += ch.length;
  }
  return { folded, starts, ends };
}

/** Folded search keys for one known value, including common alternative spellings. */
export function knownValueKeys(value: string): string[] {
  const key = fold(value);
  if (key.length < MIN_LENGTH || GENERIC.has(key)) return [];
  const keys = new Set([key]);
  const upper = key.toUpperCase();
  // DNI / NIE without the control letter.
  if (/^\d{8}[A-Z]$/.test(upper) || /^[XYZ]\d{7}[A-Z]$/.test(upper)) keys.add(key.slice(0, -1));
  // Phone with country prefix -> national number.
  const phone = /^(?:00)?34([6789]\d{8})$/.exec(key);
  if (phone) keys.add(phone[1]!);
  // Spanish IBAN -> CCC (20-digit account number).
  if (/^es\d{22}$/.test(key)) keys.add(key.slice(4));
  // Dates -> other common spellings (ISO, dd/mm/yyyy, d/m/yyyy, "d de mes de yyyy").
  const date = parseDate(value.trim());
  if (date) {
    const { d, m, y } = date;
    const dd = String(d).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    for (const k of [
      `${y}${mm}${dd}`,
      `${dd}${mm}${y}`,
      `${d}${m}${y}`,
      `${dd}${m}${y}`,
      `${d}${mm}${y}`,
      `${d}de${MONTHS[m - 1]}de${y}`,
      `${dd}de${MONTHS[m - 1]}de${y}`,
    ]) {
      if (k.length >= MIN_LENGTH) keys.add(k);
    }
  }
  return [...keys];
}

function parseDate(value: string): { d: number; m: number; y: number } | undefined {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/.exec(value);
  if (m) return valid(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  return undefined;
}

const valid = (d: number, m: number, y: number) =>
  d >= 1 && d <= 31 && m >= 1 && m <= 12 ? { d, m, y } : undefined;

/** Finds every whole-word occurrence of the known values in `text`. */
export function detectKnownValues(text: string, values: readonly string[]): Span[] {
  const keys = new Set(values.flatMap((v) => (typeof v === 'string' ? knownValueKeys(v) : [])));
  if (keys.size === 0) return [];
  const { folded, starts, ends } = foldWithMap(text);
  const out: Span[] = [];
  for (const key of keys) {
    for (let k = folded.indexOf(key); k !== -1; k = folded.indexOf(key, k + 1)) {
      const start = starts[k]!;
      let end = ends[k + key.length - 1]!;
      while (/\p{M}/u.test(text[end] ?? '')) end++; // trailing combining marks (NFD input)
      if (WORD.test(text[start - 1] ?? '') || WORD.test(text[end] ?? '')) continue;
      out.push({ type: 'known_value', start, end });
    }
  }
  return out;
}
