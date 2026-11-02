import { importCertificate } from '@sa/vault';
import { describe, expect, it } from 'vitest';
import { drawCertificate, renderCertificate } from '../../src/documents/certificate';

const SPEC = {
  givenName: 'LUCÍA',
  surnames: 'SERRANO PASCUAL',
  nif: '53928471A',
  notBefore: '2025-03-10',
  notAfter: '2029-03-10',
};

describe('a persona certificate', () => {
  it('is the same certificate every time, and the vault imports it as an FNMT-like one of its holder', async () => {
    const first = renderCertificate(SPEC);
    expect(first.fileName).toBe('SERRANO_PASCUAL_LUCÍA.p12');
    const now = new Date('2026-11-02');
    const imported = await importCertificate(first.p12, first.passphrase, now);
    // Drawn again without the cache: the same key and certificate (the .p12's own salts differ,
    // and the vault encrypts it again anyway).
    const again = drawCertificate(SPEC);
    const reimported = await importCertificate(again.p12, again.passphrase, now);
    expect(reimported.info.fingerprint).toBe(imported.info.fingerprint);

    expect(imported.info.holderName).toBe('LUCÍA SERRANO PASCUAL');
    expect(imported.info.holderId).toBe(SPEC.nif);
    expect(imported.info.validTo.slice(0, 10)).toBe(SPEC.notAfter);
    expect(imported.info.issuer).toMatch(/AC FNMT Usuarios/);
  }, 30_000);
});
