import { describe, expect, it } from 'vitest';
import { activityLabel } from './activity';

describe('activityLabel', () => {
  it('names the DNI, not a certificate, when browser_use_certificate uses it', () => {
    const credentialKind = (id: string) => (id === 'c-dni' ? 'dnie' : 'certificate');
    const label = (credentialId: string, lang: 'es' | 'en') =>
      activityLabel('browser_use_certificate', { credentialId }, { lang, credentialKind }).text;
    expect(label('c-dni', 'es')).toBe('Preparando tu DNI');
    expect(label('c-dni', 'en')).toBe('Getting your DNI ready');
    expect(label('c-p12', 'es')).toBe('Preparando tu certificado digital');
  });
});
