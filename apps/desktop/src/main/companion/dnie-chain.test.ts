import { createHash, X509Certificate } from 'node:crypto';
import { loadDemoIdentity } from '@sa/mock-sede';
import { describe, expect, it } from 'vitest';
import { DNIE_AUTHORITIES, dnieChain } from './dnie-chain';

const der = (pem: string) => Buffer.from(new X509Certificate(pem).raw);
const cn = (cert: X509Certificate) => /CN=([^\n]+)/.exec(cert.subject)?.[1];
const issuerCn = (cert: X509Certificate) => /CN=([^\n]+)/.exec(cert.issuer)?.[1];

describe('dnieChain (a test CA standing in for the DNIe CAs)', () => {
  const demo = loadDemoIdentity();
  const leaf = der(demo.certPem);
  const [intermediate, root] = demo.chainPem.map(der) as [Buffer, Buffer];
  const authorities = [root, intermediate];

  it('adds the intermediate for TLS, and the root too for signatures', () => {
    expect(dnieChain([leaf], 'tls', authorities)).toEqual([leaf, intermediate]);
    expect(dnieChain([leaf], 'signature', authorities)).toEqual([leaf, intermediate, root]);
  });

  it('falls back to the leaf alone when no CA issued it', () => {
    expect(dnieChain([leaf], 'signature')).toEqual([leaf]);
    expect(dnieChain([leaf], 'tls', [root])).toEqual([leaf]);
  });
});

describe('the bundled DNIe CA certificates', () => {
  const certs = DNIE_AUTHORITIES.map((d) => new X509Certificate(d));
  const root = certs.find((c) => cn(c) === 'AC RAIZ DNIE 2')!;

  it('are the published ones (dnie-ca/README.md)', () => {
    const fingerprints = Object.fromEntries(
      DNIE_AUTHORITIES.map((d, i) => [
        cn(certs[i]!),
        createHash('sha256').update(d).digest('hex').toUpperCase(),
      ]),
    );
    expect(fingerprints).toEqual({
      'AC DNIE 004': 'EBAE99303045630764DC5CF9D5AF9DC009354D8729C407B6BF9A136208046F6C',
      'AC DNIE 005': '828A22FF05932483C9E8D252399BA115A57DA75869D204422951FFA14C8EE828',
      'AC DNIE 006': 'EDA47E8A12D7E8A72721C220069807523E746B48C2441443177B5FBC58103BBD',
      'AC RAIZ DNIE 2': 'C5C380EB9240FB36A16E15F5D6BAD0BF611F6D03F0EF24229919E7D2D8126C11',
    });
  });

  it('chain each intermediate to AC RAIZ DNIE 2, verified by signature', () => {
    expect(root.subject).toBe(root.issuer);
    expect(root.verify(root.publicKey)).toBe(true);
    expect(root.ca).toBe(true);
    for (const cert of certs.filter((c) => c !== root)) {
      expect(cert.subject).toMatch(
        /^C=ES\nO=DIRECCION GENERAL DE LA POLICIA\nOU=DNIE\nCN=AC DNIE 00[4-6]$/,
      );
      expect(issuerCn(cert)).toBe('AC RAIZ DNIE 2');
      expect(cert.ca).toBe(true);
      expect(cert.checkIssued(root)).toBe(true);
      expect(cert.verify(root.publicKey)).toBe(true);
      // An intermediate ends the TLS path; signatures add the root.
      expect(dnieChain([cert.raw], 'tls')).toEqual([cert.raw]);
      expect(dnieChain([cert.raw], 'signature')).toEqual([cert.raw, root.raw]);
    }
  });
});
