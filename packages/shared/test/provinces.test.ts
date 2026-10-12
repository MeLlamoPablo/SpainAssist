import { describe, expect, it } from 'vitest';
import { matchProvince, postalCodeProvince, SPANISH_PROVINCES } from '../src/provinces';

describe('Spanish provinces', () => {
  it('lists the 50 provinces plus Ceuta and Melilla, with unique INE codes', () => {
    expect(SPANISH_PROVINCES).toHaveLength(52);
    expect(new Set(SPANISH_PROVINCES.map((p) => p.code)).size).toBe(52);
  });

  it('matches names, co-official names, old spellings and codes', () => {
    expect(matchProvince('Madrid')?.value).toBe('Madrid');
    expect(matchProvince('  alacant ')?.value).toBe('Alicante');
    expect(matchProvince('Islas Baleares')?.value).toBe('Illes Balears');
    expect(matchProvince('provincia de Lérida')?.value).toBe('Lleida');
    expect(matchProvince('Alava')?.value).toBe('Álava');
    expect(matchProvince('08')?.value).toBe('Barcelona');
    expect(matchProvince('Narnia')).toBeUndefined();
  });

  it('finds the province of a postal code from its first two digits', () => {
    expect(postalCodeProvince('28013')?.value).toBe('Madrid');
    expect(postalCodeProvince('01001')?.value).toBe('Álava');
    expect(postalCodeProvince('52001')?.value).toBe('Melilla');
  });

  it('rejects postal codes without a province prefix or five digits', () => {
    for (const code of ['00123', '53001', '99999', '2801', '280133', '28O13'])
      expect(postalCodeProvince(code), code).toBeUndefined();
  });
});
