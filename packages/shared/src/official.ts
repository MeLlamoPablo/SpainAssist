import type { AdministrationLevel } from './procedure';
import type { CredentialKind } from './vault';

/**
 * Domains of Spanish public administrations. Used as an anti-phishing allowlist (where
 * certificates may be presented and credentials typed, see `credentialAllowedOn`) and as the
 * hosts the agent may read without asking the user (`isOfficialHost`). Matching is
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
  // Municipalities: every one with 100,000+ inhabitants, by population (INE, Padrón at
  // 1 Jan 2025), then the provincial capitals and Mérida below that cutoff. Smaller towns are
  // covered by the provincial and shared sede platforms further down.
  { suffix: 'madrid.es', level: 'local' }, // Madrid
  { suffix: 'barcelona.cat', level: 'local' }, // Barcelona
  { suffix: 'bcn.cat', level: 'local' },
  { suffix: 'valencia.es', level: 'local' }, // València
  { suffix: 'zaragoza.es', level: 'local' }, // Zaragoza
  { suffix: 'sevilla.org', level: 'local' }, // Sevilla
  { suffix: 'malaga.eu', level: 'local' }, // Málaga (city; malaga.es is the Diputación)
  { suffix: 'murcia.es', level: 'local' }, // Murcia
  { suffix: 'palma.cat', level: 'local' }, // Palma (sede on palma.sedipualba.es)
  { suffix: 'palma.es', level: 'local' },
  { suffix: 'laspalmasgc.es', level: 'local' }, // Las Palmas de Gran Canaria
  { suffix: 'alicante.es', level: 'local' }, // Alicante
  { suffix: 'bilbao.eus', level: 'local' }, // Bilbao
  { suffix: 'cordoba.es', level: 'local' }, // Córdoba
  { suffix: 'valladolid.es', level: 'local' }, // Valladolid (also valladolid.gob.es)
  { suffix: 'vigo.org', level: 'local' }, // Vigo
  { suffix: 'l-h.cat', level: 'local' }, // L'Hospitalet de Llobregat
  { suffix: 'gijon.es', level: 'local' }, // Gijón
  { suffix: 'vitoria-gasteiz.org', level: 'local' }, // Vitoria-Gasteiz
  { suffix: 'coruna.gal', level: 'local' }, // A Coruña
  { suffix: 'lacoruna.es', level: 'local' },
  { suffix: 'elche.es', level: 'local' }, // Elche
  { suffix: 'granada.org', level: 'local' }, // Granada
  { suffix: 'terrassa.cat', level: 'local' }, // Terrassa
  { suffix: 'badalona.cat', level: 'local' }, // Badalona
  { suffix: 'sabadell.cat', level: 'local' }, // Sabadell
  { suffix: 'oviedo.es', level: 'local' }, // Oviedo
  { suffix: 'cartagena.es', level: 'local' }, // Cartagena (sede on cartagena.sedipualba.es)
  { suffix: 'mostoles.es', level: 'local' }, // Móstoles
  { suffix: 'jerez.es', level: 'local' }, // Jerez de la Frontera
  { suffix: 'aytojerez.es', level: 'local' },
  { suffix: 'santacruzdetenerife.es', level: 'local' }, // Santa Cruz de Tenerife
  { suffix: 'pamplona.es', level: 'local' }, // Pamplona
  { suffix: 'almeriaciudad.es', level: 'local' }, // Almería
  { suffix: 'aytoalmeria.es', level: 'local' },
  { suffix: 'ayto-alcaladehenares.es', level: 'local' }, // Alcalá de Henares
  { suffix: 'leganes.org', level: 'local' }, // Leganés
  { suffix: 'getafe.es', level: 'local' }, // Getafe
  { suffix: 'ayto-fuenlabrada.es', level: 'local' }, // Fuenlabrada
  { suffix: 'fuenlabrada.es', level: 'local' },
  { suffix: 'donostia.eus', level: 'local' }, // Donostia / San Sebastián
  { suffix: 'castello.es', level: 'local' }, // Castelló de la Plana
  { suffix: 'aytoburgos.es', level: 'local' }, // Burgos (city; burgos.es is the Diputación)
  { suffix: 'ayto-alcorcon.es', level: 'local' }, // Alcorcón
  { suffix: 'santander.es', level: 'local' }, // Santander
  { suffix: 'albacete.es', level: 'local' }, // Albacete (sede on albacete.sedipualba.es)
  { suffix: 'aytolalaguna.es', level: 'local' }, // San Cristóbal de La Laguna
  { suffix: 'marbella.es', level: 'local' }, // Marbella (sede on marbella.sedelectronica.es)
  { suffix: 'logrono.es', level: 'local' }, // Logroño
  { suffix: 'aytobadajoz.es', level: 'local' }, // Badajoz
  { suffix: 'paeria.cat', level: 'local' }, // Lleida
  { suffix: 'aytosalamanca.es', level: 'local' }, // Salamanca (sede on aytosalamanca.gob.es)
  { suffix: 'tarragona.cat', level: 'local' }, // Tarragona
  { suffix: 'ayto-torrejon.es', level: 'local' }, // Torrejón de Ardoz
  { suffix: 'huelva.es', level: 'local' }, // Huelva
  { suffix: 'doshermanas.es', level: 'local' }, // Dos Hermanas
  { suffix: 'ayuntamientoparla.es', level: 'local' }, // Parla
  { suffix: 'mataro.cat', level: 'local' }, // Mataró
  { suffix: 'algeciras.es', level: 'local' }, // Algeciras
  { suffix: 'gramenet.cat', level: 'local' }, // Santa Coloma de Gramenet
  { suffix: 'aytoleon.es', level: 'local' }, // León
  { suffix: 'alcobendas.org', level: 'local' }, // Alcobendas
  { suffix: 'aytojaen.es', level: 'local' }, // Jaén
  { suffix: 'reus.cat', level: 'local' }, // Reus
  { suffix: 'aytoroquetas.org', level: 'local' }, // Roquetas de Mar
  { suffix: 'roquetasdemar.es', level: 'local' },
  { suffix: 'cadiz.es', level: 'local' }, // Cádiz
  { suffix: 'girona.cat', level: 'local' }, // Girona
  { suffix: 'ourense.gal', level: 'local' }, // Ourense (sede on sede.ourense.gob.es)
  { suffix: 'telde.es', level: 'local' }, // Telde (sede on telde.sedelectronica.es)
  { suffix: 'rivasciudad.es', level: 'local' }, // Rivas-Vaciamadrid
  { suffix: 'barakaldo.eus', level: 'local' }, // Barakaldo
  { suffix: 'santiagodecompostela.gal', level: 'local' }, // Santiago de Compostela
  { suffix: 'concellodelugo.gal', level: 'local' }, // Lugo
  { suffix: 'lugo.gal', level: 'local' },
  { suffix: 'lugo.es', level: 'local' },
  // Provincial capitals under 100,000 inhabitants, and Mérida (capital of Extremadura)
  { suffix: 'ayto-caceres.es', level: 'local' }, // Cáceres
  { suffix: 'caceres.es', level: 'local' },
  { suffix: 'guadalajara.es', level: 'local' }, // Guadalajara
  { suffix: 'toledo.es', level: 'local' }, // Toledo
  { suffix: 'pontevedra.gal', level: 'local' }, // Pontevedra
  { suffix: 'aytopalencia.es', level: 'local' }, // Palencia
  { suffix: 'ciudadreal.es', level: 'local' }, // Ciudad Real
  { suffix: 'merida.es', level: 'local' }, // Mérida
  { suffix: 'zamora.es', level: 'local' }, // Zamora (sede on zamora.sedelectronica.es)
  { suffix: 'avila.es', level: 'local' }, // Ávila
  { suffix: 'huesca.es', level: 'local' }, // Huesca
  { suffix: 'cuenca.es', level: 'local' }, // Cuenca
  { suffix: 'segovia.es', level: 'local' }, // Segovia
  { suffix: 'soria.es', level: 'local' }, // Soria (sede on soria.sedelectronica.es)
  { suffix: 'teruel.es', level: 'local' }, // Teruel
  // Diputaciones provinciales and forales, and their sede platforms for small towns. Several
  // provinces host town sedes on each town's own domain (Cádiz, Huelva, Sevilla, Badajoz,
  // A Coruña): those can't be covered by a suffix.
  { suffix: 'dipalme.org', level: 'local' }, // Almería (towns: sede.dipalme.org)
  { suffix: 'dipucadiz.es', level: 'local' }, // Cádiz
  { suffix: 'dipucordoba.es', level: 'local' }, // Córdoba
  { suffix: 'eprinsa.es', level: 'local' }, // Córdoba's IT company (towns: sede.eprinsa.es/<town>)
  { suffix: 'dipgra.es', level: 'local' }, // Granada
  { suffix: 'diphuelva.es', level: 'local' }, // Huelva
  { suffix: 'dipujaen.es', level: 'local' }, // Jaén
  { suffix: 'malaga.es', level: 'local' }, // Málaga (towns: sede.malaga.es/<town>)
  { suffix: 'prpmalaga.es', level: 'local' }, // Málaga's tax office (Patronato de Recaudación)
  { suffix: 'dipusevilla.es', level: 'local' }, // Sevilla
  { suffix: 'sedeelectronicadipusevilla.es', level: 'local' },
  { suffix: 'opaef.es', level: 'local' }, // Sevilla's tax office (OPAEF)
  { suffix: 'dip-badajoz.es', level: 'local' }, // Badajoz
  { suffix: 'dip-caceres.es', level: 'local' }, // Cáceres
  { suffix: 'diputacionalicante.es', level: 'local' }, // Alicante
  { suffix: 'dipcas.es', level: 'local' }, // Castellón
  { suffix: 'dival.es', level: 'local' }, // Valencia (towns: <town>.sede.dival.es)
  { suffix: 'dipualba.es', level: 'local' }, // Albacete
  { suffix: 'dipucr.es', level: 'local' }, // Ciudad Real (towns: sedescr.dipucr.es/<town>)
  { suffix: 'dipucuenca.es', level: 'local' }, // Cuenca
  { suffix: 'dguadalajara.es', level: 'local' }, // Guadalajara
  { suffix: 'diputoledo.es', level: 'local' }, // Toledo (sede on diputacion.toledo.gob.es)
  { suffix: 'diputacionavila.es', level: 'local' }, // Ávila
  { suffix: 'burgos.es', level: 'local' }, // Burgos (the Diputación, not the city)
  { suffix: 'diputaciondeburgos.es', level: 'local' },
  { suffix: 'dipuleon.es', level: 'local' }, // León
  { suffix: 'diputaciondepalencia.es', level: 'local' }, // Palencia
  { suffix: 'dip-palencia.es', level: 'local' },
  { suffix: 'lasalina.es', level: 'local' }, // Salamanca (sede on diputaciondesalamanca.gob.es)
  { suffix: 'dipsegovia.es', level: 'local' }, // Segovia
  { suffix: 'dipsoria.es', level: 'local' }, // Soria
  { suffix: 'diputaciondevalladolid.es', level: 'local' }, // Valladolid
  { suffix: 'diputaciondezamora.es', level: 'local' }, // Zamora
  { suffix: 'dphuesca.es', level: 'local' }, // Huesca
  { suffix: 'dpteruel.es', level: 'local' }, // Teruel
  { suffix: 'dpz.es', level: 'local' }, // Zaragoza
  { suffix: 'diba.cat', level: 'local' }, // Barcelona
  { suffix: 'ddgi.cat', level: 'local' }, // Girona
  { suffix: 'diputaciolleida.cat', level: 'local' }, // Lleida
  { suffix: 'dipta.cat', level: 'local' }, // Tarragona (towns: actio.dipta.cat)
  { suffix: 'dacoruna.gal', level: 'local' }, // A Coruña (town sedes: sede-<town>.dacoruna.gal)
  { suffix: 'deputacionlugo.gal', level: 'local' }, // Lugo
  { suffix: 'deputacionlugo.org', level: 'local' },
  { suffix: 'depourense.gal', level: 'local' }, // Ourense
  { suffix: 'depourense.es', level: 'local' },
  { suffix: 'depo.gal', level: 'local' }, // Pontevedra
  { suffix: 'araba.eus', level: 'local' }, // Álava (towns: udalenegoitza.araba.eus/<town>)
  { suffix: 'bizkaia.eus', level: 'local' }, // Bizkaia
  { suffix: 'bizkaia.net', level: 'local' },
  { suffix: 'ebizkaia.eus', level: 'local' },
  { suffix: 'gipuzkoa.eus', level: 'local' }, // Gipuzkoa (towns: udal.egoitza.gipuzkoa.eus)
  { suffix: 'gipuzkoa.net', level: 'local' },
  // Cabildos (Canarias) and Consells Insulars (Illes Balears)
  { suffix: 'sede.grancanaria.com', level: 'local' }, // Gran Canaria (not tourism)
  { suffix: 'tenerife.es', level: 'local' }, // Tenerife
  { suffix: 'cabildodelanzarote.com', level: 'local' }, // Lanzarote
  { suffix: 'cabildofuer.es', level: 'local' }, // Fuerteventura
  { suffix: 'cabildodelapalma.es', level: 'local' }, // La Palma
  { suffix: 'lagomera.es', level: 'local' }, // La Gomera
  { suffix: 'elhierro.es', level: 'local' }, // El Hierro
  { suffix: 'conselldemallorca.es', level: 'local' }, // Mallorca
  { suffix: 'conselldemallorca.cat', level: 'local' },
  { suffix: 'conselldemallorca.net', level: 'local' },
  { suffix: 'secimallorca.net', level: 'local' },
  { suffix: 'cime.es', level: 'local' }, // Menorca
  { suffix: 'www.carpetaciutadana.org', level: 'local' }, // Menorca's shared sede (Consell + towns)
  { suffix: 'conselldeivissa.es', level: 'local' }, // Eivissa
  { suffix: 'conselldeivissa.cat', level: 'local' },
  { suffix: 'conselldeformentera.cat', level: 'local' }, // Formentera
  { suffix: 'consellinsulardeformentera.cat', level: 'local' },
  { suffix: 'consellformentera.com', level: 'local' },
  // Shared sede platforms run by public bodies. Each subdomain is one entity's sede.
  { suffix: 'sedipualba.es', level: 'local' }, // Diputación de Albacete; 1,000+ bodies
  { suffix: 'seu-e.cat', level: 'local' }, // Consorci AOC: seu-e.cat/web/<town>
  { suffix: 'seu.cat', level: 'local' }, // Consorci AOC: e-TAULER, tràmits
  // Shared sede platforms run by a private vendor: esPublico Servicios para la Administración
  // S.A. (Gestiona). It issues one subdomain per customer, which are town councils, diputaciones
  // and other public-sector bodies (a few are publicly funded associations, e.g. local action
  // groups). Unknown names show a placeholder sede, not someone else's page. Trust tradeoff:
  // we rely on esPublico only issuing subdomains to its public customers.
  { suffix: 'sedelectronica.es', level: 'local' },
  { suffix: 'sedelectronica.gal', level: 'local' },
  { suffix: 'eadministracio.cat', level: 'local' },
  { suffix: 'egoitzaelektronikoa.eus', level: 'local' },
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

/** True if `host` is an official domain (or a dev/e2e extra trusted host). */
export function isOfficialHost(host: string): boolean {
  return (
    extraTrustedSuffixes.some((s) => hostMatchesSuffix(host, s)) ||
    OFFICIAL_DOMAINS.some((d) => hostMatchesSuffix(host, d.suffix))
  );
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
