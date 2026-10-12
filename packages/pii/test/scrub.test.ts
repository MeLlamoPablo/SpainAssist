import { describe, expect, it } from 'vitest';
import { DEFAULT_PLACEHOLDERS, detectPii, PII_TYPES, scrubPii, stripUrlParams } from '../src/index';

const SAMPLE = `Hola, soy Pablo Rodríguez Caballero (DNI 12.345.678-Z, NIE X1234567L). Mi email es pablo.rc@example.es y mi móvil +34 612 34 56 78; fijo 91 123 45 67.
Vivo en C/ Mayor 12, 3º B, 28013 Madrid. IBAN ES91 2100 0418 4502 0005 1332. Nº afiliación SS 281234567840. Fecha de nacimiento: 03/04/1985.
Pasaporte PAA123456, matrícula del coche 1234 BCD. La empresa B12345674 me cobró. Ref. catastral 9872023VH5797S0001WX. Tarjeta 4111 1111 1111 1111.
Plazo: 10 días hábiles desde el 30/06/2026; Ley 39/2015; expediente 2026/000123; código SIA 110340; cita a las 9:00; 28 euros.`;

describe('scrubPii', () => {
  it('scrubs the reference sample', () => {
    const { text, findings } = scrubPii(SAMPLE, { knownValues: ['Pablo', 'Rodríguez Caballero'] });
    expect(
      text,
    ).toBe(`Hola, soy [DATO PERSONAL] (DNI [DNI], NIE [NIE]). Mi email es [EMAIL] y mi móvil [TELÉFONO]; fijo [TELÉFONO].
Vivo en [DIRECCIÓN], [CÓDIGO POSTAL] Madrid. IBAN [IBAN]. Nº afiliación SS [NUSS]. Fecha de nacimiento: [FECHA DE NACIMIENTO].
Pasaporte [PASAPORTE], matrícula del coche [MATRÍCULA]. La empresa [CIF] me cobró. Ref. catastral [REF. CATASTRAL]. Tarjeta [TARJETA].
Plazo: 10 días hábiles desde el 30/06/2026; Ley 39/2015; expediente [REFERENCIA]; código SIA 110340; cita a las 9:00; 28 euros.`);
    expect(findings).toHaveLength(17);
    for (const f of findings) expect(f).not.toHaveProperty('match');
  });

  it('is idempotent', () => {
    const once = scrubPii(SAMPLE, { knownValues: ['Pablo', 'Rodríguez Caballero'] }).text;
    expect(scrubPii(once, { knownValues: ['Pablo', 'Rodríguez Caballero'] })).toEqual({
      text: once,
      findings: [],
    });
  });

  it('returns findings with offsets into the original text', () => {
    const text = 'DNI 12345678Z y email a@b.es';
    for (const f of detectPii(text)) expect(text.slice(f.start, f.end)).toBe(f.match);
  });

  it('honours allow and custom placeholders', () => {
    const text = 'C/ Mayor 5, 28013 Madrid, tel 612345678';
    expect(scrubPii(text, { allow: ['postal_code', 'phone'] }).text).toBe(
      '[DIRECCIÓN], 28013 Madrid, tel 612345678',
    );
    expect(scrubPii(text, { placeholder: (t) => `<${t}>` }).text).toBe(
      '<address>, <postal_code> Madrid, tel <phone>',
    );
  });

  it('has a placeholder for every type', () => {
    for (const t of PII_TYPES) expect(typeof DEFAULT_PLACEHOLDERS[t]).toBe('string');
  });

  it('returns the text unchanged when there is nothing to scrub', () => {
    expect(scrubPii('')).toEqual({ text: '', findings: [] });
    expect(scrubPii('Pide cita previa en la sede.')).toEqual({
      text: 'Pide cita previa en la sede.',
      findings: [],
    });
  });
});

describe('overlapping findings', () => {
  it('drops an email that sits inside a URL query', () => {
    expect(scrubPii('ver https://x.gob.es/a?email=pablo@x.es ahora').text).toBe(
      'ver https://x.gob.es/a ahora',
    );
  });

  it('labels a known value inside an address as the address', () => {
    expect(scrubPii('Vivo en C/ Mayor 5, 3ºB', { knownValues: ['Mayor'] }).text).toBe(
      'Vivo en [DIRECCIÓN]',
    );
  });

  it('prefers the specific type when a known value is also a DNI', () => {
    expect(scrubPii('DNI 12345678Z', { knownValues: ['12345678Z'] }).text).toBe('DNI [DNI]');
  });

  it('keeps the whole phone when a known value covers part of it', () => {
    expect(scrubPii('móvil +34 612 34 56 78', { knownValues: ['612345678'] }).text).toBe(
      'móvil [TELÉFONO]',
    );
  });

  it('merges partially overlapping findings into their union', () => {
    const findings = detectPii('Juan Carlos Pérez llegó', {
      knownValues: ['Juan Carlos', 'Carlos Pérez'],
    });
    expect(findings).toEqual([
      { type: 'known_value', start: 0, end: 17, match: 'Juan Carlos Pérez' },
    ]);
  });

  it('keeps separate findings separate', () => {
    expect(scrubPii('612345678 612345679').text).toBe('[TELÉFONO] [TELÉFONO]');
  });
});

describe('stripUrlParams', () => {
  it.each([
    ['https://x.gob.es/a?id=1#b', 'https://x.gob.es/a'],
    ['https://x.gob.es/a#paso-2', 'https://x.gob.es/a'],
    ['https://x.gob.es/a?', 'https://x.gob.es/a'],
    ['https://sede.x.gob.es/proc;jsessionid=ABC123?x=1', 'https://sede.x.gob.es/proc'],
    ['https://user:pass@x.es/a?q=1', 'https://x.es/a'],
    ['https://x.es/', 'https://x.es/'],
    ['  https://x.es/a  ', 'https://x.es/a'],
  ])('%s -> %s', (url, expected) => expect(stripUrlParams(url)).toBe(expected));
});
