import { createHash } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { describe, expect, it } from 'vitest';
import {
  createTestKeyProvider,
  parseHolder,
  pkcs12ToPem,
  readPkcs12,
  Vault,
  VaultError,
} from '../src/index';
import { writePkcs12 } from '../src/pkcs12';
import {
  ATTR,
  FIXTURE_NONASCII_PASSPHRASE,
  FIXTURE_PASSPHRASE,
  fixture,
  makeChain,
} from './helpers/certs';
import { tempVaultDir } from './helpers/tmp';

const isOpenSsl3 = /^3\./.test(process.versions.openssl ?? '');
const NOW = new Date('2026-10-03T12:00:00Z');

async function openVault(now = NOW) {
  return Vault.open(await tempVaultDir(), createTestKeyProvider('certs'), { now: () => now });
}

async function addFixture(vault: Vault, file: string, passphrase = FIXTURE_PASSPHRASE) {
  return vault.addCertificate({ fileName: file, p12: fixture(file), passphrase });
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(VaultError);
  return (error as VaultError).code;
}

describe('addCertificate', () => {
  it('extracts CertificateInfo from an FNMT-like RSA certificate', async () => {
    const vault = await openVault();
    const summary = await addFixture(vault, 'rsa-openssl3.p12');
    const leaf = (await readPkcs12(fixture('rsa-openssl3.p12'), FIXTURE_PASSPHRASE)).certificate;
    expect(summary).toEqual({
      id: summary.id,
      kind: 'certificate',
      label: 'Certificado de CARMEN ESPAÑOLA ESPAÑOLA',
      policy: 'ask',
      createdAt: NOW.toISOString(),
      certificate: {
        subject:
          'CN=ESPAÑOLA ESPAÑOLA CARMEN - 99999999R, GN=CARMEN, SN=ESPAÑOLA ESPAÑOLA, SERIALNUMBER=IDCES-99999999R, C=ES',
        issuer: 'CN=AC TEST USUARIOS, OU=CERES TEST, O=SPAINASSISTANT TEST, C=ES',
        serialNumber: '1A2B3C4D5E6F',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2046-01-01T00:00:00.000Z',
        holderName: 'CARMEN ESPAÑOLA ESPAÑOLA',
        holderId: '99999999R',
        fingerprint: createHash('sha256').update(leaf.raw).digest('hex'),
      },
    });
  });

  it.each([
    ['rsa-openssl3.p12', 'rsa', FIXTURE_PASSPHRASE],
    ['rsa-legacy-rc2.p12', 'rsa', FIXTURE_PASSPHRASE],
    ['rsa-pbmac1.p12', 'rsa', FIXTURE_PASSPHRASE],
    ['rsa-nonascii.p12', 'rsa', FIXTURE_NONASCII_PASSPHRASE],
    ['rsa-nonascii-legacy.p12', 'rsa', FIXTURE_NONASCII_PASSPHRASE],
    ['ec-p256-openssl3.p12', 'ec', FIXTURE_PASSPHRASE],
    ['ec-p384-legacy.p12', 'ec', FIXTURE_PASSPHRASE],
  ])('stores a normalized copy of %s that Node TLS accepts', async (file, keyType, passphrase) => {
    const vault = await openVault();
    const summary = await addFixture(vault, file, passphrase);
    const secret = await vault.getCredentialSecret(summary.id);
    if (secret.kind !== 'certificate') throw new Error('expected a certificate secret');
    expect(secret.passphrase).not.toBe(passphrase);
    expect(() =>
      createSecureContext({ pfx: secret.p12, passphrase: secret.passphrase }),
    ).not.toThrow();
    const normalized = await readPkcs12(secret.p12, secret.passphrase);
    expect(normalized.privateKey.asymmetricKeyType).toBe(keyType);
    expect(normalized.chain).toHaveLength(1);
    expect(createHash('sha256').update(normalized.certificate.raw).digest('hex')).toBe(
      summary.certificate?.fingerprint,
    );
  });

  it.runIf(isOpenSsl3)('normalizes legacy files that Node rejects as they are', async () => {
    for (const file of ['rsa-legacy-rc2.p12', 'ec-p384-legacy.p12']) {
      expect(() =>
        createSecureContext({ pfx: fixture(file), passphrase: FIXTURE_PASSPHRASE }),
      ).toThrow();
    }
  });

  it('parses EC (P-256) holder data', async () => {
    const vault = await openVault();
    const summary = await addFixture(vault, 'ec-p256-openssl3.p12');
    expect(summary.certificate).toMatchObject({
      holderName: 'JUAN MUESTRA SAMPLE',
      holderId: 'X1234567L',
      issuer: 'CN=AC TEST USUARIOS EC, O=SPAINASSISTANT TEST, C=ES',
    });
  });

  it('rejects wrong passphrases, expired certificates and non-certificates', async () => {
    const vault = await openVault();
    expect(await errorCode(addFixture(vault, 'rsa-openssl3.p12', 'wrong'))).toBe(
      'invalid_passphrase',
    );
    expect(await errorCode(addFixture(vault, 'rsa-legacy-rc2.p12', 'wrong'))).toBe(
      'invalid_passphrase',
    );
    expect(await errorCode(addFixture(vault, 'ec-p256-openssl3.p12', ''))).toBe(
      'invalid_passphrase',
    );
    expect(await errorCode(addFixture(vault, 'rsa-expired.p12'))).toBe('expired_certificate');
    expect(await errorCode(addFixture(vault, 'rsa-nokey.p12'))).toBe('invalid_certificate');
    expect(
      await errorCode(
        vault.addCertificate({ fileName: 'x.p12', p12: Buffer.from('hello'), passphrase: 'x' }),
      ),
    ).toBe('invalid_certificate');
    expect(
      await errorCode(
        vault.addCertificate({ fileName: 'x.p12', p12: Buffer.alloc(0), passphrase: 'x' }),
      ),
    ).toBe('invalid_certificate');
    expect(vault.listCredentials()).toEqual([]);
  });

  it('checks validity against the clock', async () => {
    const later = await openVault(new Date('2046-06-01T00:00:00Z'));
    expect(await errorCode(addFixture(later, 'rsa-openssl3.p12'))).toBe('expired_certificate');
    const earlier = await openVault(new Date('2025-06-01T00:00:00Z'));
    expect(await errorCode(addFixture(earlier, 'rsa-openssl3.p12'))).toBe('invalid_certificate');
  });

  it('does not store the same certificate twice', async () => {
    const vault = await openVault();
    const first = await addFixture(vault, 'rsa-openssl3.p12');
    const again = await addFixture(vault, 'rsa-legacy-rc2.p12'); // same leaf, other encoding
    expect(again.id).toBe(first.id);
    expect(vault.listCredentials()).toHaveLength(1);
  });

  it('accepts a custom label and survives reopening', async () => {
    const dir = await tempVaultDir();
    const vault = await Vault.open(dir, createTestKeyProvider('certs'));
    const summary = await vault.addCertificate({
      fileName: 'C:\\certs\\fnmt.pfx',
      p12: new Uint8Array(fixture('ec-p256-openssl3.p12')),
      passphrase: FIXTURE_PASSPHRASE,
      label: 'Mi certificado',
    });
    expect(summary.label).toBe('Mi certificado');
    const reopened = await Vault.open(dir, createTestKeyProvider('certs'));
    const secret = await reopened.getCredentialSecret(summary.id);
    expect(secret.kind).toBe('certificate');
    expect(reopened.getCredential(summary.id)).toEqual(summary);
  });

  it('handles generated RSA/EC certificates without GN/SN', async () => {
    for (const kind of ['rsa', 'ec384'] as const) {
      const { ca, leaf, key } = makeChain(kind, {
        subject: [
          [ATTR.C, 'ES'],
          [ATTR.CN, 'NOMBRE ESPAÑOLA ESPAÑOLA CARMEN - NIF 99999999R'],
        ],
      });
      const p12 = await writePkcs12({
        privateKey: key.privateKey,
        certificate: leaf,
        chain: [ca],
        passphrase: 'clave',
        keyEncryption: 'pbe-sha1-3des',
        certEncryption: 'pbe-sha1-rc2-40',
        mac: 'sha1',
      });
      const vault = await Vault.open(await tempVaultDir(), createTestKeyProvider('certs'));
      const summary = await vault.addCertificate({ fileName: 'c.p12', p12, passphrase: 'clave' });
      expect(summary.certificate).toMatchObject({
        holderName: 'ESPAÑOLA ESPAÑOLA CARMEN',
        holderId: '99999999R',
      });
    }
  });
});

describe('pkcs12ToPem', () => {
  it('exports PEM key, certificate and chain', async () => {
    const pem = await pkcs12ToPem(fixture('ec-p256-openssl3.p12'), FIXTURE_PASSPHRASE);
    expect(pem.key).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(pem.cert).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(pem.ca).toHaveLength(1);
    expect(() => createSecureContext({ key: pem.key, cert: pem.cert })).not.toThrow();
  });
});

describe('parseHolder', () => {
  const dn = (...attrs: Array<[string, string]>) =>
    attrs.map(([name, value]) => [{ oid: '', name, value }]);

  it.each([
    [
      'current FNMT persona física',
      dn(
        ['C', 'ES'],
        ['SERIALNUMBER', 'IDCES-99999999R'],
        ['SN', 'ESPAÑOLA ESPAÑOLA'],
        ['GN', 'CARMEN'],
        ['CN', 'ESPAÑOLA ESPAÑOLA CARMEN - 99999999R'],
      ),
      { holderName: 'CARMEN ESPAÑOLA ESPAÑOLA', holderId: '99999999R' },
    ],
    [
      'CN only',
      dn(['CN', 'ESPAÑOLA ESPAÑOLA CARMEN - 99999999R']),
      { holderName: 'ESPAÑOLA ESPAÑOLA CARMEN', holderId: '99999999R' },
    ],
    [
      'older FNMT Clase 2',
      dn(['CN', 'NOMBRE ESPAÑOLA ESPAÑOLA CARMEN - NIF 99999999R']),
      { holderName: 'ESPAÑOLA ESPAÑOLA CARMEN', holderId: '99999999R' },
    ],
    [
      'representative',
      dn(['SERIALNUMBER', 'IDCES-99999999R'], ['CN', '99999999R CARMEN ESPAÑOLA (R: B12345678)']),
      { holderName: 'CARMEN ESPAÑOLA', holderId: '99999999R' },
    ],
    [
      'NIE holder',
      dn(['SERIALNUMBER', 'IDCES-X1234567L'], ['CN', 'SAMPLE JOHN - X1234567L']),
      { holderName: 'SAMPLE JOHN', holderId: 'X1234567L' },
    ],
    [
      'passport-based identifier',
      dn(['SERIALNUMBER', 'PASDE-C01X00T47'], ['CN', 'MUSTERMANN ERIKA']),
      { holderName: 'MUSTERMANN ERIKA', holderId: 'C01X00T47' },
    ],
    ['invalid DNI letter', dn(['CN', 'PEREZ JUAN - 99999999A']), { holderName: 'PEREZ JUAN' }],
  ])('%s', (_label, subject, expected: { holderName?: string; holderId?: string }) => {
    const holder = parseHolder(subject);
    expect(holder.holderName).toBe(expected.holderName);
    expect(holder.holderId).toBe(expected.holderId);
  });
});
