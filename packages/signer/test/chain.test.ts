import crypto from 'node:crypto';
import forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';
import { completeChain } from '../src/chain';

/** A throwaway DNIe-like PKI: root -> intermediate -> leaf, made with node-forge. */
interface Node {
  der: Buffer;
  key: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
}

function name(cn: string) {
  return [
    { shortName: 'C', value: 'ES' },
    { shortName: 'O', value: 'DIRECCION GENERAL DE LA POLICIA PRUEBAS' },
    { shortName: 'OU', value: 'DNIE' },
    { shortName: 'CN', value: cn },
  ];
}

function issue(cn: string, issuer: Node | 'self', ca: boolean): Node {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const key = forge.pki.privateKeyFromPem(
    pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  ) as forge.pki.rsa.PrivateKey;
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(
    pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );
  cert.serialNumber = crypto
    .randomBytes(8)
    .toString('hex')
    .replace(/^[89a-f]/, '1');
  cert.validity.notBefore = new Date(Date.now() - 86400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400_000);
  cert.setSubject(name(cn));
  cert.setIssuer(issuer === 'self' ? name(cn) : issuer.cert.subject.attributes);
  cert.setExtensions([{ name: 'basicConstraints', cA: ca, critical: true }]);
  cert.sign(issuer === 'self' ? key : issuer.key, forge.md.sha256.create());
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  return { der, key, cert };
}

let root: Node;
let intermediate: Node;
let other: Node;
let leaf: Node;

beforeAll(() => {
  root = issue('AC RAIZ PRUEBAS', 'self', true);
  intermediate = issue('AC PRUEBAS 001', root, true);
  other = issue('AC PRUEBAS 002', root, true);
  leaf = issue('ESPAÑOL ESPAÑOL, JUAN (AUTENTICACIÓN)', intermediate, false);
});

describe('completeChain', () => {
  it('appends the intermediate that issued the leaf, without the root by default', () => {
    const chain = completeChain([leaf.der], [root.der, other.der, intermediate.der]);
    expect(chain).toEqual([leaf.der, intermediate.der]);
  });

  it('appends the root when asked', () => {
    const chain = completeChain([leaf.der], [other.der, intermediate.der, root.der], {
      root: true,
    });
    expect(chain).toEqual([leaf.der, intermediate.der, root.der]);
  });

  it('keeps only the leaf when no authority issued it (an unknown CA)', () => {
    const stranger = issue('AC DESCONOCIDA', 'self', true);
    const foreign = issue('OTRA PERSONA', stranger, false);
    expect(completeChain([foreign.der], [intermediate.der, root.der], { root: true })).toEqual([
      foreign.der,
    ]);
  });

  it('checks the signature, not just the issuer name', () => {
    // Same subject as the real intermediate, different key.
    const impostor = issue('AC PRUEBAS 001', root, true);
    expect(completeChain([leaf.der], [impostor.der])).toEqual([leaf.der]);
    expect(completeChain([leaf.der], [impostor.der, intermediate.der])).toEqual([
      leaf.der,
      intermediate.der,
    ]);
  });

  it('leaves a self-signed certificate alone', () => {
    const self = issue('SOFTWARE KEY', 'self', false);
    expect(completeChain([self.der], [intermediate.der, root.der], { root: true })).toEqual([
      self.der,
    ]);
  });

  it('extends a partial chain and does not duplicate what it already has', () => {
    expect(
      completeChain([leaf.der, intermediate.der], [intermediate.der, root.der], { root: true }),
    ).toEqual([leaf.der, intermediate.der, root.der]);
  });

  it('returns the input when it cannot be parsed', () => {
    const junk = Buffer.from('not a certificate');
    expect(completeChain([junk], [intermediate.der])).toEqual([junk]);
    expect(completeChain([], [intermediate.der])).toEqual([]);
  });
});
