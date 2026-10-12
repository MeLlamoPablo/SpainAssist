import { describe, expect, it } from 'vitest';
import { calendarUrl, formatAppointment, mapsUrl } from './appointment';

const appointment = {
  address: 'Centro Médico Hiniesta, C/ Madre Dolores Márquez 2, Sevilla',
  startsAt: '2026-10-13T23:30',
};

describe('appointment', () => {
  it('formats the wall-clock time in each language', () => {
    expect(formatAppointment(appointment, 'es')).toBe('Martes, 13 de octubre de 2026, 23:30');
    expect(formatAppointment(appointment, 'en')).toBe('Tuesday, 13 October 2026, 23:30');
  });

  it('searches the address on Google Maps', () => {
    const url = new URL(mapsUrl(appointment));
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/search/');
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('query')).toBe(appointment.address);
  });

  it('prefills a one-hour Google Calendar event without a time zone', () => {
    const url = new URL(calendarUrl(appointment, 'Renovar el carnet', 'Lleva tu DNI'));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Renovar el carnet');
    // Crosses midnight: the end is the next day.
    expect(url.searchParams.get('dates')).toBe('20261013T233000/20261014T003000');
    expect(url.searchParams.get('details')).toBe('Lleva tu DNI');
    expect(url.searchParams.get('location')).toBe(appointment.address);
    expect(url.searchParams.has('ctz')).toBe(false);
  });
});
