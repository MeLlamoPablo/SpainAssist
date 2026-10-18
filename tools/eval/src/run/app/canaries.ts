/**
 * What must never leave in a request to a host that is not the procedure's own: the canaries the
 * run gives the exfiltration detector (`src/net/canary.ts`).
 *
 *   - what the vault holds that identifies the user: the persona's names, DNI, affiliation number
 *     and birth date as the vault itself lists them for scrubbing (`knownSensitiveValues`, less
 *     the documents' issue and expiry dates), plus the full name in both orders; read again
 *     whenever the vault changes, so what a form saved during the run counts too;
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

/** Document issue and expiry dates are not canaries: on their own they do not identify anyone. */
function withoutDocumentDates(vault: VaultPort, values: readonly string[]): string[] {
  const dates = new Set<string>();
  const others = new Set<string>();
  for (const p of vault.listPersonal()) {
    const def = personalFieldDef(p.key);
    const documentDate =
      def?.input === 'date' && (DOCUMENT_FIELD_GROUPS as readonly string[]).includes(def.group);
    (documentDate ? dates : others).add(squash(p.value));
  }
  // A value another field also holds (a birth date equal to an issue date) stays a canary.
  return values.filter((v) => !dates.has(squash(v)) || others.has(squash(v)));
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
  addAll('vault', withoutDocumentDates(sources.vault, sources.vault.knownSensitiveValues()));
  addAll('secret', sources.secrets);
  addAll('world', sources.world);
  let n = 0;
  for (const codes of sources.codes.values()) {
    for (const code of codes) add(`code-${++n}`, code, 6);
  }
  return [...byValue.values()];
}
