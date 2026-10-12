import { createHash } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { der, parseAsn1, readOctets, tlv } from '../src/der';
import { type Pkcs12Encryption, readPkcs12, writePkcs12 } from '../src/pkcs12';
import {
  FIXTURE_NONASCII_PASSPHRASE,
  FIXTURE_PASSPHRASE,
  fixture,
  makeChain,
} from './helpers/certs';

const isOpenSsl3 = /^3\./.test(process.versions.openssl ?? '');
const fingerprint = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: 'Pkcs12Error', code });
}

describe('readPkcs12 on OpenSSL-made fixtures', () => {
  const cases: Array<[file: string, keyType: string, curveOrBits: string | number, cn: string]> = [
    ['rsa-openssl3.p12', 'rsa', 2048, 'ESPAÑOLA ESPAÑOLA CARMEN - 99999999R'],
    ['rsa-legacy-rc2.p12', 'rsa', 2048, 'ESPAÑOLA ESPAÑOLA CARMEN - 99999999R'],
    ['rsa-pbmac1.p12', 'rsa', 2048, 'ESPAÑOLA ESPAÑOLA CARMEN - 99999999R'],
    ['ec-p256-openssl3.p12', 'ec', 'prime256v1', 'MUESTRA SAMPLE JUAN - X1234567L'],
    ['ec-p384-legacy.p12', 'ec', 'secp384r1', 'PRUEBA CERTIFICADO ANA - 12345678Z'],
  ];

  it.each(cases)('%s', async (file, keyType, size, cn) => {
    const p12 = await readPkcs12(fixture(file), FIXTURE_PASSPHRASE);
    expect(p12.privateKey.asymmetricKeyType).toBe(keyType);
    const details = p12.privateKey.asymmetricKeyDetails;
    expect(details?.modulusLength ?? details?.namedCurve).toBe(size);
    expect(p12.certificate.subject).toContain(`CN=${cn}`);
    expect(p12.certificate.checkPrivateKey(p12.privateKey)).toBe(true);
    expect(p12.chain).toHaveLength(1);
    expect(p12.certificate.checkIssued(p12.chain[0]!)).toBe(true);
    expect(p12.friendlyName).toBe(cn);
  });

  it.each(['rsa-openssl3.p12', 'rsa-legacy-rc2.p12', 'rsa-pbmac1.p12', 'ec-p256-openssl3.p12'])(
    'rejects a wrong passphrase: %s',
    async (file) => {
      await expectCode(readPkcs12(fixture(file), 'wrong'), 'invalid_passphrase');
      await expectCode(readPkcs12(fixture(file), ''), 'invalid_passphrase');
    },
  );

  it('handles non-ASCII passphrases like OpenSSL (UTF-8 for PBKDF2, BMPString for the MAC)', async () => {
    for (const file of ['rsa-nonascii.p12', 'rsa-nonascii-legacy.p12']) {
      const p12 = await readPkcs12(fixture(file), FIXTURE_NONASCII_PASSPHRASE);
      expect(p12.certificate.subject).toContain('99999999R');
      await expectCode(readPkcs12(fixture(file), 'Contrasena-N€1'), 'invalid_passphrase');
    }
  });

  it('reports files without a private key', async () => {
    await expectCode(readPkcs12(fixture('rsa-nokey.p12'), FIXTURE_PASSPHRASE), 'no_private_key');
  });

  it('reports garbage as invalid_format', async () => {
    await expectCode(readPkcs12(Buffer.from('not a certificate'), 'x'), 'invalid_format');
    const truncated = fixture('rsa-openssl3.p12').subarray(0, 1000);
    await expectCode(readPkcs12(truncated, FIXTURE_PASSPHRASE), 'invalid_format');
  });

  it.runIf(isOpenSsl3)('confirms Node itself rejects the legacy RC2-40 fixture', () => {
    expect(() =>
      createSecureContext({ pfx: fixture('rsa-legacy-rc2.p12'), passphrase: FIXTURE_PASSPHRASE }),
    ).toThrow();
  });
});

describe('writePkcs12', () => {
  const encryptions: Pkcs12Encryption[] = [
    'aes-256-cbc',
    'pbe-sha1-3des',
    'pbe-sha1-rc2-40',
    'none',
  ];

  it.each(['rsa', 'ec256', 'ec384'] as const)(
    'round-trips %s keys in every encryption',
    async (kind) => {
      const { ca, leaf, key } = makeChain(kind);
      for (const keyEncryption of encryptions) {
        for (const certEncryption of encryptions) {
          const pfx = await writePkcs12({
            privateKey: key.privateKey,
            certificate: leaf,
            chain: [ca],
            passphrase: 'pässwörd',
            friendlyName: 'Carmen',
            keyEncryption,
            certEncryption,
            mac: keyEncryption === 'none' ? 'sha1' : 'sha256',
            iterations: 1000,
          });
          const back = await readPkcs12(pfx, 'pässwörd');
          expect(fingerprint(back.certificate.raw)).toBe(fingerprint(leaf.raw));
          expect(back.chain.map((c) => fingerprint(c.raw))).toEqual([fingerprint(ca.raw)]);
          expect(back.friendlyName).toBe('Carmen');
          expect(back.certificate.checkPrivateKey(back.privateKey)).toBe(true);
        }
      }
    },
  );

  it.each(['rsa', 'ec256', 'ec384'] as const)(
    'default output loads in Node TLS (%s)',
    async (kind) => {
      const { ca, leaf, key } = makeChain(kind);
      const pfx = await writePkcs12({
        privateKey: key.privateKey,
        certificate: leaf,
        chain: [ca],
        passphrase: 'secret',
      });
      expect(() => createSecureContext({ pfx, passphrase: 'secret' })).not.toThrow();
    },
  );

  it('supports empty passphrases and files without a MAC', async () => {
    const { leaf, key } = makeChain('ec256');
    const empty = await writePkcs12({
      privateKey: key.privateKey,
      certificate: leaf,
      passphrase: '',
    });
    expect((await readPkcs12(empty, '')).certificate.raw.equals(leaf.raw)).toBe(true);

    const noMac = await writePkcs12({
      privateKey: key.privateKey,
      certificate: leaf,
      passphrase: 'abc',
      mac: 'none',
    });
    expect((await readPkcs12(noMac, 'abc')).certificate.raw.equals(leaf.raw)).toBe(true);
    // Without a MAC, a wrong passphrase is detected when decrypting.
    await expectCode(readPkcs12(noMac, 'abd'), 'invalid_passphrase');
  });
});

describe('interoperability', () => {
  it('reads node-forge output (AES and 3DES)', async () => {
    const { ca, leaf, key } = makeChain('rsa');
    const forgeKey = forge.pki.privateKeyFromPem(
      key.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    );
    const forgeCerts = [leaf, ca].map((c) => forge.pki.certificateFromPem(c.toString()));
    for (const algorithm of ['aes256', '3des'] as const) {
      const asn1 = forge.pkcs12.toPkcs12Asn1(forgeKey, forgeCerts, 'forge-pass', {
        algorithm,
        friendlyName: 'forge',
      });
      const pfx = Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
      const back = await readPkcs12(pfx, 'forge-pass');
      expect(fingerprint(back.certificate.raw)).toBe(fingerprint(leaf.raw));
      expect(back.friendlyName).toBe('forge');
    }
  });

  it('reads BER encodings (indefinite lengths, constructed OCTET STRINGs)', async () => {
    const { leaf, key } = makeChain('ec256');
    const pfx = await writePkcs12({
      privateKey: key.privateKey,
      certificate: leaf,
      passphrase: 'ber',
    });
    // Re-encode PFX { version, authSafe ContentInfo { data, [0] OCTET STRING }, macData } with
    // indefinite lengths and the authSafe content split into a constructed OCTET STRING.
    const root = parseAsn1(pfx);
    const [version, authSafe, macData] = root.children;
    const content = readOctets(authSafe!.children[1]!.children[0]);
    const half = Math.floor(content.length / 2);
    const indefinite = (id: number, ...parts: Buffer[]) =>
      Buffer.concat([Buffer.from([id, 0x80]), ...parts, Buffer.from([0, 0])]);
    const constructedOctets = indefinite(
      0x24,
      der.octets(content.subarray(0, half)),
      tlv(0x04, content.subarray(half)),
    );
    const ber = indefinite(
      0x30,
      version!.raw,
      indefinite(0x30, authSafe!.children[0]!.raw, indefinite(0xa0, constructedOctets)),
      macData!.raw,
    );
    const back = await readPkcs12(ber, 'ber');
    expect(back.certificate.raw.equals(leaf.raw)).toBe(true);
  });
});
