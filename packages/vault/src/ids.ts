/** Spanish DNI/NIE control letter (Ministerio del Interior, mod 23). */
const LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

export function isDni(value: string): boolean {
  return /^[0-9]{8}[A-Z]$/.test(value) && LETTERS[Number(value.slice(0, 8)) % 23] === value[8];
}

export function isNie(value: string): boolean {
  if (!/^[XYZ][0-9]{7}[A-Z]$/.test(value)) return false;
  const number = Number('XYZ'.indexOf(value[0]!) + value.slice(1, 8));
  return LETTERS[number % 23] === value[8];
}

export function isSpanishId(value: string): boolean {
  return isDni(value) || isNie(value);
}

/** Uppercases and removes spaces, dots and hyphens: "12.345.678-z" -> "12345678Z". */
export function compactId(value: string): string {
  return value.toUpperCase().replace(/[\s.-]/g, '');
}
