import { describe, expect, it } from 'vitest';
import {
  matchPersonalOption,
  PERSONAL_FIELDS,
  PersonalFieldOption,
  parsePersonalDate,
  personalFieldDef,
} from '../src';

describe('personal select fields', () => {
  it('have valid, unique options', () => {
    for (const def of PERSONAL_FIELDS.filter((f) => f.input === 'select')) {
      expect(def.options?.length, def.key).toBeGreaterThan(0);
      for (const option of def.options ?? []) PersonalFieldOption.parse(option);
      const values = def.options?.map((o) => o.value) ?? [];
      expect(new Set(values).size, def.key).toBe(values.length);
    }
  });

  it('match options by key, label or alias, ignoring case and accents', () => {
    const def = personalFieldDef('maritalStatus')!;
    expect(matchPersonalOption(def, 'Viúdo')?.value).toBe('widowed');
    expect(matchPersonalOption(def, 'soltero/a')?.value).toBe('single');
    expect(matchPersonalOption(def, 'Legally  separated')?.value).toBe('separated');
    expect(matchPersonalOption(def, 'pareja de hecho')).toBeUndefined();
    expect(matchPersonalOption(def, '')).toBeUndefined();
  });
});

describe('personal date fields', () => {
  it('read ISO and Spanish day-first dates as ISO', () => {
    expect(parsePersonalDate('2026-12-04')).toBe('2026-12-04');
    expect(parsePersonalDate(' 04/12/2026 ')).toBe('2026-12-04');
    expect(parsePersonalDate('4/1/2026')).toBe('2026-01-04');
    expect(parsePersonalDate('04-12-2026')).toBe('2026-12-04');
    expect(parsePersonalDate('04.12.2026')).toBe('2026-12-04');
    expect(parsePersonalDate('29/02/2028')).toBe('2028-02-29');
  });

  it('refuse impossible days and other forms', () => {
    for (const text of [
      '31/02/2026',
      '29/02/2026',
      '2026-13-01',
      '04/12/26',
      '04/12.2026',
      '12/2026',
      '',
    ])
      expect(parsePersonalDate(text), text).toBeUndefined();
  });
});
