import type { AdministrationLevel } from './procedure';
import type { CredentialKind } from './vault';

/**
 * Domains of Spanish public administrations. Only used as an anti-phishing allowlist: where
 * certificates may be presented and credentials typed (see `credentialAllowedOn`). Matching is
 * by host suffix on label boundaries ("sede.agenciatributaria.gob.es" matches "gob.es";
 * "evilgob.es" does not).
 */
export const OFFICIAL_DOMAINS: readonly { suffix: string; level: AdministrationLevel }[] = [
  // State (Administración General del Estado) and state agencies
  { suffix: 'gob.es', level: 'state' },
  { suffix: 'boe.es', level: 'state' },
  { suffix: 'agenciatributaria.es', level: 'state' },
  { suffix: 'seg-social.es', level: 'state' },
  { suffix: 'sepe.es', level: 'state' },
  { suffix: 'dgt.es', level: 'state' },
  { suffix: 'policia.es', level: 'state' },
  { suffix: 'dnielectronico.es', level: 'state' },
  { suffix: 'citapreviadnie.es', level: 'state' },
  { suffix: 'fnmt.es', level: 'state' },
  { suffix: 'cert.fnmt.es', level: 'state' },
  { suffix: 'guardiacivil.es', level: 'state' },
  { suffix: 'mjusticia.es', level: 'state' },
  { suffix: 'justicia.es', level: 'state' },
  { suffix: 'catastro.minhap.es', level: 'state' },
  { suffix: 'redsara.es', level: 'state' },
  { suffix: 'correos.es', level: 'state' },
  { suffix: 'ine.es', level: 'state' },
  { suffix: 'imserso.es', level: 'state' },
  { suffix: 'mites.gob.es', level: 'state' },
  { suffix: 'exteriores.gob.es', level: 'state' },
  // Autonomous communities
  { suffix: 'juntadeandalucia.es', level: 'regional' },
  { suffix: 'aragon.es', level: 'regional' },
  { suffix: 'asturias.es', level: 'regional' },
  { suffix: 'caib.es', level: 'regional' },
  { suffix: 'gobiernodecanarias.org', level: 'regional' },
  { suffix: 'cantabria.es', level: 'regional' },
  { suffix: 'jcyl.es', level: 'regional' },
  { suffix: 'castillalamancha.es', level: 'regional' },
  { suffix: 'gencat.cat', level: 'regional' },
  { suffix: 'aoc.cat', level: 'regional' }, // Catalan e-government consortium (VÀLid login)
  { suffix: 'gva.es', level: 'regional' },
  { suffix: 'juntaex.es', level: 'regional' },
  { suffix: 'xunta.gal', level: 'regional' },
  { suffix: 'madrid.org', level: 'regional' },
  { suffix: 'comunidad.madrid', level: 'regional' },
  { suffix: 'carm.es', level: 'regional' },
  { suffix: 'navarra.es', level: 'regional' },
  { suffix: 'euskadi.eus', level: 'regional' },
  { suffix: 'larioja.org', level: 'regional' },
  { suffix: 'ceuta.es', level: 'regional' },
  { suffix: 'melilla.es', level: 'regional' },
  // Large municipalities (non-exhaustive; many use <city>.es / .cat / .eus)
  { suffix: 'madrid.es', level: 'local' },
  { suffix: 'barcelona.cat', level: 'local' },
  { suffix: 'bcn.cat', level: 'local' },
  { suffix: 'valencia.es', level: 'local' },
  { suffix: 'sevilla.org', level: 'local' },
  { suffix: 'zaragoza.es', level: 'local' },
  { suffix: 'malaga.eu', level: 'local' },
  { suffix: 'bilbao.eus', level: 'local' },
  { suffix: 'palma.cat', level: 'local' },
  { suffix: 'alicante.es', level: 'local' },
  { suffix: 'cordoba.es', level: 'local' },
  { suffix: 'valladolid.es', level: 'local' },
  { suffix: 'vigo.org', level: 'local' },
  { suffix: 'gijon.es', level: 'local' },
  { suffix: 'vitoria-gasteiz.org', level: 'local' },
  { suffix: 'lacoruna.es', level: 'local' },
  { suffix: 'coruna.gal', level: 'local' },
  { suffix: 'granada.org', level: 'local' },
  // EU
  { suffix: 'europa.eu', level: 'eu' },
];

/**
 * Where each credential kind may be used. Cl@ve credentials are only typed into the Cl@ve
 * gateway / identity providers; certificates are only presented to official hosts.
 */
export const CREDENTIAL_ALLOWED_SUFFIXES: Record<CredentialKind, readonly string[]> = {
  clave_permanente: [
    'clave.gob.es',
    'seg-social.es',
    'seg-social.gob.es',
    'agenciatributaria.gob.es',
    'agenciatributaria.es',
  ],
  clave_movil: [
    'clave.gob.es',
    'seg-social.es',
    'seg-social.gob.es',
    'agenciatributaria.gob.es',
    'agenciatributaria.es',
  ],
  certificate: OFFICIAL_DOMAINS.map((d) => d.suffix),
  dnie: OFFICIAL_DOMAINS.map((d) => d.suffix),
};

/**
 * Extra hosts allowed for every credential kind. Only for development
 * and e2e tests (e.g. the mock sede on "localhost"). Set by the main process from
 * SA_EXTRA_TRUSTED_HOSTS; empty in production.
 */
let extraTrustedSuffixes: string[] = [];
export function setExtraTrustedHosts(suffixes: string[]): void {
  extraTrustedSuffixes = suffixes.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function hostMatchesSuffix(host: string, suffix: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const s = suffix.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}

/** True if a credential of `kind` may be used on the page at `url` (https only). */
export function credentialAllowedOn(kind: CredentialKind, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (extraTrustedSuffixes.some((s) => hostMatchesSuffix(parsed.hostname, s))) return true;
  return CREDENTIAL_ALLOWED_SUFFIXES[kind].some((s) => hostMatchesSuffix(parsed.hostname, s));
}
