import { documentPersonalInputs } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { normalizePersonalInput } from '../src/personal';
import { sensitiveValues } from '../src/sensitive';
import type { PersonalEntry } from '../src/state';

const entry = (value: string): PersonalEntry => ({
  value,
  source: 'scan',
  updatedAt: '2026-10-04T12:00:00.000Z',
});

describe('document-specific personal data', () => {
  it.each([
    ['DNI', 'dni'],
    ['TIE', 'tie'],
    ['PASSPORT', 'passport'],
  ])('maps %s extraction into independent saved keys', (type, prefix) => {
    expect(
      documentPersonalInputs([
        { key: 'documentType', value: type! },
        { key: 'givenName', value: 'Carmen' },
        { key: 'documentNumber', value: 'ABC123456' },
        { key: 'documentIssueDate', value: '2026-01-01' },
        { key: 'documentExpiry', value: '2031-01-01' },
      ]),
    ).toEqual([
      { key: 'givenName', value: 'Carmen' },
      { key: `${prefix}Number`, value: 'ABC123456' },
      { key: `${prefix}IssueDate`, value: '2026-01-01' },
      { key: `${prefix}Expiry`, value: '2031-01-01' },
    ]);
  });

  it('requires the document type rather than guessing DNI', () => {
    expect(() =>
      documentPersonalInputs([{ key: 'documentExpiry', value: '2031-01-01' }]),
    ).toThrow();
  });

  it('validates document numbers and dates and scrubs their written variants', () => {
    for (const [prefix, written, compact] of [
      ['dni', '12.345.678-z', '12345678Z'],
      ['tie', 'x-1234567-l', 'X1234567L'],
      ['passport', '12.345.678-z', '12345678Z'],
    ]) {
      expect(
        normalizePersonalInput({ key: `${prefix}Number`, value: written }, undefined).value,
      ).toBe(compact);
      expect(() =>
        normalizePersonalInput({ key: `${prefix}Expiry`, value: '2031-02-30' }, undefined),
      ).toThrow();
      const values = sensitiveValues({
        personal: new Map([
          [`${prefix}Number`, entry('12345678Z')],
          [`${prefix}IssueDate`, entry('2026-01-02')],
        ]),
        claveUsernames: [],
        certificateHolders: [],
        dniePins: [],
      });
      expect(values).toContain('12345678');
      expect(values).toContain('02/01/2026');
    }
  });

  it('scrubs the DNI CAN from text that leaves the device', () => {
    const values = sensitiveValues({
      personal: new Map([['dniAccessNumber', entry('654321')]]),
      claveUsernames: [],
      certificateHolders: [],
      dniePins: [],
    });
    expect(values).toEqual(['654321']);
  });
});
