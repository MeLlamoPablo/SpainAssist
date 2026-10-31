import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestKeyProvider, readPkcs12, Vault, VaultError } from '../src/index';
import { parseState } from '../src/state';
import { FIXTURE_PASSPHRASE, fixture } from './helpers/certs';
import { tempVaultDir } from './helpers/tmp';

const NOW = new Date('2026-10-03T12:00:00Z');

async function fnmtLike() {
  const contents = await readPkcs12(fixture('rsa-openssl3.p12'), FIXTURE_PASSPHRASE);
  const spki = contents.privateKey.export({ type: 'pkcs8', format: 'der' });
  const publicKey = contents.certificate.publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey: spki,
    publicKeyHash: createHash('sha256').update(publicKey).digest('base64url'),
    certificates: [contents.certificate.raw, ...contents.chain.map((c) => c.raw)],
  };
}

describe('FNMT certificate requests', () => {
  it('keeps a pending key across reopenings and turns it into a certificate credential', async () => {
    const dir = await tempVaultDir();
    const keys = createTestKeyProvider('requests');
    const issued = await fnmtLike();
    let vault = await Vault.open(dir, keys, { now: () => NOW });
    const pending = await vault.addCertificateRequest({
      publicKeyHash: issued.publicKeyHash,
      privateKey: issued.privateKey,
      keyDescription: 'rsa 2048',
      origin: 'https://apus20.sede.fnmt.gob.es',
      procedureId: 'proc-1',
    });
    expect(pending).toEqual({
      id: pending.id,
      publicKeyHash: issued.publicKeyHash,
      keyDescription: 'rsa 2048',
      origin: 'https://apus20.sede.fnmt.gob.es',
      procedureId: 'proc-1',
      createdAt: NOW.toISOString(),
    });
    expect(JSON.stringify(vault.listCertificateRequests())).not.toContain(
      issued.privateKey.toString('base64').slice(0, 40),
    );

    // The identity check takes days: the key must survive the app closing.
    vault = await Vault.open(dir, keys, { now: () => NOW });
    expect(vault.findCertificateRequest(issued.publicKeyHash)).toEqual(pending);
    const key = await vault.getCertificateRequestKey(pending.id);
    expect(key.equals(issued.privateKey)).toBe(true);

    const credential = await vault.addCertificateFromKey({
      privateKey: key,
      certificates: issued.certificates,
      fileName: 'FNMT',
    });
    expect(credential.kind).toBe('certificate');
    expect(credential.label).toBe('Certificado de CARMEN ESPAÑOLA ESPAÑOLA');
    const secret = await vault.getCredentialSecret(credential.id);
    if (secret.kind !== 'certificate') throw new Error('unexpected');
    const stored = await readPkcs12(secret.p12, secret.passphrase);
    expect(stored.chain).toHaveLength(issued.certificates.length - 1);

    // The same certificate again: the existing credential.
    const again = await vault.addCertificateFromKey({
      privateKey: key,
      certificates: issued.certificates,
      fileName: 'FNMT',
    });
    expect(again.id).toBe(credential.id);

    await vault.deleteCertificateRequest(pending.id);
    expect(vault.listCertificateRequests()).toEqual([]);
    await expect(vault.deleteCertificateRequest(pending.id)).rejects.toBeInstanceOf(VaultError);
  });

  it('refuses a certificate that does not match the key', async () => {
    const vault = await Vault.open(await tempVaultDir(), createTestKeyProvider('mismatch'), {
      now: () => NOW,
    });
    const issued = await fnmtLike();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'der',
    });
    const error = await vault
      .addCertificateFromKey({
        privateKey: other,
        certificates: issued.certificates,
        fileName: 'x',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe('invalid_certificate');
    expect(vault.listCredentials()).toEqual([]);
  });

  it('reads vault files written before certificate requests existed', () => {
    const old = {
      version: 1,
      createdAt: NOW.toISOString(),
      personal: {},
      documents: {},
      credentials: [],
      secrets: {},
    };
    expect(parseState(Buffer.from(JSON.stringify(old))).certificateRequests).toEqual([]);
  });
});
