import { createHash, X509Certificate } from 'node:crypto';
import tls, { type PeerCertificate } from 'node:tls';

/**
 * The CRLSet's blocked keys for the app's own connections, which don't go through the agent's
 * browser: Node's (fetch to our servers and AI providers, with Node's own root store) and
 * Electron's (`net.fetch`, the window), both of which trusted eMudhra's leaked keys.
 */

/** Base64 SHA-256 of a certificate's DER SubjectPublicKeyInfo, the CRLSet's key hash. */
export function spkiHash(certificate: X509Certificate): string {
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64');
}

/** The subject of the first certificate of `chain` whose key is blocked, if any. */
export function blockedInChain(
  chain: readonly X509Certificate[],
  blocked: ReadonlySet<string>,
): string | undefined {
  if (blocked.size === 0) return undefined;
  return chain.find((cert) => blocked.has(spkiHash(cert)))?.subject.replace(/\n/g, ', ');
}

/**
 * Makes Node refuse TLS connections whose chain has a blocked key, after its own checks. Must run
 * before the first request: connections already open are not checked again.
 */
export function blockKeysInNodeTls(blocked: () => ReadonlySet<string>): void {
  const check = tls.checkServerIdentity;
  tls.checkServerIdentity = (host, cert) => {
    const subject = blockedInChain(peerChain(cert), blocked());
    if (subject) return new Error(`Blocked certificate authority in the chain: ${subject}`);
    return check(host, cert);
  };
}

/** An Electron certificate (`setCertificateVerifyProc`) and its issuers, as Node certificates. */
export function electronChain(cert: ElectronCertificate): X509Certificate[] {
  const chain: X509Certificate[] = [];
  for (let c: ElectronCertificate | undefined = cert; c && chain.length < 10; c = c.issuerCert)
    chain.push(new X509Certificate(c.data));
  return chain;
}

/** What `electronChain` needs of Electron's `Certificate` (PEM data and its issuer). */
interface ElectronCertificate {
  data: string;
  issuerCert?: ElectronCertificate;
}

function peerChain(cert: PeerCertificate): X509Certificate[] {
  const chain: X509Certificate[] = [];
  const seen = new Set<string>();
  for (
    let c: tls.DetailedPeerCertificate | PeerCertificate | undefined = cert;
    c?.raw && !seen.has(c.fingerprint256);
    c = (c as tls.DetailedPeerCertificate).issuerCertificate
  ) {
    seen.add(c.fingerprint256);
    chain.push(new X509Certificate(c.raw));
  }
  return chain;
}
