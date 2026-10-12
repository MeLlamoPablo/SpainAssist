import { documentPersonalInputs, type PersonalDataInput, type PersonalDataItem } from '@sa/shared';

/** Printable text fields, not chip data, portraits, signatures or inferred values.
 * Availability varies by document version; see docs/research/identity-document-fields.md.
 */
export const IDENTITY_DOCUMENT_FIELDS = {
  DNI: [
    'givenName',
    'surname1',
    'surname2',
    'birthDate',
    'sex',
    'nationality',
    'birthPlace',
    'fatherName',
    'motherName',
    'addressStreet',
    'addressMunicipality',
    'addressProvince',
    'addressCountry',
    'dniNumber',
    'dniSupportNumber',
    'dniIssueDate',
    'dniExpiry',
    'dniIssuingTeam',
    'dniAccessNumber',
  ],
  TIE: [
    'givenName',
    'surname1',
    'surname2',
    'birthDate',
    'sex',
    'nationality',
    'birthPlace',
    'addressStreet',
    'addressPostalCode',
    'addressMunicipality',
    'addressProvince',
    'addressCountry',
    'tieNumber',
    'tieSupportNumber',
    'tieIssueDate',
    'tieExpiry',
    'tiePermitType',
    'tieRemarks',
  ],
  PASSPORT: [
    'givenName',
    'surname1',
    'surname2',
    'birthDate',
    'sex',
    'nationality',
    'birthPlace',
    'passportNumber',
    'passportIssueDate',
    'passportExpiry',
    'passportIssuingAuthority',
    'passportPersonalNumber',
  ],
  DRIVING_LICENCE: [
    'givenName',
    'surname1',
    'surname2',
    'birthDate',
    'birthPlace',
    'drivingLicenceIssueDate',
    'drivingLicenceExpiry',
    'drivingLicenceIssuingAuthority',
    'drivingLicenceCategories',
    'drivingLicenceRemarks',
  ],
} as const;

export type IdentityDocumentType = keyof typeof IDENTITY_DOCUMENT_FIELDS;
export const SCANNABLE_PERSONAL_KEYS: ReadonlySet<string> = new Set(
  Object.values(IDENTITY_DOCUMENT_FIELDS).flat(),
);

/** Map one scan to the keys its document keeps, dropping fields it cannot provide. */
export function identityDocumentPersonalInputs(items: PersonalDataInput[]): PersonalDataInput[] {
  const type = items.find((item) => item.key === 'documentType')?.value;
  if (!type || !Object.hasOwn(IDENTITY_DOCUMENT_FIELDS, type))
    throw new Error('Invalid document type');
  const allowed: ReadonlySet<string> = new Set([
    ...IDENTITY_DOCUMENT_FIELDS[type as IdentityDocumentType],
    // A DNI does not print it, but the scanner looks it up from the printed address.
    'addressPostalCode',
  ]);
  return documentPersonalInputs(items).filter((item) => allowed.has(item.key));
}

/**
 * A Spanish driving licence number is its holder's DNI, or NIE for foreign residents. Keep it as
 * the DNI/NIE only while neither is saved: an older licence can still show a replaced NIE.
 */
export function licenceIdentityNumber(
  items: PersonalDataInput[],
  saved: readonly PersonalDataItem[] | undefined,
): PersonalDataInput[] {
  if (items.find((item) => item.key === 'documentType')?.value !== 'DRIVING_LICENCE') return [];
  if (!saved || saved.some((item) => item.key === 'dniNumber' || item.key === 'tieNumber'))
    return [];
  const number = items
    .find((item) => item.key === 'documentNumber')
    ?.value.toUpperCase()
    .replace(/[\s.-]/g, '');
  if (number && /^[XYZ]\d{7}[A-Z]$/.test(number)) return [{ key: 'tieNumber', value: number }];
  if (number && /^\d{8}[A-Z]$/.test(number)) return [{ key: 'dniNumber', value: number }];
  return [];
}
