/** Field validators shared by the forms and the identity helpers (messages in Spanish). */

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** Uppercases and strips spaces, dots and dashes: " 12.345.678-z " -> "12345678Z". */
export function normalizeDocumentId(value: string): string {
  return value.toUpperCase().replace(/[\s.-]/g, '');
}

function dniLetter(digits: number): string {
  return DNI_LETTERS[digits % 23]!;
}

/** Returns an error message, or null when `id` is a valid DNI or NIE. Expects a normalized id. */
export function validateDocumentId(id: string): string | null {
  const dni = /^(\d{8})([A-Z])$/.exec(id);
  const nie = /^([XYZ])(\d{7})([A-Z])$/.exec(id);
  if (!dni && !nie) {
    return 'Escribe un DNI (8 números y una letra) o un NIE (X, Y o Z, 7 números y una letra).';
  }
  const digits = dni ? Number(dni[1]) : Number(`${'XYZ'.indexOf(nie![1]!)}${nie![2]}`);
  const letter = dni ? dni[2] : nie![3];
  if (dniLetter(digits) !== letter) return 'La letra del DNI/NIE no es correcta.';
  return null;
}

/** Parses a strict "DD/MM/AAAA" date. Returns null when the format or the date is invalid. */
export function parseSpanishDate(value: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** Spanish mobile number: 9 digits starting with 6 or 7, optional +34/0034 prefix and spaces. */
export function normalizeMobile(value: string): string | null {
  const compact = value.replace(/[\s-]/g, '').replace(/^(\+34|0034)/, '');
  return /^[67]\d{8}$/.test(compact) ? compact : null;
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

/** Masks a phone number the way identity providers do: "600000045" -> "******045". */
export function maskPhone(phone: string): string {
  return `${'*'.repeat(Math.max(0, phone.length - 3))}${phone.slice(-3)}`;
}
