import { describe, expect, it } from 'vitest';
import { Appointment } from '../src/procedure';

describe('Appointment', () => {
  const address = 'Calle Rafael Calvo 33, Madrid';

  it('accepts a local date and time', () => {
    expect(Appointment.safeParse({ address, startsAt: '2026-10-13T11:00' }).success).toBe(true);
    expect(Appointment.safeParse({ address, startsAt: '2028-02-29T09:30' }).success).toBe(true);
  });

  it('rejects offsets, seconds, missing times and days a month does not have', () => {
    for (const startsAt of [
      '2026-10-13T11:00Z',
      '2026-10-13T11:00+02:00',
      '2026-10-13T11:00:00',
      '2026-10-13',
      '2026-02-30T11:00',
      '2026-13-01T11:00',
      '2026-10-13T24:00',
    ]) {
      expect(Appointment.safeParse({ address, startsAt }).success, startsAt).toBe(false);
    }
  });
});
