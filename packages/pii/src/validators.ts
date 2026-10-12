/**
 * Checksum validators for Spanish (and international) identifiers. All accept common
 * separators (spaces, dots, dashes, slashes) and are case-insensitive.
 */

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** Removes spaces, dots, dashes and slashes and upper-cases. */
export const compact = (value: string): string => value.replace(/[\s.\-/]/g, '').toUpperCase();

/** DNI: 8 digits (7 accepted, zero-padded) + control letter = TRWAGMYFPDXBNJZSQVHLCKE[n % 23]. */
export function isValidDni(value: string): boolean {
  const m = /^(\d{7,8})([A-Z])$/.exec(compact(value));
  return !!m && DNI_LETTERS[Number(m[1]) % 23] === m[2];
}

/** NIE: X/Y/Z + 7 digits + control letter (X→0, Y→1, Z→2, then the DNI rule). */
export function isValidNie(value: string): boolean {
  // Old NIEs were sometimes written with 8 digits ("X01234567L"): drop the leading zero.
  const m = /^([XYZ])0?(\d{7})([A-Z])$/.exec(compact(value));
  if (!m) return false;
  return DNI_LETTERS[Number(`${'XYZ'.indexOf(m[1]!)}${m[2]}`) % 23] === m[3];
}

/** NIF K/L/M (minors, non-resident Spaniards, foreigners without NIE): letter + 7 digits + letter. */
export function isValidKlmNif(value: string): boolean {
  const m = /^([KLM])(\d{7})([A-Z])$/.exec(compact(value));
  return !!m && DNI_LETTERS[Number(m[2]) % 23] === m[3];
}

/** CIF (NIF of legal entities): letter + 7 digits + control digit or letter. */
export function isValidCif(value: string): boolean {
  const m = /^([ABCDEFGHJNPQRSUVW])(\d{7})([0-9A-J])$/.exec(compact(value));
  if (!m) return false;
  const [, org, body, ctrl] = m as unknown as [string, string, string, string];
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    let d = Number(body[i]);
    if (i % 2 === 0) {
      d *= 2;
      d = Math.floor(d / 10) + (d % 10);
    }
    sum += d;
  }
  const digit = (10 - (sum % 10)) % 10;
  const letter = 'JABCDEFGHI'[digit]!;
  if ('PQRSNW'.includes(org)) return ctrl === letter;
  if ('ABEH'.includes(org)) return ctrl === String(digit);
  return ctrl === letter || ctrl === String(digit);
}

/** IBAN lengths per country (SWIFT IBAN registry), as "CCnn" pairs. */
const IBAN_REGISTRY =
  'AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DJ27 ' +
  'DK18 DO28 EE20 EG29 ES24 FI18 FK18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HN28 HR21 HU28 ' +
  'IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20 LV21 LY25 MC27 MD24 ME22 ' +
  'MK19 MN20 MR27 MT31 MU30 NI28 NL18 NO15 OM23 PK24 PL28 PS29 PT25 QA29 RO24 RS22 RU33 SA24 ' +
  'SC31 SD18 SE24 SI19 SK24 SM27 SO23 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20 YE30';

export const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.fromEntries(
  IBAN_REGISTRY.split(' ').map((e) => [e.slice(0, 2), Number(e.slice(2))]),
);

/** ISO 13616 mod-97 check, plus the registered length for the country. */
export function isValidIban(value: string): boolean {
  const s = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const expected = IBAN_LENGTHS[s.slice(0, 2)];
  if (expected === undefined || s.length !== expected) return false;
  return mod97(s.slice(4) + s.slice(0, 4)) === 1;
}

function mod97(alnum: string): number {
  let rem = 0;
  for (const ch of alnum) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem;
}

/** Spanish CCC (20 digits: entidad 4, oficina 4, DC 2, cuenta 10). */
export function isValidCcc(value: string): boolean {
  const s = value.replace(/[\s-]/g, '');
  if (!/^\d{20}$/.test(s)) return false;
  const w = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6];
  const dc = (digits: string): number => {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += Number(digits[i]) * w[i]!;
    const r = 11 - (sum % 11);
    return r === 11 ? 0 : r === 10 ? 1 : r;
  };
  return dc(`00${s.slice(0, 8)}`) === Number(s[8]) && dc(s.slice(10)) === Number(s[9]);
}

/**
 * NUSS / NAF (Social Security number): 12 digits `PP NNNNNNNN CC`, province 01-66 (plus 97-99
 * for special registrations); CC = (N < 10^7 ? PP·10^7 + N : PP·10^8 + N) mod 97, or the plain
 * concatenation mod 97 used by some generators. No official spec was found; both are accepted.
 */
export function isValidNuss(value: string): boolean {
  const m = /^(\d{2})(\d{8})(\d{2})$/.exec(value.replace(/[\s.\-/]/g, ''));
  if (!m) return false;
  const prov = Number(m[1]);
  const num = Number(m[2]);
  const cc = Number(m[3]);
  if (prov < 1 || (prov > 66 && prov < 97)) return false;
  const a = num < 10_000_000 ? prov * 10_000_000 + num : prov * 100_000_000 + num;
  const b = Number(`${m[1]}${m[2]}`);
  return a % 97 === cc || b % 97 === cc;
}

/** Luhn check for payment card numbers (13-19 digits). */
export function isLuhn(value: string): boolean {
  const s = value.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(s)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
