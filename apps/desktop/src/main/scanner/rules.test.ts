import { describe, expect, it } from 'vitest';
import { isDniValidity, misreadCorrection, misreadFields } from './rules';

/** A DNI issued on `issue` to someone born on `birth`, valid until `expiry`. */
const dni = (birth: string, issue: string, expiry: string) =>
  isDniValidity(birth, issue, expiry, false);
const permanentDni = (birth: string, issue: string) => isDniValidity(birth, issue, undefined, true);

describe('DNI validity by age at issue', () => {
  it('lasts 2 years under 5, 5 years from 5 to 29 and 10 years from 30 to 69', () => {
    expect(dni('2022-03-10', '2024-03-01', '2026-03-01')).toBe(true);
    expect(dni('2010-03-10', '2024-03-01', '2029-03-01')).toBe(true);
    expect(dni('1990-03-10', '2024-03-01', '2034-03-01')).toBe(true);
    // Turning 30 the day after the issue date still gives five years.
    expect(dni('1994-03-02', '2024-03-01', '2029-03-01')).toBe(true);
  });

  it('rejects a validity that does not match the age band', () => {
    expect(dni('2010-03-10', '2024-03-01', '2034-03-01')).toBe(false);
    expect(dni('1990-03-10', '2024-03-01', '2029-03-01')).toBe(false);
    expect(dni('1990-03-10', '2024-03-01', '2031-03-01')).toBe(false);
  });

  it('tolerates a printed expiry a few days off the anniversary, and the one-year exception', () => {
    expect(dni('1990-03-10', '2024-03-01', '2034-03-20')).toBe(true);
    expect(dni('1990-03-10', '2024-03-01', '2025-03-01')).toBe(true);
  });

  it('is permanent from 70 before RD 255/2025, and dated more than ten years after it', () => {
    expect(permanentDni('1940-03-10', '2015-03-01')).toBe(true);
    expect(dni('1940-03-10', '2015-03-01', '2025-03-01')).toBe(false);
    expect(permanentDni('1950-03-10', '2025-06-01')).toBe(false);
    expect(dni('1950-03-10', '2025-06-01', '2040-06-01')).toBe(true);
    expect(dni('1950-03-10', '2025-06-01', '2030-06-01')).toBe(false);
  });

  it('allows permanent from 30 (severe disability) but never under 30', () => {
    expect(permanentDni('1980-03-10', '2015-03-01')).toBe(true);
    expect(permanentDni('1990-03-10', '2015-03-01')).toBe(false);
  });

  it('does not check documents issued under the rules before RD 1553/2005', () => {
    expect(dni('1960-03-10', '2001-03-01', '2003-03-01')).toBe(true);
  });
});

describe('misread scanned fields', () => {
  const dniFields = {
    documentType: 'DNI',
    documentNumber: '12345678Z',
    birthDate: '1990-03-10',
    documentIssueDate: '2024-03-01',
    documentExpiry: '2034-03-01',
  };

  it('accepts consistent fields', () => {
    expect(misreadFields(dniFields)).toEqual([]);
  });

  it('names fields with an invalid value before fields that contradict each other', () => {
    expect(
      misreadFields({ ...dniFields, documentNumber: '12345678A', documentExpiry: '2031-03-01' }),
    ).toEqual(['documentNumber']);
  });

  it('checks field rules before the document type is known only for personal fields', () => {
    expect(misreadFields({ documentNumber: '12345678A', birthDate: '2999-01-01' })).toEqual([
      'birthDate',
    ]);
  });

  it('requires birth < issue < expiry', () => {
    expect(misreadFields({ ...dniFields, birthDate: '2024-06-01' })).toEqual([
      'birthDate',
      'documentIssueDate',
    ]);
    expect(misreadFields({ ...dniFields, documentExpiry: '2020-03-01' })).toEqual([
      'documentIssueDate',
      'documentExpiry',
    ]);
  });

  it('requires a postal code in the province read with it', () => {
    const tie = { documentType: 'TIE', addressPostalCode: '28013', addressProvince: 'Madrid' };
    expect(misreadFields(tie)).toEqual([]);
    expect(misreadFields({ ...tie, addressProvince: 'Barcelona' })).toEqual([
      'addressPostalCode',
      'addressProvince',
    ]);
  });

  it('refuses a permanent DNI issued under RD 255/2025', () => {
    const { documentExpiry: _expiry, ...permanent } = dniFields;
    expect(misreadFields({ ...permanent, documentIssueDate: '2025-06-01' }, true)).toEqual([
      'birthDate',
      'documentIssueDate',
    ]);
  });

  it('builds a correction request that names fields only', () => {
    expect(misreadCorrection(['documentNumber'])).toContain('read documentNumber again');
  });
});
