import { APPOINTMENT_MORE, type FormValue, matchProvince } from '@sa/shared';
import type { AnswerAction, PendingPrompt } from '../contracts';
import { compilePattern, shorten, stripDiacritics, testPattern } from './text';

/** Form answers as the app takes them (`PromptResponse` of kind `form`). */
export type FormValues = Record<string, FormValue>;

export type PromptField = NonNullable<PendingPrompt['fields']>[number];

export interface FormValuesResult {
  /** Valid values, normalised to what the app's form fields hold. */
  values: FormValues;
  /** Provided values that are not valid for their field: `key: reason`. */
  issues: string[];
  /** Provided keys that were dropped: unknown fields, secrets and documents. */
  ignored: string[];
}

// The same rules as the renderer's form validation (`formLogic.validate`).
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[\d\s().-]{9,20}$/;
const NUMBER = /^-?\d+([.,]\d+)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SPANISH_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

const MAX_TEXT = 500;
const MAX_TEXTAREA = 4000;

const TRUE_WORDS = new Set(['true', 'yes', 'si', 'sí', '1', 'y', 's']);
const FALSE_WORDS = new Set(['false', 'no', '0', 'n']);

function foldKey(text: string): string {
  return stripDiacritics(text).trim().toLowerCase();
}

/** The option a raw value names, by value or by label (case and accents ignored). */
export function findOption(field: PromptField, raw: string): string | undefined {
  const options = field.options ?? [];
  const exact = options.find((option) => option.value === raw);
  if (exact) return exact.value;
  const needle = foldKey(raw);
  return options.find((o) => foldKey(o.value) === needle || foldKey(o.label) === needle)?.value;
}

const MORE_WORDS = new Set(['more', 'mas', 'mas citas', 'otras', 'otras citas']);

/**
 * The appointment slot a raw value names ("2026-10-19T09:00", "2026-10-19 9:00"), or
 * APPOINTMENT_MORE when the answer asks for other slots.
 */
export function findSlot(field: PromptField, raw: string): string | undefined {
  if (MORE_WORDS.has(foldKey(raw))) return APPOINTMENT_MORE;
  const match = /^(\d{4}-\d{2}-\d{2})[T\s]+(\d{1,2}):(\d{2})/.exec(raw.trim());
  if (!match) return undefined;
  const slot = `${match[1]}T${match[2]!.padStart(2, '0')}:${match[3]}`;
  return field.slots?.includes(slot) ? slot : undefined;
}

function realDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeDate(raw: string): string | undefined {
  const iso = ISO_DATE.exec(raw);
  if (iso) return realDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const spanish = SPANISH_DATE.exec(raw);
  if (spanish) return realDate(Number(spanish[3]), Number(spanish[2]), Number(spanish[1]));
  return undefined;
}

function scalarText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

type FieldResult = { ok: true; value: FormValue } | { ok: false; reason: string };

function parseField(field: PromptField, raw: unknown): FieldResult {
  const fail = (reason: string): FieldResult => ({ ok: false, reason });
  switch (field.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const word = typeof raw === 'string' ? foldKey(raw) : undefined;
      if (word !== undefined && TRUE_WORDS.has(word)) return { ok: true, value: true };
      if (word !== undefined && FALSE_WORDS.has(word)) return { ok: true, value: false };
      return fail('expected true or false');
    }
    case 'select':
    case 'map-options': {
      const text = scalarText(raw);
      if (!text) return fail('expected one of the option values');
      const value = findOption(field, text);
      return value === undefined
        ? fail(`"${shorten(text, 60)}" is not one of the options`)
        : { ok: true, value };
    }
    case 'appointment': {
      const text = scalarText(raw);
      const value = text ? findSlot(field, text) : undefined;
      return value === undefined
        ? fail(`expected one of the slots (YYYY-MM-DDTHH:MM) or "${APPOINTMENT_MORE}"`)
        : { ok: true, value };
    }
    case 'multiselect': {
      const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
      if (items.length === 0) return fail('expected a list of option values');
      const values: string[] = [];
      for (const item of items) {
        const text = scalarText(item);
        const value = text ? findOption(field, text) : undefined;
        if (value === undefined)
          return fail(`"${shorten(String(item), 60)}" is not one of the options`);
        if (!values.includes(value)) values.push(value);
      }
      return { ok: true, value: values };
    }
    default:
      break;
  }

  const text = scalarText(raw);
  if (!text) return fail('expected a non-empty text');
  switch (field.type) {
    case 'number':
      return NUMBER.test(text) ? { ok: true, value: text } : fail('expected a number');
    case 'date': {
      const date = normalizeDate(text);
      return date ? { ok: true, value: date } : fail('expected a date as YYYY-MM-DD');
    }
    case 'email':
      return EMAIL.test(text) ? { ok: true, value: text } : fail('expected an email address');
    case 'phone':
      return PHONE.test(text) && text.replace(/\D/g, '').length >= 9
        ? { ok: true, value: text }
        : fail('expected a phone number');
    case 'province': {
      const province = matchProvince(text);
      return province ? { ok: true, value: province.value } : fail('not a Spanish province');
    }
    case 'textarea':
      return text.length <= MAX_TEXTAREA ? { ok: true, value: text } : fail('text too long');
    default:
      return text.length <= MAX_TEXT ? { ok: true, value: text } : fail('text too long');
  }
}

/**
 * Validates form answers against the prompt's fields: known keys only, option values for
 * selects (a label is accepted and mapped to its value), dates as YYYY-MM-DD, and so on. Secret
 * and document fields are never filled (secrets only come from structured credential answers).
 */
export function validateFormValues(
  fields: readonly PromptField[],
  raw: Record<string, unknown>,
): FormValuesResult {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const result: FormValuesResult = { values: {}, issues: [], ignored: [] };
  for (const [key, value] of Object.entries(raw)) {
    const field = byKey.get(key);
    if (!field || field.secret || field.type === 'secret' || field.type === 'document') {
      result.ignored.push(key);
      continue;
    }
    if (value === null || value === undefined || value === '') continue;
    const parsed = parseField(field, value);
    if (parsed.ok) result.values[key] = parsed.value;
    else result.issues.push(`${key}: ${parsed.reason}`);
  }
  return result;
}

/**
 * The values a `select` answer sets: the first field with an option whose label matches. A
 * multiselect gets a one-item list. Undefined when no option of the prompt matches.
 */
export function selectValues(
  fields: readonly PromptField[],
  optionLabel: string,
): FormValues | undefined {
  const pattern = compilePattern(optionLabel, 'select.optionLabel');
  for (const field of fields) {
    if (field.secret || field.type === 'secret' || field.type === 'document') continue;
    const option = (field.options ?? []).find((o) => testPattern(pattern, o.label));
    if (!option) continue;
    return { [field.key]: field.type === 'multiselect' ? [option.value] : option.value };
  }
  return undefined;
}

/**
 * The form values a scripted action sets: `select` picks an option by label, `values` gives
 * values by field key (validated like the answerer's). `issues` says why nothing could be set.
 */
export function resolveFormAction(
  action: Extract<AnswerAction, { type: 'select' | 'values' }>,
  prompt: Pick<PendingPrompt, 'fields'>,
): FormValuesResult {
  const fields = prompt.fields ?? [];
  if (action.type === 'values') return validateFormValues(fields, action.values);
  const values = selectValues(fields, action.optionLabel);
  return values
    ? { values, issues: [], ignored: [] }
    : { values: {}, issues: [`no option matches /${action.optionLabel}/`], ignored: [] };
}
