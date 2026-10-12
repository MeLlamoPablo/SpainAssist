import {
  type FormField,
  type FormValue,
  matchProvince,
  type PersonalDataInput,
  type PersonalDataItem,
  type PromptResponse,
  visibleFormFields,
} from '@sa/shared';

import {
  IDENTITY_DOCUMENT_FIELDS,
  SCANNABLE_PERSONAL_KEYS,
} from '../../../../../identity-documents';

/** Pure helpers behind the form prompt card (kept React-free for tests). */

export type Values = Record<string, FormValue>;

function matchOption(field: FormField, raw: string): string | undefined {
  const needle = raw.trim().toLowerCase();
  return field.options?.find(
    (o) => o.value.toLowerCase() === needle || o.label.toLowerCase() === needle,
  )?.value;
}

function parseList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      // fall through
    }
  }
  return trimmed
    ? trimmed
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/** Initial values: the field's defaultValue, else (for vault-backed fields) the saved value. */
export function initialValues(fields: FormField[], personal: PersonalDataItem[] = []): Values {
  const values: Values = {};
  for (const field of fields) {
    const personalKey = field.vaultKey ?? scanKey(field);
    const saved = personalKey ? personal.find((p) => p.key === personalKey)?.value : undefined;
    const raw = field.defaultValue ?? (field.type === 'secret' ? undefined : saved);
    switch (field.type) {
      case 'boolean':
        values[field.key] = raw === 'true' || raw === '1' || raw === 'yes';
        break;
      case 'multiselect': {
        const list = raw ? parseList(raw) : [];
        values[field.key] = list
          .map((v) => matchOption(field, v) ?? v)
          .filter((v) => field.options?.some((o) => o.value === v) ?? true);
        break;
      }
      case 'map-options':
      case 'select':
        values[field.key] = raw ? (matchOption(field, raw) ?? '') : '';
        break;
      case 'province':
        values[field.key] = raw ? (matchProvince(raw)?.value ?? '') : '';
        break;
      default:
        values[field.key] = raw ?? '';
    }
  }
  return values;
}

export type FieldError = 'required' | 'email' | 'phone' | 'number';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[\d\s().-]{9,20}$/;
const NUMBER = /^-?\d+([.,]\d+)?$/;

export function validate(fields: FormField[], values: Values): Record<string, FieldError> {
  const errors: Record<string, FieldError> = {};
  for (const field of visibleFormFields(fields, values)) {
    const value = values[field.key];
    const empty =
      value === undefined ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0);
    if (field.type === 'boolean') continue;
    if (empty) {
      if (field.required) errors[field.key] = 'required';
      continue;
    }
    if (typeof value !== 'string') continue;
    const v = value.trim();
    if (field.type === 'email' && !EMAIL.test(v)) errors[field.key] = 'email';
    if (field.type === 'phone' && (!PHONE.test(v) || v.replace(/\D/g, '').length < 9))
      errors[field.key] = 'phone';
    if (field.type === 'number' && !NUMBER.test(v)) errors[field.key] = 'number';
  }
  return errors;
}

/** Fields whose answer is always saved to "Mis datos" (never secrets or documents). */
export function saveableFields(fields: FormField[]): FormField[] {
  return fields.filter((f) => f.vaultKey && f.type !== 'secret' && f.type !== 'document');
}

export function buildResponse(
  fields: FormField[],
  values: Values,
): Extract<PromptResponse, { kind: 'form' }> {
  const out: Values = {};
  for (const field of visibleFormFields(fields, values)) {
    const value = values[field.key];
    if (value === undefined) continue;
    if (typeof value === 'string') {
      const v = field.type === 'secret' ? value : value.trim();
      if (v) out[field.key] = v;
    } else if (Array.isArray(value)) {
      if (value.length) out[field.key] = value;
    } else {
      out[field.key] = value;
    }
  }
  const savedToVault = saveableFields(fields)
    .filter((f) => typeof out[f.key] === 'string')
    .map((f) => f.key);
  return { kind: 'form', values: out, dismissed: false, savedToVault };
}

/** Human-readable answer for the "answered" summary. Secrets are always masked. */
export function displayValue(
  field: FormField,
  value: FormValue | undefined,
  labels: { yes: string; no: string; hidden: string },
  documentName: (id: string) => string | undefined,
): string | null {
  if (field.type === 'secret') return `•••• (${labels.hidden})`;
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? labels.yes : labels.no;
  const optionLabel = (v: string) => field.options?.find((o) => o.value === v)?.label ?? v;
  if (Array.isArray(value)) return value.map(optionLabel).join(', ');
  if (field.type === 'document') return documentName(value) ?? value;
  if (field.type === 'select' || field.type === 'map-options') return optionLabel(value);
  return value;
}

/** Scan eligibility is semantic: an explicit vault key wins over the form's local key. */
function scanKey(field: FormField): string | undefined {
  if (
    !['text', 'textarea', 'date', 'number', 'select', 'multiselect', 'province'].includes(
      field.type,
    )
  )
    return undefined;
  const key = field.vaultKey ?? field.key;
  return SCANNABLE_PERSONAL_KEYS.has(key) ? key : undefined;
}

function missing(value: FormValue | undefined): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && value.length === 0)
  );
}

const DOCUMENT_SCAN_CHOICES = [
  {
    kind: 'dniTie',
    keys: new Set<string>([...IDENTITY_DOCUMENT_FIELDS.DNI, ...IDENTITY_DOCUMENT_FIELDS.TIE]),
  },
  { kind: 'drivingLicence', keys: new Set<string>(IDENTITY_DOCUMENT_FIELDS.DRIVING_LICENCE) },
  { kind: 'passport', keys: new Set<string>(IDENTITY_DOCUMENT_FIELDS.PASSPORT) },
] as const;

/** Prefer DNI/TIE, then a driving licence, then a passport for visible missing fields. */
export function documentScanChoice(fields: FormField[], values: Values) {
  const keys = visibleFormFields(fields, values)
    .filter((field) => missing(values[field.key]))
    .map(scanKey)
    .filter((key): key is string => key !== undefined);
  return DOCUMENT_SCAN_CHOICES.find((choice) => keys.some((key) => choice.keys.has(key)))?.kind;
}

export function hasMissingDocumentFields(fields: FormField[], values: Values): boolean {
  return documentScanChoice(fields, values) !== undefined;
}

/** Fill only missing, visible answers from this scan. Never replace a typed answer or submit. */
export function fillDocumentFields(
  fields: FormField[],
  values: Values,
  scanned: PersonalDataInput[],
): Values {
  const next = { ...values };
  for (const field of visibleFormFields(fields, values)) {
    const key = scanKey(field);
    if (!key || !missing(values[field.key])) continue;
    const raw = scanned.find((item) => item.key === key)?.value;
    if (!raw?.trim()) continue;
    const candidate = initialValues([{ ...field, defaultValue: raw }])[field.key];
    if (!missing(candidate)) next[field.key] = candidate!;
  }
  return next;
}
