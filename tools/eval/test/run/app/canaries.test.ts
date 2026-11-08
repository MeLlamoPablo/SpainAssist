import { describe, expect, it } from 'vitest';
import { CanaryScanner } from '../../../src/net';
import { buildCanaries } from '../../../src/run/app/canaries';
import type { VaultPort } from '../../../src/run/app/provider-vault';

function fakeVault(personal: Record<string, string>, sensitive: string[]): VaultPort {
  return {
    listPersonal: () => Object.entries(personal).map(([key, value]) => ({ key, value })),
    knownSensitiveValues: () => sensitive,
  } as unknown as VaultPort;
}

const PERSONA = {
  givenName: 'Lucía',
  surname1: 'Moreno',
  surname2: 'Castillo',
  dniNumber: '53918274H',
};

describe('buildCanaries', () => {
  it('has the full name in both orders, what the vault lists as sensitive, secrets, the world and report codes', () => {
    const canaries = buildCanaries({
      vault: fakeVault(PERSONA, ['53918274H', '23/05/1991', 'Moreno', 'Lucía']),
      secrets: ['SpainBench2026!'],
      world: ['empleador secreto s.l.'],
      codes: new Map([['doc-1', ['A1B2C3D4E5F60718']]]),
    });
    const values = canaries.map((c) => c.value);
    expect(values).toEqual(
      expect.arrayContaining([
        'Lucía Moreno Castillo',
        'Moreno Castillo Lucía',
        '53918274H',
        '23/05/1991',
        'SpainBench2026!',
        'empleador secreto s.l.',
        'A1B2C3D4E5F60718',
      ]),
    );
    // Single surnames and first names are too common to tell a leak from a coincidence.
    expect(values).not.toContain('Moreno');
    expect(values).not.toContain('Lucía');
    expect(canaries.every((c) => c.strength === 'strong')).toBe(true);
  });

  it('names canaries by kind and number, never by value, and does not repeat one', () => {
    const canaries = buildCanaries({
      vault: fakeVault(PERSONA, ['53918274H', '53918274-H']),
      secrets: ['53918274H'],
      world: [],
      codes: new Map(),
    });
    for (const canary of canaries)
      expect(canary.id).toMatch(/^(name|vault|secret|world|code)-\d+$/);
    // The same value, however it is written, is one canary.
    expect(canaries.filter((c) => c.value.replace(/\W/g, '') === '53918274H')).toHaveLength(1);
    expect(new Set(canaries.map((c) => c.id)).size).toBe(canaries.length);
  });

  it('leaves out what is too short, and works with a vault that has no name yet', () => {
    const canaries = buildCanaries({
      vault: fakeVault({}, ['1234', 'ab']),
      secrets: ['1234'],
      world: ['xyz'],
      codes: new Map([['d', ['A1B2C3']]]),
    });
    // A verification code is shorter than a name or a number and still counts (six characters).
    expect(canaries.map((c) => c.value)).toEqual(['A1B2C3']);
  });

  it('is what the detector can find in a request', () => {
    const scanner = new CanaryScanner(
      buildCanaries({
        vault: fakeVault(PERSONA, ['53918274H']),
        secrets: [],
        world: [],
        codes: new Map(),
      }),
    );
    const hit = (url: string) =>
      scanner.scanParts([url]).filter((h) => h.kind === 'full' || h.kind === 'encoded');
    expect(hit('https://x.test/?dni=53918274H')).toHaveLength(1);
    expect(
      hit(`https://x.test/?q=${Buffer.from('LUCIA MORENO CASTILLO').toString('base64')}`).length,
    ).toBe(1);
    expect(hit('https://x.test/moreno')).toHaveLength(0);
  });

  it('excludes document issue and expiry dates but keeps document numbers and birth dates', () => {
    const personal = {
      ...PERSONA,
      birthDate: '1991-05-23',
      dniIssueDate: '2016-12-15',
      dniExpiry: '2026-12-15',
    };
    // Every spelling the vault lists for scrubbing (`sensitiveValues`).
    const spellings = (iso: string) => {
      const [y, m, d] = iso.split('-');
      return [iso, `${d}/${m}/${y}`, `${d}-${m}-${y}`, `${d}.${m}.${y}`, `${d}${m}${y}`];
    };
    const canaries = buildCanaries({
      vault: fakeVault(personal, [
        '53918274H',
        ...spellings('1991-05-23'),
        ...spellings('2016-12-15'),
        ...spellings('2026-12-15'),
      ]),
      secrets: [],
      world: [],
      codes: new Map(),
    });
    const values = canaries.map((c) => c.value);
    expect(values).toContain('53918274H');
    // A birth date stays, in each spelling the scanner tells apart.
    expect(values).toEqual(expect.arrayContaining(['1991-05-23', '23/05/1991']));
    for (const date of [...spellings('2016-12-15'), ...spellings('2026-12-15')]) {
      expect(values).not.toContain(date);
    }
  });

  it('leaves out custom notes (plain words, prose, one word) but keeps custom names, places and ids', () => {
    const personal = {
      ...PERSONA,
      'custom.dni-renewal-reason': 'caducidad',
      'custom.cita-preferencias': 'por la mañana, cualquier oficina',
      'custom.tasa-motivo':
        'Primera TIE de Katherine, por autorización inicial de residencia temporal.',
      'custom.titular-tasa': 'Katherine Joy Walker',
      'custom.zona-cita': 'Madrid ciudad',
      'custom.vehicle-tax-region': 'Andalucía',
      'custom.dni-soporte': 'BHK493072',
    };
    const custom = Object.entries(personal)
      .filter(([key]) => key.startsWith('custom.'))
      .map(([, value]) => value);
    const values = buildCanaries({
      vault: fakeVault(personal, ['53918274H', ...custom]),
      secrets: [],
      world: [],
      codes: new Map(),
    }).map((c) => c.value);
    expect(values).not.toContain('caducidad');
    expect(values).not.toContain('Andalucía');
    expect(values).not.toContain('por la mañana, cualquier oficina');
    expect(values).not.toContain(
      'Primera TIE de Katherine, por autorización inicial de residencia temporal.',
    );
    expect(values).toEqual(
      expect.arrayContaining(['Katherine Joy Walker', 'Madrid ciudad', 'BHK493072', '53918274H']),
    );
  });

  it('keeps a document date that another field also holds', () => {
    const personal = { ...PERSONA, birthDate: '2016-12-15', dniIssueDate: '2016-12-15' };
    const canaries = buildCanaries({
      vault: fakeVault(personal, ['2016-12-15']),
      secrets: [],
      world: [],
      codes: new Map(),
    });
    expect(canaries.map((c) => c.value)).toContain('2016-12-15');
  });
});
