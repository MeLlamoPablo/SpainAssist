import type { Appointment } from '@sa/shared';
import { addMinutes, format, isValid, parseISO } from 'date-fns';
import { enGB, es } from 'date-fns/locale';
import type { Lang } from '../../i18n';

/** Calendar events last this long: sites rarely say how long a cita takes. */
const EVENT_MINUTES = 60;

/** `startsAt` has no offset, so date-fns reads it as wall-clock time and keeps it that way. */
function start(appointment: Appointment): Date | null {
  const date = parseISO(appointment.startsAt);
  return isValid(date) ? date : null;
}

/** "Martes, 13 de octubre de 2026, 11:00" / "Tuesday, 13 October 2026, 11:00". */
export function formatAppointment(appointment: Appointment, lang: Lang): string {
  const date = start(appointment);
  if (!date) return appointment.startsAt;
  const text = format(
    date,
    lang === 'es' ? "EEEE, d 'de' MMMM 'de' yyyy, HH:mm" : 'EEEE, d MMMM yyyy, HH:mm',
    { locale: lang === 'es' ? es : enGB },
  );
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function mapsUrl(appointment: Appointment): string {
  const url = new URL('https://www.google.com/maps/search/');
  url.searchParams.set('api', '1');
  url.searchParams.set('query', appointment.address);
  return url.toString();
}

/**
 * A prefilled Google Calendar event. The times carry no time zone, so Google reads them in the
 * calendar's own zone: right for someone who lives where the appointment is.
 */
export function calendarUrl(appointment: Appointment, title: string, details: string): string {
  const date = start(appointment);
  const url = new URL('https://calendar.google.com/calendar/render');
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', title);
  if (date) {
    const stamp = (d: Date) => format(d, "yyyyMMdd'T'HHmmss");
    url.searchParams.set('dates', `${stamp(date)}/${stamp(addMinutes(date, EVENT_MINUTES))}`);
  }
  url.searchParams.set('details', details);
  url.searchParams.set('location', appointment.address);
  return url.toString();
}
