import { type Lang, LOCALE } from '../../../i18n';

/** Pure helpers behind the appointment picker (kept React-free for tests). */

export interface AppointmentDay {
  /** YYYY-MM-DD */
  date: string;
  /** The day's slots (YYYY-MM-DDTHH:MM), in time order. */
  slots: string[];
}

/** Days that have free slots, in date order. Days without slots are not shown. */
export function appointmentDays(slots: readonly string[]): AppointmentDay[] {
  const byDate = new Map<string, string[]>();
  for (const slot of [...new Set(slots)].sort()) {
    const date = slot.slice(0, 10);
    byDate.set(date, [...(byDate.get(date) ?? []), slot]);
  }
  return [...byDate].map(([date, daySlots]) => ({ date, slots: daySlots }));
}

/** Day columns that fit a width: at least 2, at most 6. */
export function columnsFor(width: number, minColumn = 104, gap = 12): number {
  return Math.max(2, Math.min(6, Math.floor((width + gap) / (minColumn + gap))));
}

export function pageOf(days: AppointmentDay[], perPage: number, value: string): number {
  const index = days.findIndex((day) => day.slots.includes(value));
  return index < 0 ? 0 : Math.floor(index / perPage);
}

const locale = (lang: Lang) => LOCALE[lang];
/** Slots are local times without a zone: format them as UTC so no offset shifts them. */
const utc = (date: string, time = '00:00') => new Date(`${date}T${time}:00Z`);

/** "19–29 oct 2026", or one date for a single day. */
export function rangeLabel(days: AppointmentDay[], lang: Lang): string {
  if (!days.length) return '';
  const format = new Intl.DateTimeFormat(locale(lang), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const first = utc(days[0]!.date);
  const last = utc(days[days.length - 1]!.date);
  return days.length === 1 ? format.format(first) : format.formatRange(first, last);
}

/** Column heading: weekday and day of the month, e.g. { weekday: "LUN", day: "19" }. */
export function dayHeading(date: string, lang: Lang): { weekday: string; day: string } {
  const weekday = new Intl.DateTimeFormat(locale(lang), { weekday: 'short', timeZone: 'UTC' })
    .format(utc(date))
    .replace('.', '')
    .toUpperCase();
  return { weekday, day: String(Number(date.slice(8, 10))) };
}

/** "lunes, 19 de octubre de 2026, 19:00" */
export function slotLabel(slot: string, lang: Lang): string {
  const date = new Intl.DateTimeFormat(locale(lang), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(utc(slot.slice(0, 10)));
  return `${date}, ${slot.slice(11, 16)}`;
}
