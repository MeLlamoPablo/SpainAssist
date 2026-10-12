import { describe, expect, it } from 'vitest';
import {
  CROCKFORD_ALPHABET,
  DEMO_VOUCHER_BODY,
  DEMO_VOUCHER_CODE,
  generateVoucherCode,
  normalizeVoucherCode,
} from '../src/codes';
import { hashVoucherCode, safeEqual } from '../src/crypto';

const CODE_RE = /^SA-[0-9A-HJKMNP-TV-Z]{6}$/;

describe('voucher codes', () => {
  it('generates SA-XXXXXX codes from the Crockford alphabet (30 bits)', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32); // 5 bits per character
    const codes = Array.from({ length: 2000 }, generateVoucherCode);
    for (const code of codes) expect(code).toMatch(CODE_RE);
    // 2000 draws from 2^30: a duplicate is a ~0.2% event, so allow one.
    expect(new Set(codes).size).toBeGreaterThanOrEqual(codes.length - 1);
    // Every symbol shows up: the generator is not stuck on a subset of the alphabet.
    const seen = new Set(codes.map((c) => c.slice(3)).join(''));
    for (const ch of CROCKFORD_ALPHABET) expect(seen.has(ch)).toBe(true);
  });

  it('accepts generated codes (normalization is tested in @sa/shared)', () => {
    const code = generateVoucherCode();
    expect(normalizeVoucherCode(code)).toBe(code.slice(3));
    expect(normalizeVoucherCode(code.toLowerCase())).toBe(code.slice(3));
  });

  it('keeps the public demo code valid', () => {
    expect(DEMO_VOUCHER_BODY).toBe(normalizeVoucherCode(DEMO_VOUCHER_CODE));
    expect(DEMO_VOUCHER_BODY).toBe('DEM042');
  });
});

describe('hashing', () => {
  it('stores voucher codes as a peppered HMAC', () => {
    const body = '7K3Q9X';
    const h1 = hashVoucherCode(body, 'pepper-one-0123456789');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hashVoucherCode(body, 'pepper-one-0123456789')).toBe(h1);
    expect(hashVoucherCode(body, 'pepper-two-0123456789')).not.toBe(h1);
    expect(h1).not.toContain(body.toLowerCase());
  });

  it('compares secrets in constant time', () => {
    expect(safeEqual('same-secret', 'same-secret')).toBe(true);
    expect(safeEqual('same-secret', 'other-secret')).toBe(false);
    expect(safeEqual('short', 'a-much-longer-value')).toBe(false);
  });
});
