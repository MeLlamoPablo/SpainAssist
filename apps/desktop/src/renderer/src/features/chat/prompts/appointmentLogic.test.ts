import { describe, expect, it } from 'vitest';
import {
  appointmentDays,
  columnsFor,
  dayHeading,
  pageOf,
  rangeLabel,
  slotLabel,
} from './appointmentLogic';
import { displayValue, initialValues } from './formLogic';

const slots = [
  '2026-10-22T19:00',
  '2026-10-19T19:00',
  '2026-10-19T09:30',
  '2026-10-20T19:00',
  '2026-10-29T19:00',
];

describe('appointment picker logic', () => {
  it('groups slots by day, in order, leaving out days without slots', () => {
    expect(appointmentDays(slots)).toEqual([
      { date: '2026-10-19', slots: ['2026-10-19T09:30', '2026-10-19T19:00'] },
      { date: '2026-10-20', slots: ['2026-10-20T19:00'] },
      { date: '2026-10-22', slots: ['2026-10-22T19:00'] },
      { date: '2026-10-29', slots: ['2026-10-29T19:00'] },
    ]);
  });

  it('fits 2 to 6 columns and opens on the page of the chosen slot', () => {
    expect(columnsFor(150)).toBe(2);
    expect(columnsFor(580)).toBe(5);
    expect(columnsFor(2000)).toBe(6);
    const days = appointmentDays(slots);
    expect(pageOf(days, 2, '2026-10-29T19:00')).toBe(1);
    expect(pageOf(days, 2, '')).toBe(0);
  });

  it('labels days and slots in local time, whatever the time zone', () => {
    const days = appointmentDays(slots);
    expect(rangeLabel(days, 'en')).toMatch(/^19\s?–\s?29 Oct 2026$/);
    expect(rangeLabel(days.slice(0, 1), 'es')).toBe('19 oct 2026');
    expect(dayHeading('2026-10-19', 'es')).toEqual({ weekday: 'LUN', day: '19' });
    expect(dayHeading('2026-10-22', 'en')).toEqual({ weekday: 'THU', day: '22' });
    expect(slotLabel('2026-10-19T09:30', 'es')).toBe('lunes, 19 de octubre de 2026, 09:30');
  });

  it('prefills only an offered slot and shows a request for more', () => {
    const field = {
      key: 'cita',
      label: 'Cita',
      type: 'appointment' as const,
      required: true,
      slots,
    };
    expect(initialValues([{ ...field, defaultValue: '2026-10-20T19:00' }])).toEqual({
      cita: '2026-10-20T19:00',
    });
    expect(initialValues([{ ...field, defaultValue: '2026-11-01T10:00' }])).toEqual({ cita: '' });
    const labels = { yes: 'Sí', no: 'No', hidden: 'oculto', moreAppointments: 'Pidió otras citas' };
    expect(displayValue(field, 'more', labels, () => undefined)).toBe('Pidió otras citas');
    expect(displayValue(field, '2026-10-20T19:00', labels, () => undefined, 'en')).toBe(
      'Tuesday, 20 October 2026, 19:00',
    );
  });
});
