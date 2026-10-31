import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import * as asn1js from 'asn1js';
import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import {
  createCertificateRequest,
  issuedCertificatePath,
  parseIssuedCertificates,
  publicKeyHash,
  requestKeySpec,
  verifyCertificateRequest,
} from '../src/certificate-request';
import { OPENSSL, openssl, toPem } from './helpers/openssl';
import { rsaIdentity } from './helpers/pki';

function forgeDer(cert: forge.pki.Certificate): Buffer {
  return Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
}

/** A certificate for `spki` (RSA) issued by the shared test CA, as FNMT would issue it. */
function issueFor(spki: Buffer): Buffer {
  const ca = rsaIdentity();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(
    crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }).export({
      type: 'spki',
      format: 'pem',
    }) as string,
  );
  cert.serialNumber = '0a1b2c3d';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400_000);
  cert.setSubject([
    { shortName: 'C', value: 'ES' },
    { name: 'serialNumber', value: 'IDCES-12345678Z' },
    { shortName: 'CN', value: 'ESPAÑOLA ESPAÑOLA JUAN - 12345678Z' },
  ]);
  cert.setIssuer(ca.forgeCaCert.subject.attributes);
  cert.setExtensions([{ name: 'basicConstraints', cA: false }]);
  cert.sign(
    forge.pki.privateKeyFromPem(
      ca.caKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    ) as forge.pki.rsa.PrivateKey,
    forge.md.sha256.create(),
  );
  return forgeDer(cert);
}

/** A certificates-only CMS SignedData ("degenerate PKCS#7"), as FNMT's download page sends. */
function degeneratePkcs7(certs: Buffer[]): Buffer {
  const p7 = forge.pkcs7.createSignedData();
  for (const der of certs) {
    p7.addCertificate(forge.pki.certificateFromAsn1(forge.asn1.fromDer(der.toString('binary'))));
  }
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

describe('requestKeySpec', () => {
  it('reads the page arguments as the Configurador does', () => {
    expect(requestKeySpec('RSA', null)).toEqual({ type: 'rsa', bits: 2048 });
    expect(requestKeySpec(undefined, undefined)).toEqual({ type: 'rsa', bits: 2048 });
    expect(requestKeySpec('EC', null)).toEqual({ type: 'ec', bits: 256 });
    expect(requestKeySpec('ecdsa', 384)).toEqual({ type: 'ec', bits: 256 });
    expect(requestKeySpec('rsa', '3072')).toEqual({ type: 'rsa', bits: 3072 });
    expect(requestKeySpec('rsa', 1024)).toEqual({ type: 'rsa', bits: 2048 });
    expect(requestKeySpec('dsa', 99999)).toEqual({ type: 'rsa', bits: 2048 });
  });
});

describe('createCertificateRequest', () => {
  it('builds an RSA PKCS#10 like the Configurador: placeholder subject, no attributes, no NULL', () => {
    const req = createCertificateRequest({ type: 'rsa', bits: 2048 });
    expect(req.keyDescription).toBe('rsa 2048');
    expect(verifyCertificateRequest(req.pkcs10).equals(req.publicKey)).toBe(true);
    expect(req.publicKeyHash).toBe(publicKeyHash(req.publicKey));
    expect(req.publicKeyHash).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const parsed = asn1js.fromBER(new Uint8Array(req.pkcs10).buffer);
    const [info, algorithm] = (parsed.result as asn1js.Sequence).valueBlock.value as [
      asn1js.Sequence,
      asn1js.Sequence,
    ];
    // version 0, subject, SPKI, [0] {} (empty attributes)
    const [version, subject, , attributes] = info.valueBlock.value as asn1js.BaseBlock[];
    expect((version as asn1js.Integer).valueBlock.valueDec).toBe(0);
    expect(Buffer.from(subject!.toBER(false)).toString('hex')).toBe(
      Buffer.from(
        new asn1js.Sequence({
          value: [
            new asn1js.Set({
              value: [
                new asn1js.Sequence({
                  value: [
                    new asn1js.ObjectIdentifier({ value: '2.5.4.3' }),
                    new asn1js.Utf8String({ value: 'foo.bar.com' }),
                  ],
                }),
              ],
            }),
          ],
        }).toBER(false),
      ).toString('hex'),
    );
    expect(Buffer.from(attributes!.toBER(false)).toString('hex')).toBe('a000');
    // SHA256withRSA with no parameters.
    expect(algorithm.valueBlock.value).toHaveLength(1);
  });

  it('builds an EC P-256 request signed SHA256withECDSA', () => {
    const req = createCertificateRequest({ type: 'ec', bits: 256 });
    expect(req.keyDescription).toBe('ec prime256v1');
    expect(verifyCertificateRequest(req.pkcs10).equals(req.publicKey)).toBe(true);
  });

  it.skipIf(!OPENSSL)('is a request OpenSSL accepts', () => {
    const req = createCertificateRequest({ type: 'rsa', bits: 2048 });
    const out = openssl(
      ['req', '-verify', '-noout', '-subject'],
      Buffer.from(toPem(req.pkcs10, 'CERTIFICATE REQUEST')),
    ).toString();
    expect(out).toContain('CN=foo.bar.com');
  });
});

describe('parseIssuedCertificates', () => {
  const req = createCertificateRequest({ type: 'rsa', bits: 2048 });
  const leaf = issueFor(req.publicKey);
  const ca = rsaIdentity().caDer;

  it('reads a gzipped base64url PKCS#7 with embedded spaces', () => {
    const data = gzipSync(degeneratePkcs7([ca, leaf]))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/(.{60})/g, '$1 ');
    const certs = parseIssuedCertificates(data);
    expect(certs).toHaveLength(2);
    expect(certs.some((c) => c.equals(leaf))).toBe(true);
  });

  it('reads a plain base64 PKCS#7, a bare certificate and PEM', () => {
    expect(parseIssuedCertificates(degeneratePkcs7([leaf]).toString('base64'))).toEqual([leaf]);
    expect(parseIssuedCertificates(leaf.toString('base64'))).toEqual([leaf]);
    expect(parseIssuedCertificates(toPem(leaf))).toEqual([leaf]);
  });

  it('rejects data that holds no certificate', () => {
    expect(() => parseIssuedCertificates('not base64 !!')).toThrow(/base64/);
    expect(() => parseIssuedCertificates(Buffer.from('hola').toString('base64'))).toThrow(
      /neither/,
    );
  });

  it('builds the path from the shipped CAs first, then the bundle', () => {
    const certs = parseIssuedCertificates(degeneratePkcs7([leaf]).toString('base64'));
    // The CA did not come in the bundle: the shipped authorities complete the path.
    expect(issuedCertificatePath(certs[0]!, certs, [ca])).toEqual([leaf, ca]);
    // Unknown issuer and nothing shipped: the leaf alone.
    expect(issuedCertificatePath(leaf, [leaf], [])).toEqual([leaf]);
    // The bundle's own CA is used when nothing shipped matches.
    expect(issuedCertificatePath(leaf, [ca, leaf], [])).toEqual([leaf, ca]);
  });
});
