/** How Spanish documents write dates, money and amounts in words. */

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** `2026-10-12` -> `12/10/2026`. */
export function slashDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

/** `2026-10-12` -> `12.10.2026` (the permiso de circulación's style). */
export function dottedDate(iso: string): string {
  return slashDate(iso).replaceAll('/', '.');
}

/** `2026-10-12` -> `{ day: '12', month: 'octubre', year: '2026' }`. */
export function dateParts(iso: string): { day: string; month: string; year: string } {
  const [year, month, day] = iso.slice(0, 10).split('-');
  return { day: String(Number(day)), month: MONTHS[Number(month) - 1]!, year: year! };
}

/** `2026-10-16T11:42` -> `16/10/2026 11:42`. */
export function slashDateTime(isoMinute: string): string {
  return `${slashDate(isoMinute)} ${isoMinute.slice(11, 16)}`;
}

/** 8900 -> `8.900,00`. */
export function euros(amount: number): string {
  const [whole, cents] = amount.toFixed(2).split('.');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${cents}`;
}

/** 8900 -> `8.900`. */
export function thousands(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

const UNITS = [
  '',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
  'veinte',
  'veintiuno',
  'veintidós',
  'veintitrés',
  'veinticuatro',
  'veinticinco',
  'veintiséis',
  'veintisiete',
  'veintiocho',
  'veintinueve',
];
const TENS = [
  '',
  '',
  '',
  'treinta',
  'cuarenta',
  'cincuenta',
  'sesenta',
  'setenta',
  'ochenta',
  'noventa',
];
const HUNDREDS = [
  '',
  'ciento',
  'doscientos',
  'trescientos',
  'cuatrocientos',
  'quinientos',
  'seiscientos',
  'setecientos',
  'ochocientos',
  'novecientos',
];

function belowThousand(n: number): string {
  if (n === 100) return 'cien';
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds) parts.push(HUNDREDS[hundreds]!);
  if (rest < 30) {
    if (rest) parts.push(UNITS[rest]!);
  } else {
    const unit = rest % 10;
    parts.push(unit ? `${TENS[Math.floor(rest / 10)]} y ${UNITS[unit]}` : TENS[rest / 10]!);
  }
  return parts.join(' ');
}

/** A whole number of euros in words, as a contract writes it: 8900 -> `ocho mil novecientos`. */
export function inWords(value: number): string {
  const n = Math.round(value);
  if (n === 0) return 'cero';
  const millions = Math.floor(n / 1_000_000);
  const thousandsPart = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (millions) parts.push(millions === 1 ? 'un millón' : `${belowThousand(millions)} millones`);
  if (thousandsPart) {
    parts.push(
      thousandsPart === 1
        ? 'mil'
        : `${belowThousand(thousandsPart)
            .replace(/veintiuno$/, 'veintiún')
            .replace(/uno$/, 'un')} mil`,
    );
  }
  if (rest) parts.push(belowThousand(rest));
  return parts.join(' ');
}
