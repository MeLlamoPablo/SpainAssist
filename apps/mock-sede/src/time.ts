/** Date helpers in the sede's time zone (Europe/Madrid). */

const TZ = 'Europe/Madrid';

const dateTimeFormat = new Intl.DateTimeFormat('es-ES', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** "03/10/2026 14:32:10" */
export function formatMadridDateTime(date: Date): string {
  return dateTimeFormat.format(date).replace(',', '');
}

const isoDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** "2026-10-03" (calendar date in Madrid). */
export function madridIsoDate(date: Date): string {
  return isoDateFormat.format(date);
}

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
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

/** Weekday (0 = Sunday) of an ISO calendar date. */
export function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "12/10/2026" */
export function formatIsoDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

/** "lunes 12 de octubre de 2026" */
export function longSpanishDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${WEEKDAYS[weekdayOf(isoDate)]} ${d} de ${MONTHS[m! - 1]} de ${y}`;
}

/** "lun 12/10" */
export function shortSpanishDate(isoDate: string): string {
  const [, m, d] = isoDate.split('-');
  return `${WEEKDAYS[weekdayOf(isoDate)]!.slice(0, 3)} ${d}/${m}`;
}
