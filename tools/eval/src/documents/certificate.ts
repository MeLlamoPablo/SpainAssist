/**
 * A persona's digital certificate: an FNMT-like "persona física" certificate and its key in a
 * `.p12`, drawn from a spec the same way every time (a seeded key, fixed dates and serial), so a
 * replayed run sees the same certificate. Only the `.p12`'s own salts vary (the vault encrypts it
 * again on import anyway). Issued by a throwaway CA that no site trusts: SpainBench
 * checks the signature against the certificate the page sends, not a chain.
 */
import { createHash } from 'node:crypto';
import forge from 'node-forge';

export interface CertificateSpec {
  /** As FNMT writes them: upper case. */
  givenName: string;
  surnames: string;
  nif: string;
  /** Validity, YYYY-MM-DD. */
  notBefore: string;
  notAfter: string;
}

export interface RenderedCertificate {
  fileName: string;
  p12: Uint8Array;
  passphrase: string;
}

/** Bytes that depend only on `seed`: a SHA-256 counter stream, for forge's key generation. */
function seededPrng(seed: string) {
  let counter = 0;
  let pool = '';
  return {
    getBytesSync(count: number): string {
      while (pool.length < count) {
        const block = createHash('sha256').update(`${seed}:${counter++}`).digest();
        pool += block.toString('binary');
      }
      const out = pool.slice(0, count);
      pool = pool.slice(count);
      return out;
    },
  };
}

function keyPair(seed: string): forge.pki.rsa.KeyPair {
  return forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001, prng: seededPrng(seed) });
}

const cache = new Map<string, RenderedCertificate>();

/** The certificate's `.p12`. Drawn once per process and spec (a key takes a moment). */
export function renderCertificate(spec: CertificateSpec): RenderedCertificate {
  const key = JSON.stringify(spec);
  const cached = cache.get(key) ?? drawCertificate(spec);
  cache.set(key, cached);
  return cached;
}

/** Draws the certificate's `.p12`: the same key and certificate for the same spec. */
export function drawCertificate(spec: CertificateSpec): RenderedCertificate {
  const key = JSON.stringify(spec);

  const ca = keyPair(`ca:${key}`);
  const caSubject = [
    { shortName: 'C', value: 'ES' },
    { shortName: 'O', value: 'FNMT-RCM' },
    { shortName: 'OU', value: 'Ceres' },
    { shortName: 'CN', value: 'AC FNMT Usuarios' },
  ];
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = ca.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date('2019-01-01T00:00:00Z');
  caCert.validity.notAfter = new Date('2034-01-01T00:00:00Z');
  caCert.setSubject(caSubject);
  caCert.setIssuer(caSubject);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  caCert.sign(ca.privateKey, forge.md.sha256.create());

  const holder = keyPair(`holder:${key}`);
  const cert = forge.pki.createCertificate();
  cert.publicKey = holder.publicKey;
  cert.serialNumber = createHash('sha256').update(key).digest('hex').slice(0, 16);
  cert.validity.notBefore = new Date(`${spec.notBefore}T00:00:00Z`);
  cert.validity.notAfter = new Date(`${spec.notAfter}T00:00:00Z`);
  cert.setSubject([
    { shortName: 'C', value: 'ES' },
    { type: '2.5.4.5', value: `IDCES-${spec.nif}` },
    { type: '2.5.4.4', value: spec.surnames },
    { type: '2.5.4.42', value: spec.givenName },
    { shortName: 'CN', value: `${spec.surnames} ${spec.givenName} - ${spec.nif}` },
  ]);
  cert.setIssuer(caSubject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true, emailProtection: true },
  ]);
  cert.sign(ca.privateKey, forge.md.sha256.create());

  const passphrase = createHash('sha256').update(`passphrase:${key}`).digest('base64url');
  const asn1 = forge.pkcs12.toPkcs12Asn1(holder.privateKey, [cert, caCert], passphrase, {
    algorithm: '3des',
    generateLocalKeyId: true,
    friendlyName: `${spec.surnames} ${spec.givenName}`,
  });
  const p12 = Uint8Array.from(Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'));
  return {
    fileName: `${spec.surnames} ${spec.givenName}.p12`.replace(/\s+/g, '_'),
    p12,
    passphrase,
  };
}
