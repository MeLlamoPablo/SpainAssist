import { describe, expect, it } from 'vitest';
import { formatVoucherCode, maskVoucherBody, normalizeVoucherCode } from '../src/voucher-code';

describe('normalizeVoucherCode', () => {
  it('normalizes case, separators, prefix and ambiguous letters', () => {
    for (const input of [
      'SA-7K3Q9X',
      'sa-7k3q9x',
      ' SA 7K3Q9X ',
      'SA–7K3Q9X', // en dash pasted from an email
      '7K3Q9X', // without prefix
      '7K3-Q9X',
      'ＳＡ-7K3Q9X', // full-width letters
      'SA7K3Q9X',
    ]) {
      expect(normalizeVoucherCode(input), input).toBe('7K3Q9X');
    }
    expect(normalizeVoucherCode('SA-7KIQLX')).toBe('7K1Q1X'); // I and L read as 1
    expect(normalizeVoucherCode('SA-DEMO42')).toBe('DEM042'); // O read as 0
    expect(normalizeVoucherCode('SAK3Q9')).toBe('SAK3Q9'); // a body may start with SA
  });

  it('rejects inputs that cannot be voucher codes', () => {
    for (const input of [
      '',
      'SA',
      'SA-7K3Q9',
      'SA-7K3Q9XX',
      'SA-7KQ2-M9XD-4T1R', // the old 12-character format
      'SA-7K3Q9U', // U is not in the alphabet
      'SA-7K3Q9*',
      'XX-7K3Q9X',
    ]) {
      expect(normalizeVoucherCode(input), input).toBeNull();
    }
  });

  it('formats a body with the prefix', () => {
    expect(formatVoucherCode('7K3Q9X')).toBe('SA-7K3Q9X');
  });
});

describe('maskVoucherBody', () => {
  it('uppercases, drops invalid characters and keeps at most 6', () => {
    expect(maskVoucherBody('7k3')).toBe('7K3');
    expect(maskVoucherBody('7k-3 q*9xu')).toBe('7K3Q9X');
    expect(maskVoucherBody('7K3Q9XZZ')).toBe('7K3Q9X');
    expect(maskVoucherBody('demo42')).toBe('DEMO42'); // I, L, O stay as typed
  });

  it('strips the prefix of a whole pasted code', () => {
    expect(maskVoucherBody('sa-7k3q9x')).toBe('7K3Q9X');
    expect(maskVoucherBody('SA 7K3Q9X')).toBe('7K3Q9X');
    expect(maskVoucherBody(' SA–7K3Q9X\n')).toBe('7K3Q9X');
  });

  it('drops a typed prefix once the code no longer fits in 6 characters', () => {
    let value = '';
    for (const ch of 'sa-7k3q9x') value = maskVoucherBody(value + ch);
    expect(value).toBe('7K3Q9X');
  });

  it('keeps a 6-character body that starts with SA', () => {
    expect(maskVoucherBody('SA')).toBe('SA');
    expect(maskVoucherBody('SAK3Q9')).toBe('SAK3Q9');
  });
});
