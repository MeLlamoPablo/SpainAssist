import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PersonalDataItem, personalFieldDef } from '@sa/shared';
import { createTestKeyProvider, Vault } from '@sa/vault';
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_DOCUMENT_FIELDS,
  type IdentityDocumentType,
  identityDocumentPersonalInputs,
  licenceIdentityNumber,
  SCANNABLE_PERSONAL_KEYS,
} from './identity-documents';
import { scanFieldKeys } from './scanner';

const CATEGORIES = JSON.stringify([
  { category: 'B', issueDate: '2010-01-01', expiry: '2030-01-01' },
]);

/** Synthetic values in the shape the scanner returns for each field, valid for its rules. */
function scannedValue(key: string, type: IdentityDocumentType): string {
  if (key === 'drivingCategories') return CATEGORIES;
  if (/Expiry/.test(key)) return '2030-01-01';
  if (/Date/.test(key)) return '2020-01-01';
  const option = personalFieldDef(key)?.options?.[0];
  if (option) return option.value;
  // In A Coruña, the first province option.
  if (key === 'addressPostalCode') return '15001';
  if (key === 'documentNumber')
    return {
      DNI: '12345678Z',
      TIE: 'X1234567L',
      PASSPORT: 'TEST1234',
      DRIVING_LICENCE: '12345678Z',
    }[type];
  if (key === 'documentSupportNumber') return type === 'TIE' ? 'E12345678' : 'CAA000000';
  if (key === 'dniAccessNumber') return '123456';
  return 'TEST';
}

describe('identity document storage', () => {
  it('keeps licence fields separate and drops fields its document cannot provide', () => {
    expect(
      identityDocumentPersonalInputs([
        { key: 'documentType', value: 'DRIVING_LICENCE' },
        { key: 'givenName', value: 'Carmen' },
        { key: 'documentNumber', value: 'TEST-LICENCE' },
        { key: 'documentExpiry', value: '2030-01-01' },
        { key: 'drivingCategories', value: CATEGORIES },
        { key: 'nationality', value: 'ESP' },
        { key: 'documentSupportNumber', value: 'INVALID' },
      ]),
    ).toEqual([
      { key: 'givenName', value: 'Carmen' },
      { key: 'drivingLicenceExpiry', value: '2030-01-01' },
      { key: 'drivingLicenceCategories', value: CATEGORIES },
    ]);
  });

  it.each([
    ['DNI', 'dni'],
    ['TIE', 'tie'],
    ['PASSPORT', 'passport'],
  ])('keeps %s fields in their own document namespace', (type, group) => {
    expect(
      identityDocumentPersonalInputs([
        { key: 'documentType', value: type },
        { key: 'documentNumber', value: 'TEST' },
        { key: 'documentIssueDate', value: '2020-01-01' },
      ]),
    ).toEqual([
      { key: `${group}Number`, value: 'TEST' },
      { key: `${group}IssueDate`, value: '2020-01-01' },
    ]);
  });
  it('keeps the issuing authority only for passports and driving licences', () => {
    const authority = (type: string) =>
      identityDocumentPersonalInputs([
        { key: 'documentType', value: type },
        { key: 'documentIssuingAuthority', value: 'TEST' },
      ]);
    expect(authority('PASSPORT')).toEqual([{ key: 'passportIssuingAuthority', value: 'TEST' }]);
    expect(authority('DNI')).toEqual([]);
    expect(authority('TIE')).toEqual([]);
    expect(authority('DRIVING_LICENCE')).toEqual([
      { key: 'drivingLicenceIssuingAuthority', value: 'TEST' },
    ]);
  });

  it('stores every scanned field under a standard key', () => {
    for (const key of SCANNABLE_PERSONAL_KEYS) expect(personalFieldDef(key), key).toBeDefined();
  });

  it('keeps the postal code the scanner looked up for a DNI address', () => {
    expect(
      identityDocumentPersonalInputs([
        { key: 'documentType', value: 'DNI' },
        { key: 'addressStreet', value: 'Calle Ejemplo 26' },
        { key: 'addressPostalCode', value: '15001' },
      ]),
    ).toEqual([
      { key: 'addressStreet', value: 'Calle Ejemplo 26' },
      { key: 'addressPostalCode', value: '15001' },
    ]);
  });

  it('keeps the DNI CAN for the phone, and only from a DNI', () => {
    const can = (type: string) =>
      identityDocumentPersonalInputs([
        { key: 'documentType', value: type },
        { key: 'dniAccessNumber', value: '123456' },
      ]);
    expect(can('DNI')).toEqual([{ key: 'dniAccessNumber', value: '123456' }]);
    expect(can('TIE')).toEqual([]);
    expect(can('PASSPORT')).toEqual([]);
  });

  it.each(Object.keys(IDENTITY_DOCUMENT_FIELDS) as IdentityDocumentType[])(
    'saves a complete %s scan into an empty vault',
    async (type) => {
      const dir = await mkdtemp(join(tmpdir(), 'sa-scan-'));
      try {
        const vault = await Vault.open(join(dir, 'vault'), createTestKeyProvider('scan'));
        const items = identityDocumentPersonalInputs([
          { key: 'documentType', value: type },
          ...scanFieldKeys(type).map((key) => ({ key, value: scannedValue(key, type) })),
        ]);
        const saved = await vault.setPersonal(items, 'scan');
        expect(saved.map((item) => item.key).sort()).toEqual(
          [...IDENTITY_DOCUMENT_FIELDS[type]].sort(),
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('does not promise unrelated personal data', () => {
    for (const key of ['email', 'phone', 'iban', 'nuss', 'maritalStatus'])
      expect(SCANNABLE_PERSONAL_KEYS.has(key)).toBe(false);
    expect(() =>
      identityDocumentPersonalInputs([{ key: 'documentType', value: 'OTHER' }]),
    ).toThrow();
  });
});

describe('licence number as DNI/NIE', () => {
  const scan = (type: string, number: string) => [
    { key: 'documentType', value: type },
    { key: 'documentNumber', value: number },
  ];
  const savedItem = (key: string): PersonalDataItem => ({
    key,
    label: key,
    value: 'TEST',
    source: 'manual',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('keeps a DNI-shaped licence number as the DNI number', () => {
    expect(licenceIdentityNumber(scan('DRIVING_LICENCE', '12345678-Z'), [])).toEqual([
      { key: 'dniNumber', value: '12345678Z' },
    ]);
  });

  it('keeps a NIE-shaped licence number as the NIE', () => {
    expect(licenceIdentityNumber(scan('DRIVING_LICENCE', 'x1234567l'), [])).toEqual([
      { key: 'tieNumber', value: 'X1234567L' },
    ]);
  });

  it('never replaces a saved DNI/NIE, nor guesses while the vault is unknown', () => {
    const licence = scan('DRIVING_LICENCE', '12345678Z');
    expect(licenceIdentityNumber(licence, [savedItem('dniNumber')])).toEqual([]);
    expect(licenceIdentityNumber(licence, [savedItem('tieNumber')])).toEqual([]);
    expect(licenceIdentityNumber(licence, undefined)).toEqual([]);
  });

  it('ignores other documents and numbers that are not a DNI/NIE', () => {
    expect(licenceIdentityNumber(scan('PASSPORT', '12345678Z'), [])).toEqual([]);
    expect(licenceIdentityNumber(scan('DRIVING_LICENCE', 'AB123456'), [])).toEqual([]);
  });
});
