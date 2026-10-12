import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { describeCertificate } from '../src/certinfo';
import {
  createTestIdentity,
  DEMO_IDENTITY_PASSPHRASE,
  loadClientCa,
  loadDemoIdentity,
} from '../src/identities';
import { readP12 } from '../src/pki';
import { validateDocumentId } from '../src/validation';

function chainsToClientCa(certPem: string): boolean {
  const ca = loadClientCa();
  const leaf = new X509Certificate(certPem);
  const intermediate = new X509Certificate(ca.intermediate.certPem);
  const root = new X509Certificate(ca.root.certPem);
  return (
    leaf.checkIssued(intermediate) &&
    leaf.verify(intermediate.publicKey) &&
    intermediate.checkIssued(root) &&
    intermediate.verify(root.publicKey)
  );
}

describe('createTestIdentity', () => {
  it('issues an FNMT-style certificate from the mock client CA', () => {
    const id = createTestIdentity({
      givenName: 'Juan',
      surname1: 'García',
      surname2: 'Pérez',
      dni: '12345678z',
      passphrase: 'secreto',
    });
    expect(id.commonName).toBe('GARCÍA PÉREZ JUAN - 12345678Z');
    expect(id.serialNumber).toBe('IDCES-12345678Z');
    const holder = describeCertificate(id.certPem);
    expect(holder).toMatchObject({
      dni: '12345678Z',
      givenName: 'JUAN',
      surname: 'GARCÍA PÉREZ',
      commonName: 'GARCÍA PÉREZ JUAN - 12345678Z',
      serialNumberAttribute: 'IDCES-12345678Z',
      issuerCommonName: 'AC MOCK-FNMT Usuarios',
    });
    expect(new X509Certificate(id.certPem).subject).toContain('C=ES');
    expect(chainsToClientCa(id.certPem)).toBe(true);
  });

  it('exports a .p12 that Node and forge both read (AES-256 by default, 3DES on request)', () => {
    for (const encryption of ['aes256', '3des'] as const) {
      const id = createTestIdentity({
        givenName: 'Ana',
        surname1: 'López',
        dni: 'X1234567L',
        passphrase: 'clave',
        encryption,
      });
      expect(() => createSecureContext({ pfx: id.p12, passphrase: 'clave' })).not.toThrow();
      const back = readP12(id.p12, 'clave');
      expect(back.certPem).toBe(id.certPem);
      expect(back.chainPem).toHaveLength(2);
    }
  });

  it('legacy RC2-40 files are rejected by Node/OpenSSL 3 but readable with forge', () => {
    const id = createTestIdentity({
      givenName: 'Luis',
      surname1: 'Martín',
      dni: '00000000T',
      passphrase: 'vieja',
      legacyEncryption: true,
    });
    expect(id.encryption).toBe('legacy-rc2-40');
    expect(() => createSecureContext({ pfx: id.p12, passphrase: 'vieja' })).toThrow(/Unsupported/i);
    expect(readP12(id.p12, 'vieja').certPem).toBe(id.certPem);
    expect(() => readP12(id.p12, 'otra')).toThrow(/MAC|password/i);
  });

  it('rejects an invalid DNI', () => {
    expect(() =>
      createTestIdentity({ givenName: 'X', surname1: 'Y', dni: '12345678A', passphrase: 'p' }),
    ).toThrow(/letra/);
  });

  it('can issue identities the sede does not trust', () => {
    const id = createTestIdentity({
      givenName: 'Eva',
      surname1: 'Ajena',
      dni: '11111111H',
      passphrase: 'p',
      issuer: 'untrusted',
    });
    expect(chainsToClientCa(id.certPem)).toBe(false);
  });
});

describe('demo identity fixture', () => {
  it('is "ESPAÑOLA ESPAÑOLA CARMEN - 99999999R" with passphrase 1234 and chains to the CA', () => {
    const demo = loadDemoIdentity();
    expect(DEMO_IDENTITY_PASSPHRASE).toBe('1234');
    expect(describeCertificate(demo.certPem).commonName).toBe(
      'ESPAÑOLA ESPAÑOLA CARMEN - 99999999R',
    );
    expect(() => createSecureContext({ pfx: demo.p12, passphrase: '1234' })).not.toThrow();
    expect(chainsToClientCa(demo.certPem)).toBe(true);
  });
});

describe('validateDocumentId', () => {
  it('checks DNI and NIE letters', () => {
    expect(validateDocumentId('99999999R')).toBeNull();
    expect(validateDocumentId('X1234567L')).toBeNull();
    expect(validateDocumentId('99999999A')).toMatch(/letra/);
    expect(validateDocumentId('1234')).toMatch(/DNI/);
  });
});
