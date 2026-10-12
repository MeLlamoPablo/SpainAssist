/** Ids of app secrets stored in the vault (values never leave the main process). */
export const SECRET_IDS = {
  /** JSON { credential: PiCredential, account?: string } from "Sign in with ChatGPT". */
  chatgpt: 'provider.chatgpt',
  /** Development builds only. JSON { credential: PiCredential, account?: string } from Codex. */
  codex: 'provider.codex',
  /** LiteLLM key (our gateway) issued for a voucher. */
  voucher: 'provider.voucher',
  /** Bring-your-own-key API key. */
  byok: 'provider.byok',
  /** API key of a custom OpenAI-compatible endpoint. */
  custom: 'provider.custom',
} as const;

/** Personal fields whose values are categories, not identifiers (not scrubbed from text). */
const NON_IDENTIFYING_KEYS = new Set([
  'documentType',
  'sex',
  'nationality',
  'addressCountry',
  'addressProvince',
  'maritalStatus',
]);

const norm = (v: string) =>
  v
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();

/**
 * Values to remove from any text that leaves the device: everything the vault considers
 * sensitive, minus very short values and pure categories ("DNI", "M", "España"...), which would
 * otherwise destroy useful text without protecting anyone.
 */
export function scrubbableKnownValues(vault: {
  knownSensitiveValues(): string[];
  listPersonal(): { key: string; value: string }[];
}): string[] {
  const categories = new Set(
    vault
      .listPersonal()
      .filter((p) => NON_IDENTIFYING_KEYS.has(p.key))
      .map((p) => norm(p.value)),
  );
  return vault.knownSensitiveValues().filter((v) => {
    const n = norm(v);
    return n.length >= 3 && !categories.has(n);
  });
}
