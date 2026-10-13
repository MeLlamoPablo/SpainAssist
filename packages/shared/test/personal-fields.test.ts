import { describe, expect, it } from 'vitest';
import {
  matchPersonalOption,
  PERSONAL_FIELDS,
  PersonalFieldOption,
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
