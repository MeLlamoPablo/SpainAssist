import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { encodeP12, openP12, P12Error, pkcs12Kdf, readP12 } from '../src/p12';
import { hasLegacyProvider, OPENSSL, openssl, tmpDir, toPem } from './helpers/openssl';
import {
  ecIdentity,
  FNMT_POLICY_OID,
  forgeP12,
  HOLDER,
  PASSPHRASE,
  rsaIdentity,
  type TestIdentity,
} from './helpers/pki';

function expectIdentity(p12: Buffer, id: TestIdentity, passphrase = PASSPHRASE) {
  const out = openP12(p12, passphrase);
  expect(out.certificateDer.equals(id.certDer)).toBe(true);
  expect(out.chainDer.map((c) => c.toString('hex'))).toEqual(
    id.chain.map((c) => c.toString('hex')),
  );
  expect(out.keyType).toBe(id.keyType);
  // the key really is the certificate's key
  const sig = crypto.sign('sha256', Buffer.from('x'), out.privateKey);
  expect(
    crypto.verify(
      'sha256',
      Buffer.from('x'),
      new crypto.X509Certificate(id.certDer).publicKey,
      sig,
    ),
  ).toBe(true);
  return out;
}

function opensslExport(id: TestIdentity, legacy: boolean): Buffer {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'key.pem'),
    id.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  );
  fs.writeFileSync(path.join(dir, 'cert.pem'), toPem(id.certDer));
  fs.writeFileSync(path.join(dir, 'ca.pem'), toPem(id.caDer));
  const out = path.join(dir, 'out.p12');
  openssl([
    'pkcs12',
    '-export',
    ...(legacy ? ['-legacy'] : []),
    '-inkey',
    path.join(dir, 'key.pem'),
    '-in',
    path.join(dir, 'cert.pem'),
    '-certfile',
    path.join(dir, 'ca.pem'),
    '-passout',
    `pass:${PASSPHRASE}`,
    '-out',
    out,
  ]);
  return fs.readFileSync(out);
}

describe('readP12 / openP12', () => {
  it('reads our own modern (AES-256, SHA-256 MAC) RSA file with FNMT-style info', () => {
    const id = rsaIdentity();
    expectIdentity(id.p12, id);
    const { info, chainDer } = readP12(id.p12, PASSPHRASE);
    expect(chainDer).toHaveLength(2);
    expect(info.holderName).toBe(`${HOLDER.givenName} ${HOLDER.surname}`);
    expect(info.holderId).toBe(HOLDER.id);
    expect(info.subject).toContain(`CN=${HOLDER.cn}`);
    expect(info.subject).toContain('SERIALNUMBER=IDCES-12345678Z');
    expect(info.issuer).toBe('CN=AC FNMT Usuarios PRUEBAS, OU=Ceres, O=FNMT-RCM PRUEBAS, C=ES');
    expect(info.fingerprint).toBe(crypto.createHash('sha256').update(id.certDer).digest('hex'));
    expect(info.serialNumber).toBe(
      new crypto.X509Certificate(id.certDer).serialNumber.toUpperCase(),
    );
    expect(new Date(info.validTo).getTime()).toBeGreaterThan(Date.now());
    expect(info.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reads files written by node-forge (AES-256 and legacy 3DES)', () => {
    const id = rsaIdentity();
    expectIdentity(forgeP12(id, 'aes256'), id);
    expectIdentity(forgeP12(id, '3des'), id);
  });

  it('reads legacy RC2-40 + 3DES + SHA-1 MAC files', () => {
    const id = rsaIdentity();
    const legacy = encodeP12({
      privateKey: id.privateKey,
      certificates: id.chain,
      passphrase: PASSPHRASE,
      keyEncryption: 'pbeWithSHAAnd3-KeyTripleDES-CBC',
      certEncryption: 'pbeWithSHAAnd40BitRC2-CBC',
      macAlgorithm: 'sha1',
    });
    expectIdentity(legacy, id);
  });

  it('reads EC (P-256) identities', () => {
    const id = ecIdentity();
    const out = expectIdentity(id.p12, id);
    expect(out.namedCurve).toBe('P-256');
    expect(out.info.holderId).toBe(HOLDER.id);
  });

  it('rejects a wrong passphrase and invalid files', () => {
    const id = rsaIdentity();
    expect(() => readP12(id.p12, 'nope')).toThrowError(P12Error);
    try {
      readP12(id.p12, 'nope');
    } catch (e) {
      expect((e as P12Error).code).toBe('BAD_PASSWORD');
    }
    try {
      readP12(Buffer.from('not a p12'), PASSPHRASE);
      expect.unreachable();
    } catch (e) {
      expect((e as P12Error).code).toBe('INVALID_FILE');
    }
  });

  it('derives PKCS#12 keys like node-forge', () => {
    const salt = crypto.randomBytes(8);
    const bmp = Buffer.concat([Buffer.from(PASSPHRASE, 'utf16le').swap16(), Buffer.alloc(2)]);
    const ours = pkcs12Kdf('sha1', bmp, salt, 1, 2048, 24);
    // generatePkcs12Key exists at runtime but is missing from @types/node-forge.
    const pbe = (
      forge as unknown as {
        pbe: {
          generatePkcs12Key(
            password: string,
            salt: forge.util.ByteBuffer,
            id: number,
            iter: number,
            n: number,
          ): forge.util.ByteBuffer;
        };
      }
    ).pbe;
    const theirs = pbe.generatePkcs12Key(
      PASSPHRASE,
      forge.util.createBuffer(salt.toString('binary')),
      1,
      2048,
      24,
    );
    expect(ours.toString('binary')).toBe(theirs.getBytes());
  });
});

describe.skipIf(!OPENSSL)('interop with the OpenSSL CLI', () => {
  it('reads OpenSSL 3 default (AES-256) exports, RSA and EC', () => {
    expectIdentity(opensslExport(rsaIdentity(), false), rsaIdentity());
    expectIdentity(opensslExport(ecIdentity(), false), ecIdentity());
  });

  it.skipIf(!hasLegacyProvider())('reads `openssl pkcs12 -legacy` exports (RC2-40)', () => {
    expectIdentity(opensslExport(rsaIdentity(), true), rsaIdentity());
    expectIdentity(opensslExport(ecIdentity(), true), ecIdentity());
  });

  it('OpenSSL reads our encoded files without the legacy provider', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'n.p12');
    fs.writeFileSync(
      file,
      encodeP12({
        privateKey: rsaIdentity().privateKey,
        certificates: rsaIdentity().chain,
        passphrase: PASSPHRASE,
      }),
    );
    const out = openssl([
      'pkcs12',
      '-in',
      file,
      '-passin',
      `pass:${PASSPHRASE}`,
      '-nokeys',
    ]).toString();
    expect(out).toContain('BEGIN CERTIFICATE');
  });

  it('keeps certificate policies readable (sanity check of the test PKI)', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'c.pem'), toPem(rsaIdentity().certDer));
    const text = openssl(['x509', '-in', path.join(dir, 'c.pem'), '-noout', '-text']).toString();
    expect(text).toContain(FNMT_POLICY_OID);
  });
});
