import { SPANISH_PROVINCES } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { filterProvinces } from './provinceSearch';

describe('province search', () => {
  it('offers the full list for an empty search', () => {
    expect(filterProvinces('  ')).toEqual(SPANISH_PROVINCES);
  });

  it('ignores accents and case for partial names', () => {
    expect(filterProvinces('  MALAG  ').map((p) => p.value)).toEqual(['Málaga']);
    expect(filterProvinces('coru').map((p) => p.value)).toEqual(['A Coruña']);
  });

  it('matches co-official names, aliases and province codes', () => {
    for (const [query, value] of [
      ['araba', 'Álava'],
      ['VIZCAYA', 'Bizkaia'],
      ['la coruna', 'A Coruña'],
      ['lerida', 'Lleida'],
      ['28', 'Madrid'],
    ]) {
      expect(filterProvinces(query).map((p) => p.value)).toEqual([value]);
    }
  });

  it('returns no options for unmatched text', () => {
    expect(filterProvinces('Atlantis')).toEqual([]);
  });
});
