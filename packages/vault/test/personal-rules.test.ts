import { assert, describe, expect, it } from 'vitest';
import {
  checkPersonalChanges,
  normalizePersonalInput,
  type PersonalChange,
  PersonalDataValidationError,
} from '../src/personal';

/** The fixed reason the vault gives for refusing a value, or undefined when it accepts it. */
function rejection(key: string, value: string): string | undefined {
  try {
    normalizePersonalInput({ key, value }, undefined);
    return undefined;
  } catch (error) {
    assert(error instanceof PersonalDataValidationError, 'expected a validation error');
    expect(error.message, 'errors never echo the value').not.toContain(value);
    return error.reason;
  }
}

function expectRule(key: string, reason: string, valid: string[], invalid: string[]) {
  for (const value of valid) expect(rejection(key, value), value).toBeUndefined();
  for (const value of invalid) expect(rejection(key, value), value).toBe(reason);
}

function crossFieldRejection(changes: Record<string, string>): string | undefined {
  const list: PersonalChange[] = Object.entries(changes).map(([key, value]) => ({ key, value }));
  try {
    checkPersonalChanges(list);
    return undefined;
  } catch (error) {
    assert(error instanceof PersonalDataValidationError, 'expected a validation error');
    return `${error.key}: ${error.reason}`;
  }
}

describe('personal field rules', () => {
  it('checks the DNI letter', () => {
    expectRule('dniNumber', 'invalid_check_digit', ['12345678Z', '12.345.678-z'], ['12345678A']);
  });

  it('checks the NIE letter of a TIE', () => {
    expectRule('tieNumber', 'invalid_check_digit', ['X1234567L'], ['X1234567A', '12345678Z']);
  });

  it('checks the format of DNI and TIE support numbers', () => {
    expectRule(
      'dniSupportNumber',
      'invalid_document_number',
      ['CAA000000'],
      ['CAA00000', 'C12345678'],
    );
    expectRule(
      'tieSupportNumber',
      'invalid_document_number',
      ['E12345678'],
      ['E1234567', 'C12345678'],
    );
  });

  it('keeps the DNI CAN as its six digits', () => {
    expectRule(
      'dniAccessNumber',
      'invalid_can',
      ['123456', '012345'],
      ['12345', '1234567', 'A23456'],
    );
    expect(
      normalizePersonalInput({ key: 'dniAccessNumber', value: '123 456' }, undefined).value,
    ).toBe('123456');
    // A TIE CAN is not kept: the phone app only reads DNIe cards.
    expect(rejection('tieAccessNumber', '123456')).toBe('unknown_field');
  });

  it('checks the IBAN (mod 97 and country length)', () => {
    expectRule(
      'iban',
      'invalid_iban',
      ['ES91 2100 0418 4502 0005 1332'],
      ['ES00 2100 0418 4502 0005 1332', 'ES91 2100 0418 4502 0005 133'],
    );
  });

  it('checks the Social Security number (NUSS) control digits', () => {
    expectRule('nuss', 'invalid_nuss', ['28 12345678 40', '281234567840'], ['281234567841']);
  });

  it('requires a Spanish postal code with a province prefix', () => {
    expectRule('addressPostalCode', 'invalid_postal_code', ['28013', '01001'], ['53001', '2801']);
  });

  it('requires nine Spanish digits for national and +34 mobile numbers', () => {
    expectRule(
      'phone',
      'invalid_phone',
      ['612345678', '+34 612 345 678', '0034612345678', '+44 20 7946 0958'],
      ['512345678', '61234567', '+34 61234567', '12'],
    );
  });

  it('refuses birth and issue dates in the future, and implausibly old births', () => {
    expectRule('birthDate', 'future_date', ['1990-01-15'], ['2999-01-01']);
    expect(rejection('birthDate', '1899-12-31')).toBe('implausible_date');
    expectRule('dniIssueDate', 'future_date', ['2021-09-24'], ['2999-01-01']);
    // A permanent DNI is saved with a far expiry date.
    expect(rejection('dniExpiry', '9999-01-01')).toBeUndefined();
  });

  it('checks driving licence categories and their dates', () => {
    const rows = (...list: object[]) => JSON.stringify(list);
    expectRule(
      'drivingLicenceCategories',
      'invalid_licence_categories',
      [rows({ category: 'B', issueDate: '2010-05-04', expiry: '2040-05-04' }, { category: 'b+e' })],
      [
        rows({ category: 'Z' }),
        rows({ category: 'B', issueDate: '2999-01-01' }),
        rows({ category: 'B', issueDate: '2012-02-30' }),
      ],
    );
  });
});

describe('personal cross-field rules', () => {
  it('requires a postal code saved with a province to belong to it', () => {
    const madrid = { addressPostalCode: '28013', addressProvince: 'Madrid' };
    expect(crossFieldRejection(madrid)).toBeUndefined();
    expect(crossFieldRejection({ ...madrid, addressProvince: 'Barcelona' })).toBe(
      'addressPostalCode: postal_code_province_mismatch',
    );
    // Saved alone, a new postal code is not compared with the stored province.
    expect(crossFieldRejection({ addressPostalCode: '08001' })).toBeUndefined();
  });
});
