import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { createTestKeyProvider, Pkcs12Error, readPkcs12, Vault, VaultError } from '../src/index';
import { FIXTURE_PASSPHRASE, fixture, makeChain } from './helpers/certs';
import { tempVaultDir } from './helpers/tmp';

/** OpenSSL 3 or later as an independent reader (macOS's `openssl` is LibreSSL); else skipped. */
const OPENSSL = (() => {
  for (const bin of [process.env.OPENSSL_BIN, '/opt/homebrew/bin/openssl', 'openssl']) {
    if (!bin) continue;
    const r = spawnSync(bin, ['version'], { encoding: 'utf8' });
    if (r.status === 0 && /^OpenSSL ([3-9]|\d{2,})\./.test(r.stdout)) return bin;
  }
  return null;
})();

const PASSWORD = 'Contraseña-ñ 1';

async function openVault(now?: Date) {
  return Vault.open(
    await tempVaultDir(),
    createTestKeyProvider('export'),
    now ? { now: () => now } : {},
  );
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(VaultError);
  return (error as VaultError).code;
}

/** A certificate whose key the app made (an FNMT request), stored like FNMT's would be. */
async function storedFromKey(kind: 'rsa' | 'ec256') {
  const vault = await openVault();
  const { ca, leaf, key } = makeChain(kind);
  const summary = await vault.addCertificateFromKey({
    privateKey: key.privateKey.export({ type: 'pkcs8', format: 'der' }),
    certificates: [leaf.raw, ca.raw],
    fileName: '',
  });
  return { vault, summary, ca, leaf, key };
}

describe('exportCertificate', () => {
  it.each(['rsa', 'ec256'] as const)(
    'gives a %s certificate its key and chain under the new password',
    async (kind) => {
      const { vault, summary, ca, leaf, key } = await storedFromKey(kind);
      const p12 = await vault.exportCertificate(summary.id, PASSWORD);

      const contents = await readPkcs12(p12, PASSWORD);
      expect(contents.certificate.raw.equals(leaf.raw)).toBe(true);
      expect(contents.chain.map((c) => c.raw.toString('hex'))).toEqual([ca.raw.toString('hex')]);
      expect(
        contents.privateKey
          .export({ type: 'pkcs8', format: 'der' })
          .equals(key.privateKey.export({ type: 'pkcs8', format: 'der' })),
      ).toBe(true);
      expect(contents.friendlyName).toBe('CARMEN ESPAÑOLA ESPAÑOLA');
      // Node's TLS (OpenSSL) loads it too.
      expect(() => createSecureContext({ pfx: p12, passphrase: PASSWORD })).not.toThrow();

      await expect(readPkcs12(p12, 'otra-contraseña')).rejects.toMatchObject({
        code: 'invalid_passphrase',
      });
      await expect(readPkcs12(p12, 'otra-contraseña')).rejects.toBeInstanceOf(Pkcs12Error);
    },
  );

  it('re-packs an imported legacy (RC2-40) file, and leaves the stored copy as it was', async () => {
    const vault = await openVault(new Date('2026-10-03T12:00:00Z'));
    const original = await readPkcs12(fixture('rsa-legacy-rc2.p12'), FIXTURE_PASSPHRASE);
    const summary = await vault.addCertificate({
      fileName: 'rsa-legacy-rc2.p12',
      p12: fixture('rsa-legacy-rc2.p12'),
      passphrase: FIXTURE_PASSPHRASE,
    });
    const before = await vault.getCredentialSecret(summary.id);

    const contents = await readPkcs12(
      await vault.exportCertificate(summary.id, PASSWORD),
      PASSWORD,
    );
    expect(contents.certificate.raw.equals(original.certificate.raw)).toBe(true);
    expect(contents.chain.map((c) => c.fingerprint256)).toEqual(
      original.chain.map((c) => c.fingerprint256),
    );
    expect(contents.privateKey.equals(original.privateKey)).toBe(true);

    expect(await vault.getCredentialSecret(summary.id)).toEqual(before);
  });

  it('writes 3DES with a SHA-1 MAC, for macOS, Windows, Firefox and Java', async () => {
    const { vault, summary } = await storedFromKey('rsa');
    const p12 = await vault.exportCertificate(summary.id, PASSWORD);
    const hex = p12.toString('hex');
    const oid = (dotted: string) => {
      const [a, b, ...rest] = dotted.split('.').map(Number);
      const bytes = [a! * 40 + b!];
      for (const n of rest) {
        const groups = [n & 0x7f];
        for (let v = n >>> 7; v; v >>>= 7) groups.unshift((v & 0x7f) | 0x80);
        bytes.push(...groups);
      }
      return `06${bytes.length.toString(16).padStart(2, '0')}${Buffer.from(bytes).toString('hex')}`;
    };
    // pbeWithSHAAnd3-KeyTripleDES-CBC twice (key bag and certificates), the SHA-1 MAC, and no
    // PBES2, AES or RC2.
    expect(hex.split(oid('1.2.840.113549.1.12.1.3')).length - 1).toBe(2);
    expect(hex).toContain(oid('1.3.14.3.2.26'));
    for (const absent of [
      '1.2.840.113549.1.5.13',
      '2.16.840.1.101.3.4.1.42',
      '1.2.840.113549.1.12.1.6',
    ])
      expect(hex).not.toContain(oid(absent));
  });

  it.skipIf(!OPENSSL)('is a file OpenSSL reads with the new password', async () => {
    const { vault, summary, leaf } = await storedFromKey('ec256');
    const dir = mkdtempSync(join(tmpdir(), 'sa-vault-export-'));
    try {
      const file = join(dir, 'Certificado.p12');
      writeFileSync(file, await vault.exportCertificate(summary.id, PASSWORD));
      const run = (args: string[]) =>
        execFileSync(OPENSSL!, args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          // A Windows build reads `pass:contraseña…` in the ANSI code page without it.
          env: { ...process.env, OPENSSL_WIN32_UTF8: '1' },
        });
      const info = spawnSync(
        OPENSSL!,
        ['pkcs12', '-info', '-noout', '-in', file, '-passin', `pass:${PASSWORD}`],
        { encoding: 'utf8', env: { ...process.env, OPENSSL_WIN32_UTF8: '1' } },
      );
      expect(info.status, info.stderr).toBe(0);
      // OpenSSL prints the encodings on stderr.
      const report = info.stdout + info.stderr;
      expect(report).toContain('MAC: sha1');
      expect(report).toContain('PKCS7 Encrypted data: pbeWithSHA1And3-KeyTripleDES-CBC');
      expect(report).toContain('Shrouded Keybag: pbeWithSHA1And3-KeyTripleDES-CBC');
      expect(report.match(/Certificate bag/g)).toHaveLength(2);

      const cert = run([
        'pkcs12',
        '-in',
        file,
        '-passin',
        `pass:${PASSWORD}`,
        '-clcerts',
        '-nokeys',
      ]);
      expect(cert).toContain(leaf.toString().trim().split('\n')[1]);

      const wrong = spawnSync(
        OPENSSL!,
        ['pkcs12', '-info', '-noout', '-in', file, '-passin', 'pass:otra-contraseña'],
        { encoding: 'utf8' },
      );
      expect(wrong.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses other credentials, unknown ids and short passwords', async () => {
    const { vault, summary } = await storedFromKey('ec256');
    const clave = await vault.addClave({ username: '99999999R', password: 'secreta' });
    const dnie = await vault.addDnie();
    expect(await errorCode(vault.exportCertificate(clave.id, PASSWORD))).toBe('invalid_input');
    expect(await errorCode(vault.exportCertificate(dnie.id, PASSWORD))).toBe('invalid_input');
    expect(await errorCode(vault.exportCertificate('missing', PASSWORD))).toBe('not_found');
    expect(await errorCode(vault.exportCertificate(summary.id, '1234567'))).toBe('invalid_input');
    expect(await errorCode(vault.exportCertificate(summary.id, 'x'.repeat(257)))).toBe(
      'invalid_input',
    );
  });
});
