import { randomBytes } from 'node:crypto';
import {
  CROCKFORD_ALPHABET,
  formatVoucherCode,
  normalizeVoucherCode,
  VOUCHER_BODY_LENGTH,
} from '@sa/shared';

// Format, alphabet and normalization live in `@sa/shared` (voucher-code.ts), shared with the app.
export { CROCKFORD_ALPHABET, formatVoucherCode, normalizeVoucherCode, VOUCHER_BODY_LENGTH };

/** Public demo code seeded when DEV_SEED=1 (mock provider only). */
export const DEMO_VOUCHER_CODE = 'SA-DEMO42';

/** New random voucher code, `SA-` + 6 characters (30 bits of entropy from the CSPRNG). */
export function generateVoucherCode(): string {
  // 256 is a multiple of 32, so `byte & 31` is uniform.
  const body = Array.from(randomBytes(VOUCHER_BODY_LENGTH), (b) => CROCKFORD_ALPHABET[b & 31]).join(
    '',
  );
  return formatVoucherCode(body);
}

/** Canonical body of the demo code. */
export const DEMO_VOUCHER_BODY = normalizeVoucherCode(DEMO_VOUCHER_CODE) as string;
