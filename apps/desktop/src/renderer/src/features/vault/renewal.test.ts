import { describe, expect, it } from 'vitest';
import { renewableDocument } from './renewal';

const now = new Date(2026, 9, 12, 15, 30); // 12 Oct 2026, afternoon

describe('renewableDocument', () => {
  it('opens a DNI 180 days before it expires', () => {
    expect(renewableDocument('dniExpiry', '2027-04-10', now)).toEqual({ group: 'dni', days: 180 });
    expect(renewableDocument('dniExpiry', '2027-04-11', now)).toBeNull();
  });

  it('opens a TIE 2 months and a driving licence 3 months before', () => {
    expect(renewableDocument('tieExpiry', '2026-12-12', now)).toEqual({ group: 'tie', days: 61 });
    expect(renewableDocument('tieExpiry', '2026-12-13', now)).toBeNull();
    expect(renewableDocument('drivingLicenceExpiry', '2027-01-12', now)?.group).toBe(
      'drivingLicence',
    );
    expect(renewableDocument('drivingLicenceExpiry', '2027-01-13', now)).toBeNull();
  });

  it('keeps an expired document renewable', () => {
    expect(renewableDocument('passportExpiry', '2026-01-01', now)).toEqual({
      group: 'passport',
      days: -284,
    });
  });

  it('ignores permanent DNIs, other dates and other fields', () => {
    expect(renewableDocument('dniExpiry', '9999-12-31', now)).toBeNull();
    expect(renewableDocument('dniIssueDate', '2026-10-01', now)).toBeNull();
    expect(renewableDocument('dniExpiry', 'pronto', now)).toBeNull();
  });
});
