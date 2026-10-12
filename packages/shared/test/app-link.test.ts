import { describe, expect, it } from 'vitest';
import { parseAppLink } from '../src/app-link';

describe('parseAppLink', () => {
  it('parses every target', () => {
    expect(parseAppLink('sa:procedures')).toEqual({ kind: 'procedures' });
    expect(parseAppLink('sa:procedure/p_0123456789abcdef')).toEqual({
      kind: 'procedure',
      id: 'p_0123456789abcdef',
    });
    expect(parseAppLink('sa:document/0f8b3c2e-6a1d-4f7e-9b2a-5c4d3e2f1a0b')).toEqual({
      kind: 'document',
      id: '0f8b3c2e-6a1d-4f7e-9b2a-5c4d3e2f1a0b',
    });
    expect(parseAppLink('sa:vault/documents')).toEqual({ kind: 'vault', tab: 'documents' });
    expect(parseAppLink('sa:vault/personal')).toEqual({ kind: 'vault', tab: 'personal' });
    expect(parseAppLink('sa:vault/credentials')).toEqual({ kind: 'vault', tab: 'credentials' });
    expect(parseAppLink('sa:settings')).toEqual({ kind: 'settings' });
  });

  it('rejects anything else', () => {
    for (const href of [
      undefined,
      '',
      'https://sede.example.gob.es',
      'sa:',
      'sa:vault',
      'sa:vault/passwords',
      'sa:procedure',
      'sa:procedure/../x',
      'sa:procedure/a/b',
      'sa:document',
      'sa:document/',
      'sa:document/../x',
      'sa:document/a/b',
      'sa:document/a b',
      `sa:document/${'x'.repeat(65)}`,
      'sa:settings/about',
      'sa:procedures/x',
      'sa:unknown',
    ]) {
      expect(parseAppLink(href)).toBeNull();
    }
  });
});
