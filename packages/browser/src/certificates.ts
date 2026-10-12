/**
 * TLS client certificates for government logins (Cl@ve "DNIe / Certificado electrónico", AEAT,
 * Seguridad Social...). See docs/research/browser.md §1 and docs/research/dnie.md §2.
 *
 * Every browser context goes through the TLS sidecar (`@sa/sidecar`) with its own proxy
 * username. Its connections are plain TCP tunnels, so Chromium checks each site's certificate
 * itself, except for the origins where `useClientCertificate` turned a certificate on. The sidecar
 * intercepts only those, presenting the certificate with a key it holds (a .p12) or one that signs
 * elsewhere (the DNIe in the phone). Chromium trusts the sidecar's per-launch key for them through
 * an SPKI pin, so no certificate error is ignored for any other origin, and nothing needs a new
 * context: cookies, storage and open pages stay as they are.
 */
import { BrowserError } from './errors';

/**
 * Hosts that request a TLS client certificate during the handshake (verified live on
 * 2026-10-03, docs/research/browser.md §9.1). Exact https origins: each subdomain needs its own
 * entry. Regional/municipal sedes may need extra origins (pass them explicitly).
 */
export const CERTIFICATE_ORIGINS: readonly string[] = Object.freeze([
  'https://pasarela-ident.clave.gob.es', // Cl@ve "DNIe / Certificado electrónico" (any sede on Cl@ve)
  'https://www1.agenciatributaria.gob.es', // AEAT certificate access (/wlpl/OVCT-CXEW/…)
  'https://www8.agenciatributaria.gob.es', // AEAT (asks during the TLS 1.3 handshake)
  'https://www10.agenciatributaria.gob.es', // AEAT
  'https://w2.seg-social.es', // Seguridad Social certificate services
  'https://ipce.seg-social.es', // Seguridad Social certificate login
  'https://idp.seg-social.es', // Seguridad Social login (Importass, seen live on 2026-10-12)
]);

/**
 * Hosts of one organisation that a single DNIe login approval covers: a login can hop between
 * them (Importass goes idp → ipce → idp), and each hop would otherwise ask again on the phone.
 * A fixed list, never computed from the domain; any other host is a site of its own.
 */
const CERTIFICATE_SITES: readonly { name: string; hosts: readonly string[] }[] = Object.freeze([
  { name: 'Cl@ve', hosts: ['pasarela-ident.clave.gob.es'] },
  {
    name: 'Agencia Tributaria',
    hosts: [
      'www1.agenciatributaria.gob.es',
      'www8.agenciatributaria.gob.es',
      'www10.agenciatributaria.gob.es',
    ],
  },
  {
    name: 'Seguridad Social',
    hosts: ['idp.seg-social.es', 'ipce.seg-social.es', 'w2.seg-social.es'],
  },
]);

export interface CertificateSite {
  /** Same id = same approval. */
  id: string;
  /** The organisation, or the host itself. */
  name: string;
  hosts: readonly string[];
}

/** The site a host belongs to for DNIe login approvals. */
export function certificateSite(host: string): CertificateSite {
  const hostname = host.toLowerCase();
  const site = CERTIFICATE_SITES.find((s) => s.hosts.includes(hostname));
  return site
    ? { id: site.name, name: site.name, hosts: site.hosts }
    : { id: hostname, name: hostname, hosts: [hostname] };
}

/** Normalizes an origin: https only, path dropped, default port removed. */
export function normalizeOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new BrowserError('bad_input', `Invalid certificate origin "${origin}".`);
  }
  if (url.protocol !== 'https:') {
    throw new BrowserError(
      'bad_input',
      `Client certificates can only be used with https:// origins (got "${origin}").`,
    );
  }
  return url.origin;
}

/** The sidecar's "host:port" form of https origins, without duplicates. */
export function certificateHosts(origins: readonly string[]): string[] {
  const hosts = origins.map((o) => {
    const url = new URL(normalizeOrigin(o));
    return `${url.hostname}:${url.port || '443'}`;
  });
  return [...new Set(hosts)];
}
