import { describe, expect, it } from 'vitest';
import { CERTIFICATE_ORIGINS, certificateHosts, normalizeOrigin } from '../src/certificates';
import { BrowserError } from '../src/errors';

describe('certificate origins', () => {
  it('lists exact https origins of the hosts that ask for certificates', () => {
    expect(CERTIFICATE_ORIGINS).toContain('https://pasarela-ident.clave.gob.es');
    expect(CERTIFICATE_ORIGINS).toContain('https://www1.agenciatributaria.gob.es');
    expect(CERTIFICATE_ORIGINS).toContain('https://w2.seg-social.es');
    for (const o of CERTIFICATE_ORIGINS) expect(normalizeOrigin(o)).toBe(o);
    expect(Object.isFrozen(CERTIFICATE_ORIGINS)).toBe(true);
  });

  it('normalizes origins and rejects non-https ones', () => {
    expect(normalizeOrigin('https://www1.agenciatributaria.gob.es/wlpl/x?y=1')).toBe(
      'https://www1.agenciatributaria.gob.es',
    );
    expect(normalizeOrigin('https://localhost:443')).toBe('https://localhost');
    expect(normalizeOrigin('https://localhost:9443/')).toBe('https://localhost:9443');
    expect(() => normalizeOrigin('http://sede.gob.es')).toThrow(BrowserError);
    expect(() => normalizeOrigin('nope')).toThrow(/Invalid certificate origin/);
  });

  it('turns origins into the sidecar host:port form, without duplicates', () => {
    expect(
      certificateHosts([
        'https://pasarela-ident.clave.gob.es/x',
        'https://pasarela-ident.clave.gob.es',
        'https://localhost:9443',
      ]),
    ).toEqual(['pasarela-ident.clave.gob.es:443', 'localhost:9443']);
  });
});
