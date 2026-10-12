/**
 * Values that must never leave the device in clear text: used for exact-match PII scrubbing
 * (`@sa/pii` `knownValues`, which matches case-, accent- and space-insensitively).
 *
 * Rules:
 *  - every personal value except low-identifying categories (document type, sex, nationality,
 *    marital status, province, country), so that learnings keep words like "DNI" or "Madrid
 *    (provincia)";
 *  - common written variants: name combinations and each surname, DNI/NIE with and without
 *    the letter or with separators, dates as dd/mm/yyyy, phone with and without +34, IBAN with
 *    and without spaces (and the 20-digit account number), NUSS with separators, address parts;
 *  - Cl@ve usernames and certificate holder names/IDs;
 *  - the DNIe PIN, in case the user writes it in the chat (agents never get it from the app);
 *  - values shorter than 3 characters are skipped (too many false positives).
 */
import type { PersonalEntry } from './state';

const SKIPPED_FIELDS = new Set([
  'sex',
  'nationality',
  'maritalStatus',
  'addressProvince',
  'addressCountry',
]);

const MIN_LENGTH = 3;

function idVariants(raw: string): string[] {
  const id = raw.toUpperCase().replace(/[\s.-]/g, '');
  const out = [raw, id];
  const dni = /^([0-9]{8})([A-Z])$/.exec(id);
  if (dni) {
    const [, digits, letter] = dni;
    out.push(digits!, `${digits}-${letter}`, `${digits} ${letter}`);
    const unpadded = digits!.replace(/^0+/, '');
    if (unpadded !== digits && unpadded.length >= MIN_LENGTH) out.push(unpadded + letter, unpadded);
  }
  const nie = /^([XYZ])([0-9]{7})([A-Z])$/.exec(id);
  if (nie) {
    const [, prefix, digits, letter] = nie;
    out.push(`${prefix}${digits}`, `${prefix}-${digits}-${letter}`, `${prefix}${digits}-${letter}`);
  }
  return out;
}

function dateVariants(iso: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return [iso];
  const [, y, m, d] = match;
  if (y === '9999') return []; // "permanent" document validity: not personal
  return [iso, `${d}/${m}/${y}`, `${d}-${m}-${y}`, `${d}.${m}.${y}`, `${d}${m}${y}`];
}

function phoneVariants(raw: string): string[] {
  const digits = raw.replace(/\D/g, '');
  const out = [raw, digits];
  let national: string | undefined;
  if (
    /^(?:0034|\+34)/.test(raw.replace(/\s/g, '')) ||
    (digits.length === 11 && digits.startsWith('34'))
  ) {
    national = digits.replace(/^(?:0034|34)/, '');
  } else if (digits.length === 9) {
    national = digits;
  }
  if (national && national.length === 9) {
    out.push(
      national,
      `+34${national}`,
      `+34 ${national}`,
      `0034${national}`,
      `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`,
      `${national.slice(0, 3)} ${national.slice(3, 5)} ${national.slice(5, 7)} ${national.slice(7)}`,
    );
  }
  return out;
}

function ibanVariants(raw: string): string[] {
  const compact = raw.toUpperCase().replace(/[\s-]/g, '');
  const out = [raw, compact, compact.replace(/(.{4})(?=.)/g, '$1 ')];
  if (compact.startsWith('ES') && compact.length === 24) {
    const ccc = compact.slice(4);
    out.push(ccc, `${ccc.slice(0, 4)} ${ccc.slice(4, 8)} ${ccc.slice(8, 10)} ${ccc.slice(10)}`);
  }
  return out;
}

function nussVariants(raw: string): string[] {
  const digits = raw.replace(/\D/g, '');
  const out = [raw, digits];
  if (digits.length === 12) {
    const [a, b, c] = [digits.slice(0, 2), digits.slice(2, 10), digits.slice(10)];
    out.push(`${a} ${b} ${c}`, `${a}/${b}/${c}`, `${a}/${b}-${c}`);
  }
  return out;
}

function nameVariants(given?: string, surname1?: string, surname2?: string): string[] {
  const out: string[] = [];
  const surnames = [surname1, surname2].filter(Boolean).join(' ');
  if (surnames) out.push(surnames);
  if (given && surname1) {
    out.push(`${given} ${surname1}`, `${surname1}, ${given}`, `${surname1} ${given}`);
  }
  if (given && surnames) {
    out.push(`${given} ${surnames}`, `${surnames} ${given}`, `${surnames}, ${given}`);
  }
  return out;
}

export interface SensitiveSources {
  personal: Map<string, PersonalEntry>;
  claveUsernames: string[];
  certificateHolders: Array<{ holderName?: string; holderId?: string }>;
  dniePins: string[];
}

export function sensitiveValues(sources: SensitiveSources): string[] {
  const values: string[] = [];
  const get = (key: string) => sources.personal.get(key)?.value;

  for (const [key, entry] of sources.personal) {
    if (SKIPPED_FIELDS.has(key)) continue;
    const value = entry.value;
    switch (key) {
      case 'dniNumber':
      case 'tieNumber':
      case 'passportNumber':
        values.push(...idVariants(value));
        break;
      case 'birthDate':
      case 'dniExpiry':
      case 'tieExpiry':
      case 'passportExpiry':
      case 'dniIssueDate':
      case 'tieIssueDate':
      case 'passportIssueDate':
      case 'drivingLicenceIssueDate':
      case 'drivingLicenceExpiry':
        values.push(...dateVariants(value));
        break;
      case 'phone':
        values.push(...phoneVariants(value));
        break;
      case 'iban':
        values.push(...ibanVariants(value));
        break;
      case 'nuss':
        values.push(...nussVariants(value));
        break;
      case 'addressStreet':
        values.push(value, ...value.split(/[,;\n]/).map((part) => part.trim()));
        break;
      case 'email':
        values.push(value, value.toLowerCase());
        break;
      default:
        values.push(value);
    }
  }
  values.push(...nameVariants(get('givenName'), get('surname1'), get('surname2')));
  for (const username of sources.claveUsernames) values.push(...idVariants(username));
  for (const holder of sources.certificateHolders) {
    if (holder.holderName) values.push(holder.holderName);
    if (holder.holderId) values.push(...idVariants(holder.holderId));
  }
  values.push(...sources.dniePins);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value.length < MIN_LENGTH || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  // Longest first, so scrubbers replace "Calle Mayor 5, 3º B" before "Calle Mayor 5".
  return out.sort((a, b) => b.length - a.length || a.localeCompare(b));
}
