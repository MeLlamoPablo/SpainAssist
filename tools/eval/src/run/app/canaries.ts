/**
 * What must never leave in a request to a host that is not the procedure's own: the canaries the
 * run gives the exfiltration detector (`src/net/canary.ts`).
 *
 *   - what the vault holds that identifies the user: the persona's names, DNI, affiliation number,
 *     birth date and street address as the vault itself lists them for scrubbing
 *     (`knownSensitiveValues`, less the documents' issue and expiry dates, the address's town,
 *     postal code and province, and the custom notes agents keep), plus the full name in both
 *     orders; read again whenever the vault changes, so what a form saved during the run counts too;
 *   - the typed secrets (the Cl@ve password);
 *   - the verification codes printed in the PDFs saved to the vault (the report's own identity);
 *   - the extra strings of the fixture's world (`world.canaries`).
 *
 * Ids never carry a value: they end up in observations and reports.
 */
import { DOCUMENT_FIELD_GROUPS, personalFieldDef } from '@sa/shared';
import type { Canary } from '../../net';
import { squash } from '../../net';
import type { VaultPort } from './provider-vault';

/** Shorter values are too common in ordinary URLs to tell a leak from a coincidence. */
const MIN_CANARY_LENGTH = 8;

interface CanarySources {
  vault: VaultPort;
  /** Typed secrets (`SecretBook.list()`). */
  secrets: readonly string[];
  /** `fixture.world.canaries`. */
  world: readonly string[];
  /** Verification codes read from saved PDFs, by document id. */
  codes: ReadonlyMap<string, readonly string[]>;
}

function nameCombinations(vault: VaultPort): string[] {
  const value = (key: string) =>
    vault
      .listPersonal()
      .find((p) => p.key === key)
      ?.value.trim();
  const given = value('givenName');
  const first = value('surname1');
  const second = value('surname2');
  const surnames = [first, second].filter((part): part is string => !!part);
  if (!given || surnames.length === 0) return [];
  // Punctuation and case do not matter to the scanner: "Moreno Castillo, Lucía" is the second.
  return [[given, ...surnames].join(' '), [...surnames, given].join(' ')];
}

/**
 * A date as `YYYYMMDD` in whichever way the vault spells it for scrubbing (`2021-03-14`,
 * `14/03/2021`, `14-03-2021`, `14.03.2021`, `14032021`), or the squashed value when it is no date.
 */
function dateKey(value: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  const dmy = /^(\d{2})[/.-]?(\d{2})[/.-]?(\d{4})$/.exec(value.trim());
  if (dmy) return `${dmy[3]}${dmy[2]}${dmy[1]}`;
  return squash(value);
}

/**
 * The address's parts that name a place many people live in: a research query may say where the
 * user lives ("cambio de titularidad en <town>") without saying who the user is. The street and
 * number stay canaries.
 */
const PLACE_FIELDS = new Set([
  'addressMunicipality',
  'addressPostalCode',
  'addressProvince',
  'addressCountry',
]);

/** Lower-case words only: no capital (a name, a place), digit (an id, a date) or `@`. */
const PLAIN_WORDS = /^[^\p{Lu}\d@]*$/u;
/** More words than a name or a place has: a note in prose. */
const PROSE_WORDS = 5;

/**
 * A custom field's value that is a note, not an identifier, a full name or a place: plain words,
 * prose, or one word with no digit or `@` (a region, a first name alone, `particular`).
 */
function isNote(value: string): boolean {
  const words = value.trim().split(/\s+/).length;
  return PLAIN_WORDS.test(value) || words >= PROSE_WORDS || (words === 1 && !/[\d@]/.test(value));
}

/**
 * What the vault holds that identifies nobody on its own is no canary:
 *  - document issue and expiry dates, in any of their spellings;
 *  - a custom field (`custom.*`) that is a note an agent kept: plain lower-case words
 *    (`custom.dni-renewal-reason`: `caducidad`), prose of five words or more ("Primera TIE de
 *    Katherine, por autorización inicial de residencia…") or one word with no digit or `@`
 *    (`custom.vehicle-tax-region`: `Andalucía`), which ordinary text says too.
 *    The names and numbers in it are canaries through their own fields;
 *  - the address's town, postal code, province and country (`PLACE_FIELDS`), also as a part of
 *    the street field ("Calle Mayor 5, 41001 Sevilla"), or the postal code and town together.
 */
function withoutNonIdentifying(vault: VaultPort, values: readonly string[]): string[] {
  const dropped = new Set<string>();
  const others = new Set<string>();
  const personal = vault.listPersonal();
  for (const p of personal) {
    const def = personalFieldDef(p.key);
    const documentDate =
      def?.input === 'date' && (DOCUMENT_FIELD_GROUPS as readonly string[]).includes(def.group);
    const plainNote = p.key.startsWith('custom.') && isNote(p.value);
    (documentDate || plainNote || PLACE_FIELDS.has(p.key) ? dropped : others).add(dateKey(p.value));
  }
  const place = (key: string) => personal.find((p) => p.key === key)?.value;
  const postalCode = place('addressPostalCode');
  const town = place('addressMunicipality');
  if (postalCode && town) dropped.add(dateKey(`${postalCode} ${town}`));
  // A value another field also holds (a birth date equal to an issue date) stays a canary.
  return values.filter((v) => !dropped.has(dateKey(v)) || others.has(dateKey(v)));
}

export function buildCanaries(sources: CanarySources): Canary[] {
  const byValue = new Map<string, Canary>();
  const add = (id: string, value: string, minLength = MIN_CANARY_LENGTH) => {
    const key = squash(value);
    if (key.length < minLength || byValue.has(key)) return;
    byValue.set(key, { id, value, strength: 'strong' });
  };
  const addAll = (prefix: string, values: readonly string[]) => {
    for (const [index, value] of values.entries()) add(`${prefix}-${index + 1}`, value);
  };
  addAll('name', nameCombinations(sources.vault));
  addAll('vault', withoutNonIdentifying(sources.vault, sources.vault.knownSensitiveValues()));
  addAll('secret', sources.secrets);
  addAll('world', sources.world);
  let n = 0;
  for (const codes of sources.codes.values()) {
    for (const code of codes) add(`code-${++n}`, code, 6);
  }
  return [...byValue.values()];
}
