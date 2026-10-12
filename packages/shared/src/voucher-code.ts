/**
 * Voucher codes look like `SA-7K3Q9X`: a fixed prefix plus 6 Crockford base32 characters
 * (6 × 5 = 30 random bits). Crockford's alphabet has no I, L, O or U, so codes are easy to read
 * aloud and type; on input I/L are read as 1 and O as 0, case and separators are ignored, and
 * the prefix is optional. Shared by the key server (validation) and the app (input mask).
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const VOUCHER_PREFIX = 'SA';
export const VOUCHER_BODY_LENGTH = 6;

const BODY_RE = /^[0-9A-HJKMNP-TV-Z]{6}$/;
// Whitespace plus ASCII and typographic dashes (codes get pasted from emails and chats).
const SEPARATORS_RE = /[\s\-‐-―−]/g;
// What the input mask keeps: the alphabet plus I, L and O, which the server reads as 1, 1 and 0.
const NOT_TYPABLE_RE = /[^0-9A-TV-Z]/g;

/** `SA-` + body, e.g. `SA-7K3Q9X`. */
export function formatVoucherCode(body: string): string {
  return `${VOUCHER_PREFIX}-${body}`;
}

/**
 * Canonical 6-character body of a user-typed code, or null if it cannot be a voucher code.
 * Accepts "sa-7k3q9x", "SA 7K3Q9X", "7K3Q9X", "SA–7K3Q9X", "7K3QIX" (I→1)…
 */
export function normalizeVoucherCode(input: string): string | null {
  let s = input.normalize('NFKC').toUpperCase().replace(SEPARATORS_RE, '');
  s = s.replace(/[IL]/g, '1').replace(/O/g, '0');
  if (s.length === VOUCHER_BODY_LENGTH + VOUCHER_PREFIX.length && s.startsWith(VOUCHER_PREFIX)) {
    s = s.slice(VOUCHER_PREFIX.length);
  }
  return BODY_RE.test(s) ? s : null;
}

/**
 * Input mask for the part after the fixed `SA-`: uppercases, drops characters that can't be in
 * a code and keeps at most 6. A whole pasted or typed code ("sa-7k3q9x", "SA 7K3Q9X") loses
 * its prefix.
 * I, L and O are kept as typed (the server reads them as 1, 1 and 0).
 */
export function maskVoucherBody(input: string): string {
  const s = input.normalize('NFKC').toUpperCase().replace(NOT_TYPABLE_RE, '');
  const withoutPrefix =
    // More than 6 characters starting with SA: a pasted code, or the person typed the prefix
    // out of habit ("SA7K3Q" + "9" becomes "7K3Q9"). Either way the SA is the prefix.
    s.length > VOUCHER_BODY_LENGTH && s.startsWith(VOUCHER_PREFIX)
      ? s.slice(VOUCHER_PREFIX.length)
      : s;
  return withoutPrefix.slice(0, VOUCHER_BODY_LENGTH);
}
