import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as cms from '@peculiar/asn1-cms';
import { AsnConvert, AsnSerializer, OctetString } from '@peculiar/asn1-schema';
import { describe, expect, it } from 'vitest';
import { resolveAlgorithm } from '../src/algorithms';
import { cosignCades, countersignCades, createCades, OID, parseCades } from '../src/cades';
import { keyObjectSigner } from '../src/key';
import { expandPolicy, readPolicy } from '../src/policy';
import { derSetOf } from '../src/util/asn1';
import { OPENSSL, openssl, tmpDir, toPem } from './helpers/openssl';
import { ecIdentity, rsaIdentity, type TestIdentity } from './helpers/pki';
import { pkijsVerify, signedAttribute, signedAttributeTypes } from './helpers/verify';

const DATA = Buffer.from('Hola Mundo!! Solicitud de prueba con ñ y acentos: áéíóú');

function opensslVerify(id: TestIdentity, sig: Buffer, detached?: Buffer): Buffer {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'sig.der'), sig);
  fs.writeFileSync(path.join(dir, 'ca.pem'), toPem(id.caDer));
  const args = ['cms', '-verify', '-binary', '-inform', 'DER', '-in', path.join(dir, 'sig.der')];
  args.push('-CAfile', path.join(dir, 'ca.pem'), '-purpose', 'any');
  if (detached) {
    fs.writeFileSync(path.join(dir, 'data.bin'), detached);
    args.push('-content', path.join(dir, 'data.bin'));
  }
  return openssl(args);
}

function opensslPrint(sig: Buffer): string {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'sig.der'), sig);
  return openssl([
    'cms',
    '-cmsout',
    '-print',
    '-inform',
    'DER',
    '-in',
    path.join(dir, 'sig.der'),
  ]).toString();
}

const agePolicy = () => readPolicy(expandPolicy({ expPolicy: 'FirmaAGE' }, 'CAdES', DATA.length));

describe('CAdES', () => {
  for (const make of [rsaIdentity, ecIdentity]) {
    const label = make === rsaIdentity ? 'RSA' : 'EC';

    it(`${label}: implicit CAdES-EPES (FirmaAGE, SHA-512) verifies with pkijs and has AutoFirma's attributes`, async () => {
      const id = make();
      const algorithm = resolveAlgorithm('SHA512withRSA', id.keyType);
      const sig = await createCades({
        data: DATA,
        implicit: true,
        algorithm,
        signer: keyObjectSigner(id.privateKey, id.keyType),
        chain: id.chain,
        attributes: {
          policy: agePolicy(),
          signingTime: new Date(),
          contentHints: { oid: OID.data, description: 'Texto plano' },
        },
      });
      expect(await pkijsVerify(sig)).toBe(true);
      expect(parseCades(sig).content?.equals(DATA)).toBe(true);
      expect(signedAttributeTypes(sig).sort()).toEqual(
        [
          OID.contentType,
          OID.messageDigest,
          OID.signingCertificateV2,
          OID.sigPolicyId,
          OID.contentHint,
          OID.signingTime,
        ].sort(),
      );
      // signature algorithm: rsaEncryption (NULL params) for RSA, ecdsa-with-SHA512 for EC
      const si = parseCades(sig).signedData.signerInfos[0];
      expect(si.signatureAlgorithm.algorithm).toBe(
        id.keyType === 'rsa' ? '1.2.840.113549.1.1.1' : '1.2.840.10045.4.3.4',
      );
      expect(si.digestAlgorithm.algorithm).toBe('2.16.840.1.101.3.4.2.3');
      expect(si.version).toBe(cms.CMSVersion.v1);
    });

    it(`${label}: explicit (detached) SHA-256 and precalculated hash`, async () => {
      const id = make();
      const algorithm = resolveAlgorithm('SHA256', id.keyType);
      const sig = await createCades({
        data: DATA,
        implicit: false,
        algorithm,
        signer: keyObjectSigner(id.privateKey, id.keyType),
        chain: id.chain,
        attributes: { signingTime: new Date() },
      });
      expect(parseCades(sig).content).toBeNull();
      expect(await pkijsVerify(sig, 0, DATA)).toBe(true);

      const digest = crypto.createHash('sha256').update(DATA).digest();
      const pre = await createCades({
        digest,
        implicit: true,
        algorithm,
        signer: keyObjectSigner(id.privateKey, id.keyType),
        chain: id.chain,
        attributes: { signingTime: new Date() },
      });
      expect(parseCades(pre).content).toBeNull();
      expect(await pkijsVerify(pre, 0, DATA)).toBe(true);
    });
  }

  it('omits ESSCertIDv2.hashAlgorithm for SHA-256 and keeps it for SHA-512, with cert policies', async () => {
    const id = rsaIdentity();
    const s256 = await createCades({
      data: DATA,
      implicit: true,
      algorithm: resolveAlgorithm('SHA256withRSA', 'rsa'),
      signer: keyObjectSigner(id.privateKey, id.keyType),
      chain: id.chain,
    });
    const s512 = await createCades({
      data: DATA,
      implicit: true,
      algorithm: resolveAlgorithm('SHA512withRSA', 'rsa'),
      signer: keyObjectSigner(id.privateKey, id.keyType),
      chain: id.chain,
    });
    const v2 = (sig: Buffer) =>
      Buffer.from(
        (
          signedAttribute(sig, OID.signingCertificateV2) as unknown as { toBER(): ArrayBuffer }
        ).toBER(),
      );
    // SEQUENCE { SEQUENCE OF ESSCertIDv2 { [hashAlgorithm] certHash issuerSerial } policies }
    const hex256 = v2(s256).toString('hex');
    const hex512 = v2(s512).toString('hex');
    expect(hex256).not.toContain('0609608648016503040201'); // sha256 OID absent
    expect(hex512).toContain('0609608648016503040203'); // sha512 OID present
    // FNMT policy OID 1.3.6.1.4.1.5734.3.10.1 copied from the certificate
    expect(hex256).toContain('060a2b06010401ac66030a01');
  });

  it('uses signing-certificate (v1) for SHA-1', async () => {
    const id = rsaIdentity();
    const sig = await createCades({
      data: DATA,
      implicit: true,
      algorithm: resolveAlgorithm('SHA1', 'rsa'),
      signer: keyObjectSigner(id.privateKey, id.keyType),
      chain: id.chain,
    });
    expect(signedAttributeTypes(sig)).toContain(OID.signingCertificate);
    expect(signedAttributeTypes(sig)).not.toContain(OID.signingCertificateV2);
  });

  it('cosigns (RSA + EC signers) and countersigns', async () => {
    const rsa = rsaIdentity();
    const ec = ecIdentity();
    const first = await createCades({
      data: DATA,
      implicit: true,
      algorithm: resolveAlgorithm('SHA256', 'rsa'),
      signer: keyObjectSigner(rsa.privateKey, rsa.keyType),
      chain: rsa.chain,
      attributes: { signingTime: new Date() },
    });
    const cosigned = await cosignCades({
      signature: first,
      algorithm: resolveAlgorithm('SHA256', 'ec'),
      signer: keyObjectSigner(ec.privateKey, ec.keyType),
      chain: ec.chain,
      attributes: { signingTime: new Date() },
    });
    expect(await pkijsVerify(cosigned, 0)).toBe(true);
    expect(await pkijsVerify(cosigned, 1)).toBe(true);

    const countersigned = await countersignCades({
      signature: cosigned,
      algorithm: resolveAlgorithm('SHA512', 'rsa'),
      signer: keyObjectSigner(rsa.privateKey, rsa.keyType),
      chain: rsa.chain,
      attributes: { signingTime: new Date() },
    });
    // the original signatures still verify
    expect(await pkijsVerify(countersigned, 0)).toBe(true);
    expect(await pkijsVerify(countersigned, 1)).toBe(true);
    // each leaf got a countersignature over its signature value, without content-type
    const sd = parseCades(countersigned).signedData;
    for (const si of sd.signerInfos) {
      const attr = si.unsignedAttrs?.find((a) => a.attrType === OID.counterSignature);
      expect(attr).toBeDefined();
      const cs = AsnConvert.parse(attr!.attrValues[0], cms.SignerInfo);
      const types = cs.signedAttrs!.map((a) => a.attrType);
      expect(types).not.toContain(OID.contentType);
      const md = AsnConvert.parse(
        cs.signedAttrs!.find((a) => a.attrType === OID.messageDigest)!.attrValues[0],
        OctetString,
      );
      expect(Buffer.from(md.buffer)).toEqual(
        crypto.createHash('sha512').update(Buffer.from(si.signature.buffer)).digest(),
      );
      // verify the countersignature itself
      const signedAttrsDer = derSetOf(
        cs.signedAttrs!.map((a) => Buffer.from(AsnSerializer.serialize(a))),
      );
      expect(
        crypto.verify(
          'sha512',
          signedAttrsDer,
          new crypto.X509Certificate(rsa.certDer).publicKey,
          Buffer.from(cs.signature.buffer),
        ),
      ).toBe(true);
    }
  });
});

describe.skipIf(!OPENSSL)('CAdES verified by the OpenSSL CLI', () => {
  for (const make of [rsaIdentity, ecIdentity]) {
    const label = make === rsaIdentity ? 'RSA' : 'EC';
    it(`${label}: implicit FirmaAGE and explicit signatures`, async () => {
      const id = make();
      const implicit = await createCades({
        data: DATA,
        implicit: true,
        algorithm: resolveAlgorithm('SHA512withRSA', id.keyType),
        signer: keyObjectSigner(id.privateKey, id.keyType),
        chain: id.chain,
        attributes: {
          policy: agePolicy(),
          signingTime: new Date(),
          contentHints: { oid: OID.data, description: 'Texto plano' },
          claimedRoles: ['Solicitante'],
        },
      });
      expect(opensslVerify(id, implicit).equals(DATA)).toBe(true);
      const printed = opensslPrint(implicit);
      expect(printed).toContain('2.16.724.1.3.1.1.2.1.9');
      expect(printed).toContain('id-smime-aa-signingCertificateV2');
      expect(printed).toContain('id-smime-aa-contentHint');

      const explicit = await createCades({
        data: DATA,
        implicit: false,
        algorithm: resolveAlgorithm('SHA256', id.keyType),
        signer: keyObjectSigner(id.privateKey, id.keyType),
        chain: id.chain,
        attributes: { signingTime: new Date() },
      });
      expect(opensslVerify(id, explicit, DATA).equals(DATA)).toBe(true);
    });
  }

  it('cosigned signatures verify for every signer', async () => {
    const rsa = rsaIdentity();
    const ec = ecIdentity();
    const first = await createCades({
      data: DATA,
      implicit: true,
      algorithm: resolveAlgorithm('SHA256', 'rsa'),
      signer: keyObjectSigner(rsa.privateKey, rsa.keyType),
      chain: rsa.chain,
      attributes: { signingTime: new Date() },
    });
    const cosigned = await cosignCades({
      signature: first,
      algorithm: resolveAlgorithm('SHA384', 'ec'),
      signer: keyObjectSigner(ec.privateKey, ec.keyType),
      chain: ec.chain,
      attributes: { signingTime: new Date() },
    });
    // both CAs are needed to verify both signers
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'sig.der'), cosigned);
    fs.writeFileSync(path.join(dir, 'cas.pem'), toPem(rsa.caDer) + toPem(ec.caDer));
    const out = openssl([
      'cms',
      '-verify',
      '-binary',
      '-inform',
      'DER',
      '-in',
      path.join(dir, 'sig.der'),
      '-CAfile',
      path.join(dir, 'cas.pem'),
      '-purpose',
      'any',
    ]);
    expect(out.equals(DATA)).toBe(true);
  });
});
