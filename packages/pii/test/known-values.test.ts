import { describe, expect, it } from 'vitest';
import { detectPii, knownValueKeys, scrubPii } from '../src/index';

const scrub = (text: string, knownValues: string[], allow: Parameters<typeof scrubPii>[1] = {}) =>
  scrubPii(text, { knownValues, ...allow }).text;

describe('known values', () => {
  it('matches whole words only', () => {
    expect(scrub('Mañana Ana irá a la oficina.', ['Ana'])).toBe(
      'Mañana [DATO PERSONAL] irá a la oficina.',
    );
    expect(scrub('Hola, soy ANA.', ['Ana'])).toBe('Hola, soy [DATO PERSONAL].');
    expect(scrub('Josefa y Joseba', ['José'])).toBe('Josefa y Joseba');
  });

  it('ignores case, accents and whitespace', () => {
    expect(scrub('MARIA  JOSE vino; maria jose también', ['María José'])).toBe(
      '[DATO PERSONAL] vino; [DATO PERSONAL] también',
    );
    expect(scrub('Rodriguez\nCaballero', ['Rodríguez Caballero'])).toBe('[DATO PERSONAL]');
  });

  it('ignores values shorter than 3 characters', () => {
    expect(scrub('Al final, J. firmó', ['Al', 'J.'])).toBe('Al final, J. firmó');
    expect(knownValueKeys('Al')).toEqual([]);
  });

  it('ignores generic categorical values', () => {
    expect(scrub('Renovar el DNI en España siendo soltera', ['DNI', 'España', 'soltera'])).toBe(
      'Renovar el DNI en España siendo soltera',
    );
  });

  it('matches identifiers written with other separators', () => {
    // allow: the pattern layer would catch these too; check the known-value layer alone
    expect(scrub('DNI 12 345 678-z', ['12345678Z'], { allow: ['dni'] })).toBe(
      'DNI [DATO PERSONAL]',
    );
    expect(scrub('lo envié sin letra: 12345678', ['12345678Z'], { allow: ['dni'] })).toBe(
      'lo envié sin letra: [DATO PERSONAL]',
    );
    expect(scrub('llámame al 612 34 56 78', ['+34 612 345 678'], { allow: ['phone'] })).toBe(
      'llámame al [DATO PERSONAL]',
    );
    expect(
      scrub('cuenta 2100 0418 45 0200051332', ['ES91 2100 0418 4502 0005 1332'], {
        allow: ['ccc'],
      }),
    ).toBe('cuenta [DATO PERSONAL]');
  });

  it('matches dates in other spellings', () => {
    const opts = { allow: ['date_of_birth' as const] };
    expect(scrub('el 03/04/1985 y el 3 de abril de 1985', ['1985-04-03'], opts)).toBe(
      'el [DATO PERSONAL] y el [DATO PERSONAL]',
    );
  });

  it('catches the user address even when the pattern layer would not', () => {
    expect(scrub('vivo en calle mayor 5 3ºb', ['Calle Mayor 5, 3ºB'])).toBe(
      'vivo en [DATO PERSONAL]',
    );
  });

  it('reports offsets into the original text, also for decomposed (NFD) input', () => {
    const text = 'Hola José, mañana vienes';
    const [f, ...rest] = detectPii(text, { knownValues: ['José', 'Ana'] });
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ type: 'known_value', match: 'José' });
    expect(text.slice(f!.start, f!.end)).toBe('José');
  });

  it('joins adjacent name parts into one redaction', () => {
    expect(scrub('Soy Pablo Rodríguez Caballero.', ['Pablo', 'Rodríguez', 'Caballero'])).toBe(
      'Soy [DATO PERSONAL].',
    );
  });

  it('skips non-string values defensively', () => {
    expect(scrub('Hola Ana', ['Ana', undefined as unknown as string])).toBe('Hola [DATO PERSONAL]');
  });
});
