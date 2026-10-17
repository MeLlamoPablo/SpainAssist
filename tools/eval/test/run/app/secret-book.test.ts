import { describe, expect, it } from 'vitest';
import { secretSpellings } from '../../../src/llm/redact';
import { LeakLog, MASK, SecretBook } from '../../../src/run/app/secrets';

const PASSWORD = 'Zorro-Azul 2026!';

describe('SecretBook', () => {
  it('masks a secret in every spelling it can have in a URL, a form, JSON or HTML', () => {
    const book = new SecretBook();
    book.add(PASSWORD);
    for (const spelling of secretSpellings(PASSWORD)) {
      expect(book.mask(`antes ${spelling} después`)).toBe(`antes ${MASK} después`);
    }
    expect(secretSpellings(PASSWORD)).toEqual(
      expect.arrayContaining([
        PASSWORD,
        'Zorro-Azul%202026!',
        'Zorro-Azul+2026!',
        'Zorro-Azul+2026%21',
      ]),
    );
    expect(book.mask('nada que ocultar')).toBe('nada que ocultar');
  });

  it('ignores what is too short to mask without destroying ordinary text', () => {
    const book = new SecretBook();
    book.add('abc');
    book.add(undefined);
    book.add(null);
    expect(book.size).toBe(0);
    expect(book.mask('abc')).toBe('abc');
    expect(book.leaksIn(['abc'])).toBe(false);
  });

  it('finds a secret plainly written, in another spelling or hidden by an encoding', () => {
    const book = new SecretBook();
    book.add(PASSWORD);
    expect(book.leaksIn(['la clave es Zorro-Azul 2026!'])).toBe(true);
    expect(book.leaksIn(['https://x.test/?p=Zorro-Azul%202026%21'])).toBe(true);
    expect(book.leaksIn([`{"p":${JSON.stringify(PASSWORD)}}`])).toBe(true);
    expect(book.leaksIn([`data=${Buffer.from(PASSWORD).toString('base64')}`])).toBe(true);
    expect(book.leaksIn([`h=${Buffer.from(PASSWORD).toString('hex')}`])).toBe(true);
    expect(book.leaksIn(['Zorro Azul']).valueOf()).toBe(false);
    expect(book.leaksIn(['una página cualquiera', 'otra'])).toBe(false);
  });

  it('does not decode what it scans for a short secret (a decoded token would hit by chance)', () => {
    const book = new SecretBook();
    book.add('123456');
    expect(book.leaksIn(['código 123456 recibido'])).toBe(true);
    // The spellings of the secret are found; text that merely decodes to it (base64 of a longer
    // blob that contains it, a different alignment of the encoding) is not looked for.
    expect(book.leaksIn([`x=${Buffer.from('a 123456 b').toString('base64')}`])).toBe(false);
  });

  it('counts what a log scrub masked, per call of takeHits', () => {
    const book = new SecretBook();
    book.add(PASSWORD);
    const masker = book.masker();
    expect(masker.scrub('sin nada')).toBe('sin nada');
    expect(masker.takeHits()).toBe(0);
    masker.scrub(`a ${PASSWORD}`);
    masker.scrub('b');
    masker.scrub(`c ${PASSWORD}`);
    expect(masker.takeHits()).toBe(2);
    expect(masker.takeHits()).toBe(0);
    // A secret registered later is masked from then on.
    book.add('otro-secreto-largo');
    expect(masker.scrub('x otro-secreto-largo')).toBe(`x ${MASK}`);
  });
});

describe('LeakLog', () => {
  it('keeps where a secret showed up, never the secret, once per carrier', () => {
    const book = new SecretBook();
    book.add(PASSWORD);
    const leaks = new LeakLog(book);
    expect(leaks.check('message of assistant', ['hola'])).toBe(false);
    expect(leaks.check('message of assistant', [`clave: ${PASSWORD}`])).toBe(true);
    expect(leaks.check('message of assistant', [`clave: ${PASSWORD}`])).toBe(true);
    leaks.note('request GET x.test (browser)', `https://x.test/?p=${encodeURIComponent(PASSWORD)}`);
    expect(leaks.list()).toEqual([
      `message of assistant: clave: ${MASK}`,
      `request GET x.test (browser): https://x.test/?p=${MASK}`,
    ]);
    expect(leaks.list().join()).not.toContain('Zorro');
  });

  it('cuts what it keeps', () => {
    const book = new SecretBook();
    book.add(PASSWORD);
    const leaks = new LeakLog(book);
    leaks.check('result of fetch_url', [`${'x'.repeat(2000)} ${PASSWORD}`]);
    expect(leaks.list()[0]?.length).toBeLessThan(600);
  });
});
