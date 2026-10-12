import { describe, expect, it } from 'vitest';
import {
  isLuhn,
  isValidCcc,
  isValidCif,
  isValidDni,
  isValidIban,
  isValidKlmNif,
  isValidNie,
  isValidNuss,
} from '../src/index';

describe('isValidDni', () => {
  it.each([
    '12345678Z',
    '87654321X',
    '45678912S',
    '12.345.678-Z',
    '12 345 678 Z',
    '12345678-z',
    '1234567L',
  ])('accepts %s', (v) => expect(isValidDni(v)).toBe(true));

  it.each(['12345678A', '87654321Z', '1234567', 'ABCDEFGHZ', '123456789Z', ''])('rejects %s', (v) =>
    expect(isValidDni(v)).toBe(false),
  );
});

describe('isValidNie', () => {
  it.each(['X1234567L', 'Y1234567X', 'Z1234567R', 'x-1234567-l', 'X 1234567 L', 'X01234567L'])(
    'accepts %s',
    (v) => expect(isValidNie(v)).toBe(true),
  );
  it.each(['X1234567A', 'W1234567L', '12345678Z', 'X123456L'])('rejects %s', (v) =>
    expect(isValidNie(v)).toBe(false),
  );
});

describe('isValidKlmNif', () => {
  it('uses the DNI letter table on the 7 digits', () => {
    expect(isValidKlmNif('K1234567L')).toBe(true);
    expect(isValidKlmNif('K1234567A')).toBe(false);
  });
});

describe('isValidCif', () => {
  it.each(['B12345674', 'A58818501', 'Q2826000H', 'P2807900B', 'S2800000H', 'B-1234567-4'])(
    'accepts %s',
    (v) => expect(isValidCif(v)).toBe(true),
  );
  it.each([
    'B12345675', // wrong digit
    'B1234567D', // B requires a digit
    'Q28260008', // Q requires a letter
    'I12345674', // invalid organisation letter
  ])('rejects %s', (v) => expect(isValidCif(v)).toBe(false));
});

describe('isValidIban', () => {
  it.each([
    'ES9121000418450200051332',
    'ES91 2100 0418 4502 0005 1332',
    'es91 2100 0418 4502 0005 1332',
    'ES79-2100-0813-6101-2345-6789',
    'DE89370400440532013000',
    'GB82WEST12345698765432',
    'FR1420041010050500013M02606',
    'NL91ABNA0417164300',
    'IT60X0542811101000000123456',
    'PT50000201231234567890154',
  ])('accepts %s', (v) => expect(isValidIban(v)).toBe(true));

  it.each([
    'ES9121000418450200051333', // checksum
    'ES912100041845020005133', // ES length must be 24
    'DE8937040044053201300', // DE length must be 22
    'XX9121000418450200051332', // unknown country
    'ES91',
  ])('rejects %s', (v) => expect(isValidIban(v)).toBe(false));
});

describe('isValidCcc', () => {
  it('validates both control digits', () => {
    expect(isValidCcc('2100 0418 45 0200051332')).toBe(true);
    expect(isValidCcc('2100-0813-61-0123456789')).toBe(true);
    expect(isValidCcc('2100 0418 45 0200051333')).toBe(false);
    expect(isValidCcc('2100 0418 55 0200051332')).toBe(false);
  });
});

describe('isValidNuss', () => {
  it('accepts both checksum variants and separators', () => {
    expect(isValidNuss('281234567840')).toBe(true);
    expect(isValidNuss('28 12345678 40')).toBe(true);
    expect(isValidNuss('28/12345678/40')).toBe(true);
    expect(isValidNuss('081234567869')).toBe(true);
    expect(isValidNuss('461234567843')).toBe(true);
  });
  it('rejects wrong control digits and provinces', () => {
    expect(isValidNuss('281234567841')).toBe(false);
    expect(isValidNuss('801234567840')).toBe(false);
    expect(isValidNuss('2812345678')).toBe(false);
  });
});

describe('isLuhn', () => {
  it.each(['4111111111111111', '4111 1111 1111 1111', '5555555555554444', '378282246310005'])(
    'accepts %s',
    (v) => expect(isLuhn(v)).toBe(true),
  );
  it.each(['4111111111111112', '1234567812345678', '411111111111'])('rejects %s', (v) =>
    expect(isLuhn(v)).toBe(false),
  );
});
