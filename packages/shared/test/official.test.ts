import { describe, expect, it } from 'vitest';
import { credentialAllowedOn, hostMatchesSuffix, OFFICIAL_DOMAINS } from '../src/official';

describe('official domains', () => {
  it('has unique, lowercase, bare suffixes', () => {
    const suffixes = OFFICIAL_DOMAINS.map((d) => d.suffix);
    expect(new Set(suffixes).size).toBe(suffixes.length);
    for (const s of suffixes) expect(s).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });

  it('matches on label boundaries only', () => {
    expect(hostMatchesSuffix('rocafort.sede.dival.es', 'dival.es')).toBe(true);
    expect(hostMatchesSuffix('DIVAL.ES.', 'dival.es')).toBe(true);
    expect(hostMatchesSuffix('evildival.es', 'dival.es')).toBe(false);
    expect(hostMatchesSuffix('dival.es.evil.com', 'dival.es')).toBe(false);
  });

  it('lets certificates and the DNIe log in to municipal and provincial sedes', () => {
    for (const url of [
      'https://rocafort.sede.dival.es/',
      'https://sede.madrid.es/portal/site/tramites',
      'https://seuelectronica.ajuntament.barcelona.cat/',
      'https://sede.murcia.es/',
      'https://sedeelectronica.laspalmasgc.es/',
      'https://sede.aytojaen.es/',
      'https://sede.teruel.es/',
      'https://albacete.sedipualba.es/',
    ]) {
      expect(credentialAllowedOn('certificate', url), url).toBe(true);
      expect(credentialAllowedOn('dnie', url), url).toBe(true);
    }
  });

  it('denies lookalikes, plain http and other hosts', () => {
    for (const url of [
      'https://dival.es.evil.com/',
      'https://sede-dival.es/',
      'https://evilmadrid.es/',
      'http://rocafort.sede.dival.es/',
      'https://example.com/',
      'not a url',
    ]) {
      expect(credentialAllowedOn('certificate', url), url).toBe(false);
      expect(credentialAllowedOn('dnie', url), url).toBe(false);
    }
  });

  it('keeps Cl@ve credentials on the Cl@ve gateway, not on municipal sedes', () => {
    expect(credentialAllowedOn('clave_permanente', 'https://pasarela.clave.gob.es/')).toBe(true);
    expect(credentialAllowedOn('clave_permanente', 'https://rocafort.sede.dival.es/')).toBe(false);
    expect(credentialAllowedOn('clave_movil', 'https://sede.madrid.es/')).toBe(false);
  });
});
