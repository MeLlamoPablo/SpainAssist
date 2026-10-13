/** Validation and normalization of personal data entries. */
import { isValidIban, isValidNuss } from '@sa/pii';
import {
  DniAccessNumber,
  LicenceCategories,
  matchPersonalOption,
  PERSONAL_FIELDS,
  type PersonalDataItem,
  PersonalFieldKey,
  personalFieldDef,
  postalCodeProvince,
} from '@sa/shared';
import { VaultError } from './errors';
import { compactId, isDni, isNie } from './ids';
import type { PersonalEntry } from './state';

export interface PersonalChange {
  key: string;
  /** `null` deletes the entry (an empty value means "clear this field"). */
  value: string | null;
  /** Custom keys only. */
  label?: string;
}

const MAX_VALUE_LENGTH = 2000;
const MAX_LABEL_LENGTH = 160;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Safe diagnostic metadata: fixed reasons and catalog field names, never input values. */
export class PersonalDataValidationError extends VaultError {
  /** Loggable field name: custom keys collapse to "custom" (their slugs may be personal). */
  readonly field: string | undefined;
  constructor(
    message: string,
    readonly reason: string,
    /** The rejected key as given, so callers can drop or report it. Log `field` instead. */
    readonly key?: string,
  ) {
    super('invalid_input', message);
    this.field = key?.startsWith('custom.')
      ? 'custom'
      : (personalFieldDef(key ?? '')?.key ?? (key === 'passportSupportNumber' ? key : undefined));
  }
}

function invalid(message: string, reason: string, key?: string): VaultError {
  return new PersonalDataValidationError(message, reason, key);
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Dates that must be in the past: one day of slack covers time zones. */
function isPastDate(value: string): boolean {
  return value <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

/** Printed number rules per document field, after `compactId`. */
const DOCUMENT_NUMBER_RULES: Record<string, (value: string) => boolean> = {
  dniNumber: isDni,
  tieNumber: isNie,
  // The DNI support number (IDESP): three letters and six digits, e.g. "CAA000000".
  dniSupportNumber: (value) => /^[A-Z]{3}[0-9]{6}$/.test(value),
  // The TIE support number: "E" and eight digits.
  tieSupportNumber: (value) => /^E[0-9]{8}$/.test(value),
};

/** Mobile phone: international with "+"/"00", otherwise (or "+34") nine Spanish digits. */
function isPhone(value: string): boolean {
  const compact = value.replace(/[\s().-]/g, '');
  const digits = compact.replace(/\D/g, '').length;
  if (!/^\+?[\d\s().-]+$/.test(value) || digits < 6 || digits > 15) return false;
  const spanish = /^(\+|00)34/.test(compact) || !/^(\+|00)/.test(compact);
  return !spanish || /^[6-9][0-9]{8}$/.test(compact.replace(/^(\+|00)34/, ''));
}

/** Validates one input against the field definitions. Never echoes values in errors. */
export function normalizePersonalInput(
  input: { key: unknown; value: unknown; label?: unknown },
  existing: PersonalEntry | undefined,
): PersonalChange {
  if (typeof input.key !== 'string' || !PersonalFieldKey.safeParse(input.key).success) {
    throw invalid('Invalid personal data key', 'invalid_key');
  }
  const key = input.key;
  const isCustom = key.startsWith('custom.');
  const def = isCustom ? undefined : personalFieldDef(key);
  if (!isCustom && !def)
    throw invalid(`Unknown personal data field "${key}"`, 'unknown_field', key);
  if (typeof input.value !== 'string')
    throw invalid(`The value of "${key}" must be text`, 'text_required', key);
  if (input.value.length > MAX_VALUE_LENGTH)
    throw invalid(`The value of "${key}" is too long`, 'value_too_long', key);
  if (CONTROL_CHARS.test(input.value))
    throw invalid(`The value of "${key}" has invalid characters`, 'invalid_characters', key);

  let label: string | undefined;
  if (isCustom) {
    if (input.label !== undefined && typeof input.label !== 'string') {
      throw invalid(`The label of "${key}" must be text`, 'label_text_required', key);
    }
    label = typeof input.label === 'string' ? input.label.trim() : existing?.label;
    if (!label) throw invalid(`Custom field "${key}" needs a label`, 'label_required', key);
    if (label.length > MAX_LABEL_LENGTH || CONTROL_CHARS.test(label)) {
      throw invalid(`The label of "${key}" is not valid`, 'invalid_label', key);
    }
  }

  let value = input.value.trim();
  if (value === '') return { key, value: null };

  switch (def?.input) {
    case 'date':
      if (!isCalendarDate(value))
        throw invalid(`"${key}" must be a date (YYYY-MM-DD)`, 'invalid_date', key);
      if ((key === 'birthDate' || key.endsWith('IssueDate')) && !isPastDate(value))
        throw invalid(`"${key}" can't be in the future`, 'future_date', key);
      if (key === 'birthDate' && value < '1900-01-01')
        throw invalid('"birthDate" is too early', 'implausible_date', key);
      break;
    case 'select': {
      const option = matchPersonalOption(def, value);
      if (!option) {
        throw invalid(
          `"${key}" must be one of: ${def.options?.map((o) => o.value).join(', ')}`,
          'invalid_option',
          key,
        );
      }
      value = option.value;
      break;
    }
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        throw invalid(`"${key}" must be an email`, 'invalid_email', key);
      break;
    case 'phone':
      if (!isPhone(value)) throw invalid(`"${key}" must be a phone number`, 'invalid_phone', key);
      break;
    case 'licenceCategories': {
      let rows: LicenceCategories | undefined;
      try {
        rows = LicenceCategories.parse(JSON.parse(value));
      } catch {
        /* Reported below without echoing the value. */
      }
      if (!rows)
        throw invalid(
          `"${key}" must be a JSON list of {category, issueDate?, expiry?} with dates as YYYY-MM-DD`,
          'invalid_licence_categories',
          key,
        );
      value = JSON.stringify(rows);
      break;
    }
    default:
      break;
  }
  if (/^(dni|tie|passport)(Number|SupportNumber)$/.test(key)) {
    value = compactId(value);
    if (!/^[A-Z0-9]{3,20}$/.test(value))
      throw invalid(`"${key}" is not a valid document number`, 'invalid_document_number', key);
    if (DOCUMENT_NUMBER_RULES[key] && !DOCUMENT_NUMBER_RULES[key](value))
      throw invalid(
        `"${key}" fails its check`,
        key.endsWith('SupportNumber') ? 'invalid_document_number' : 'invalid_check_digit',
        key,
      );
  }
  if (key === 'dniAccessNumber') {
    value = value.replace(/\s/g, '');
    if (!DniAccessNumber.safeParse(value).success)
      throw invalid('"dniAccessNumber" must be the 6 digits of the CAN', 'invalid_can', key);
  }
  if (key === 'iban') {
    value = value.toUpperCase().replace(/[\s-]/g, '');
    if (!isValidIban(value)) throw invalid('"iban" is not a valid IBAN', 'invalid_iban', key);
  }
  if (key === 'nuss' && !isValidNuss(value))
    throw invalid('"nuss" is not a valid Social Security number', 'invalid_nuss', key);
  if (key === 'addressPostalCode' && !postalCodeProvince(value))
    throw invalid('"addressPostalCode" is not a Spanish postal code', 'invalid_postal_code', key);
  return { key, value, label };
}

/**
 * Rules between fields. The postal code and province are compared only when saved together, so
 * fixing one never gets blocked by the other stale one.
 */
export function checkPersonalChanges(changes: PersonalChange[]): void {
  const saved = new Map(changes.map((change) => [change.key, change.value]));
  const postalCode = saved.get('addressPostalCode');
  const province = saved.get('addressProvince');
  if (postalCode && province && postalCodeProvince(postalCode)?.value !== province) {
    throw invalid(
      '"addressPostalCode" is not in "addressProvince"',
      'postal_code_province_mismatch',
      'addressPostalCode',
    );
  }
}

/**
 * Fields that used to be free text and are now a `select`: values saved before are mapped to
 * their option when one matches (case, accents and known synonyms aside), otherwise dropped.
 */
const FORMERLY_FREE_TEXT = ['maritalStatus'] as const;

/** Normalizes old stored values in place when the vault loads. Returns whether any changed. */
export function migratePersonal(entries: Map<string, PersonalEntry>): boolean {
  let changed = false;
  for (const key of FORMERLY_FREE_TEXT) {
    const entry = entries.get(key);
    const def = personalFieldDef(key);
    if (!entry || !def) continue;
    const option = matchPersonalOption(def, entry.value);
    if (option?.value === entry.value) continue;
    if (option) entries.set(key, { ...entry, value: option.value });
    else entries.delete(key);
    changed = true;
  }
  return changed;
}

const FIELD_ORDER = new Map(PERSONAL_FIELDS.map((f, i) => [f.key, i]));

/** Well-known fields in PERSONAL_FIELDS order, then custom fields by label. */
export function personalItems(entries: Map<string, PersonalEntry>): PersonalDataItem[] {
  const items: PersonalDataItem[] = [];
  for (const [key, entry] of entries) {
    items.push({
      key,
      label: entry.label ?? personalFieldDef(key)?.label.es ?? key,
      value: entry.value,
      source: entry.source,
      updatedAt: entry.updatedAt,
    });
  }
  const rank = (key: string) => FIELD_ORDER.get(key) ?? Number.MAX_SAFE_INTEGER;
  return items.sort(
    (a, b) =>
      rank(a.key) - rank(b.key) ||
      a.label.localeCompare(b.label, 'es') ||
      a.key.localeCompare(b.key),
  );
}
