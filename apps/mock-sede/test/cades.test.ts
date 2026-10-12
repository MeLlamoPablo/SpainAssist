import { describe, expect, it } from 'vitest';
import { verifyCadesSignature } from '../src/cades';
import { createTestIdentity, loadDemoIdentity } from '../src/identities';
import { signCadesBes } from './helpers/cades-signer';

const data = Buffer.from('<?xml version="1.0"?><Solicitud>Año 2026, señora Núñez</Solicitud>');
const demo = loadDemoIdentity();
const sign = (overrides: Partial<Parameters<typeof signCadesBes>[0]> = {}) =>
  signCadesBes({
    data,
    certPem: demo.certPem,
    keyPem: demo.keyPem,
    chainPem: demo.chainPem,
    ...overrides,
  });
const failed = (r: ReturnType<typeof verifyCadesSignature>) =>
  r.checks.filter((c) => !c.ok).map((c) => c.id);

describe('verifyCadesSignature', () => {
  it('accepts an implicit CAdES-BES signature from a mock CA certificate', () => {
    const signature = sign();
    const result = verifyCadesSignature({
      signature: signature.toString('base64'),
      expectedContent: data,
      certificateArgument: demo.certDer.toString('base64'),
    });
    expect(result.error).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(result.mode).toBe('implicit');
    expect(result.digestAlgorithm).toBe('sha256');
    expect(result.signer).toMatchObject({ dni: '99999999R', givenName: 'CARMEN' });
    expect(result.signedContent?.equals(data)).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual([
      'structure',
      'content',
      'contentType',
      'messageDigest',
      'signingCertificate',
      'signature',
      'chain',
      'validity',
      'certificateArgument',
    ]);
  });

  it('accepts URL-safe Base64 like AutoFirma may return', () => {
    const urlSafe = sign().toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    expect(verifyCadesSignature({ signature: urlSafe, expectedContent: data }).valid).toBe(true);
  });

  it('rejects a tampered signature value', () => {
    const signature = sign();
    signature[signature.length - 5]! ^= 0xff;
    const result = verifyCadesSignature({ signature, expectedContent: data });
    expect(result.valid).toBe(false);
    expect(failed(result)).toEqual(['signature']);
  });

  it('rejects a signature over different data', () => {
    const result = verifyCadesSignature({
      signature: sign(),
      expectedContent: Buffer.from('otra solicitud'),
    });
    expect(failed(result)).toEqual(['content']);
  });

  it('rejects tampered embedded content (message digest mismatch)', () => {
    const signature = sign();
    const at = signature.indexOf(Buffer.from('Solicitud>'));
    signature[at] = 'X'.charCodeAt(0);
    const result = verifyCadesSignature({ signature });
    expect(failed(result)).toEqual(['messageDigest']);
  });

  it('rejects certificates from an unknown CA', () => {
    const stranger = createTestIdentity({
      givenName: 'Eva',
      surname1: 'Ajena',
      dni: '11111111H',
      passphrase: 'p',
      issuer: 'untrusted',
    });
    const result = verifyCadesSignature({
      signature: sign({
        certPem: stranger.certPem,
        keyPem: stranger.keyPem,
        chainPem: stranger.chainPem,
      }),
      expectedContent: data,
    });
    expect(failed(result)).toEqual(['chain']);
  });

  it('rejects expired certificates', () => {
    const old = createTestIdentity({
      givenName: 'Old',
      surname1: 'Caducado',
      dni: '22222222J',
      passphrase: 'p',
      notBefore: new Date('2019-01-01'),
      notAfter: new Date('2021-01-01'),
    });
    const result = verifyCadesSignature({
      signature: sign({ certPem: old.certPem, keyPem: old.keyPem }),
      expectedContent: data,
    });
    expect(failed(result)).toEqual(['validity']);
  });

  it('requires implicit mode and signing-certificate-v2 by default', () => {
    const detached = sign({ implicit: false });
    expect(failed(verifyCadesSignature({ signature: detached, expectedContent: data }))).toContain(
      'content',
    );
    expect(
      verifyCadesSignature({ signature: detached, expectedContent: data, requireImplicit: false })
        .valid,
    ).toBe(true);
    const noEss = sign({ signingCertificateV2: false });
    expect(failed(verifyCadesSignature({ signature: noEss, expectedContent: data }))).toEqual([
      'signingCertificate',
    ]);
  });

  it('flags a certificate argument that is not the signer', () => {
    const other = createTestIdentity({
      givenName: 'A',
      surname1: 'B',
      dni: '33333333P',
      passphrase: 'p',
    });
    const result = verifyCadesSignature({
      signature: sign(),
      expectedContent: data,
      certificateArgument: other.certDer.toString('base64'),
    });
    expect(failed(result)).toEqual(['certificateArgument']);
  });

  it('reports garbage input', () => {
    expect(verifyCadesSignature({ signature: 'no es base64!!' }).error).toMatch(/Base64/);
    expect(verifyCadesSignature({ signature: 'AAAA' }).error).toMatch(/CAdES/);
  });
});
