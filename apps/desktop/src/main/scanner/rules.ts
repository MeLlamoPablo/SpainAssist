/**
 * Validity rules for scanned fields. A failing rule means the model misread a value, so the scan
 * agent must read the named fields again instead of saving them. Results name fields, never values.
 */
import { documentPersonalInputs, postalCodeProvince } from '@sa/shared';
import {
  compactId,
  isSpanishId,
  normalizePersonalInput,
  PersonalDataValidationError,
} from '@sa/vault';
import { type DocumentFields, SCAN_PERSONAL_KEYS } from '../../scanner';

const DAY = 86_400_000;
/** RD 1553/2005 (DNI) came into force on 25 December 2005; earlier rules are not checked. */
const RD_1553_2005 = '2005-12-25';
/** RD 255/2025 (DNI) replaced it on 2 April 2025. */
const RD_255_2025 = '2025-04-02';

function time(date: string, addYears = 0): number {
  return Date.UTC(
    Number(date.slice(0, 4)) + addYears,
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
}

function ageAt(birth: string, date: string): number {
  const years = Number(date.slice(0, 4)) - Number(birth.slice(0, 4));
  return date.slice(5) < birth.slice(5) ? years - 1 : years;
}

/** Printed expiry dates can be a few days off the exact anniversary. */
function lastsYears(issue: string, expiry: string, years: number): boolean {
  return Math.abs(time(expiry) - time(issue, years)) <= 31 * DAY;
}

/**
 * Whether a DNI's validity matches the holder's age when it was issued. Validity counts from the
 * issue date (RD 1553/2005 art. 6.1, RD 255/2025 art. 7.1): under 5 → 2 years, 5–29 → 5 years,
 * 30–69 → 10 years. From 70 it was permanent until RD 255/2025, which prints a date more than ten
 * years away instead. Exceptions: one year (RD 1553/2005 art. 6.2.b) and permanent from 30 for a
 * severe disability (art. 6.2.a). Documents keep the rules in force when they were issued.
 */
export function isDniValidity(
  birth: string,
  issue: string,
  expiry: string | undefined,
  permanent: boolean,
): boolean {
  if (issue < RD_1553_2005) return true;
  const age = ageAt(birth, issue);
  const rd2025 = issue >= RD_255_2025;
  if (permanent) return !rd2025 && age >= 30;
  if (!expiry || lastsYears(issue, expiry, 1)) return true;
  if (age >= 70) return rd2025 && time(expiry) > time(issue, 10) - 31 * DAY;
  return lastsYears(issue, expiry, age < 5 ? 2 : age < 30 ? 5 : 10);
}

/** Fields whose value breaks a vault field rule (check letter, check digits, format, date). */
function fieldRuleFailures(fields: DocumentFields): string[] {
  // A Spanish licence number is its holder's DNI/NIE. The vault doesn't keep it, so check it here.
  const { documentType, documentNumber } = fields;
  if (
    documentType === 'DRIVING_LICENCE' &&
    documentNumber &&
    !isSpanishId(compactId(documentNumber))
  )
    return ['documentNumber'];
  // Document fields map to vault keys only once the document type is known. Licence categories
  // are already checked by the extraction schema (`LicenceCategories`).
  const personal = new Set<string>(SCAN_PERSONAL_KEYS);
  const items = Object.entries(fields).flatMap(([key, value]) =>
    typeof value === 'string' && value && (documentType || personal.has(key))
      ? [{ key, value, scanKey: key }]
      : [],
  );
  return documentPersonalInputs(items).flatMap((item) => {
    try {
      normalizePersonalInput(item, undefined);
      return [];
    } catch (error) {
      if (error instanceof PersonalDataValidationError) return [item.scanKey];
      throw error;
    }
  });
}

/** Fields that contradict each other on one document. */
function documentRuleFailures(fields: DocumentFields, permanent: boolean): string[] {
  const { birthDate: birth, documentIssueDate: issue, documentExpiry: expiry } = fields;
  if (birth && issue && birth >= issue) return ['birthDate', 'documentIssueDate'];
  if (birth && expiry && birth >= expiry) return ['birthDate', 'documentExpiry'];
  if (issue && expiry && issue >= expiry) return ['documentIssueDate', 'documentExpiry'];
  const { addressPostalCode: postalCode, addressProvince: province } = fields;
  if (postalCode && province && postalCodeProvince(postalCode)?.value !== province)
    return ['addressPostalCode', 'addressProvince'];
  if (
    fields.documentType === 'DNI' &&
    birth &&
    issue &&
    !isDniValidity(birth, issue, permanent ? undefined : expiry, permanent)
  )
    return ['birthDate', 'documentIssueDate', ...(permanent ? [] : ['documentExpiry'])];
  return [];
}

/** Fields to read again: first those with an invalid value, then those that contradict. */
export function misreadFields(fields: DocumentFields, permanent = false): string[] {
  const invalid = fieldRuleFailures(fields);
  return invalid.length ? invalid : documentRuleFailures(fields, permanent);
}

/** The correction request for the scan agent. It names fields only, never values. */
export function misreadCorrection(keys: string[]): string {
  const names = keys.join(', ');
  return `${names} failed a validity check (${keys.length > 1 ? 'these values contradict each other' : 'check letter, digits, format or date'}), so the read is wrong. Do not guess or fix it yourself. Call capture_images with success false and a short reason asking the user to bring the document closer so you can read ${names} again, then record ${keys.length > 1 ? 'them' : 'it'} from the new frame.`;
}
