import { encodedNeedles } from '../net/canary';

/**
 * Redaction for everything the suite persists or emits: ledger lines, events, run and result files,
 * bench state, net logs, transcripts, answerer transcripts, miss diagnostics, and the recorded
 * model answers of the cache. One implementation (`SecretMasker`) serves every layer, so a secret
 * is masked in the same spellings and from the same length in all of them.
 *
 * What is registered, and why:
 * - the passwords of a fixture's credential answers and seeded Cl@ve accounts (`fixtureSecrets`),
 *   the typed secrets of a run;
 * - the tokens of the model credential in use (access, refresh, api key, id token) and what the
 *   meter sees in a request's `Authorization`, `x-api-key` and `chatgpt-account-id` headers;
 * - never the placeholders of mock and replay runs (`credentialSecrets` skips them: they are not
 *   secrets, and a placeholder that is an ordinary word would mangle the text of every file), and
 *   never a value shorter than `MIN_SECRET_LENGTH`.
 *
 * Why four characters: a shorter value (a 3-digit code, a year) occurs in ordinary text, and masking
 * it would corrupt every log; four-digit PINs still are masked. `validateFixture` rejects a fixture
 * password shorter than the minimum, so a fixture cannot silently stay unmasked.
 *
 * Spellings of a secret that are masked: as it is, JSON-escaped (also with `\uXXXX` for non-ASCII,
 * and each of the others again JSON-escaped, since the logs are JSON lines), HTML-escaped, percent-encoded (`encodeURIComponent`, `encodeURI`, the `+` of a form), and, from
 * eight characters of encoded text on, base64 and base64url at the three byte alignments, hex in
 * both cases and base32 (the characters that the secret's own bytes fully determine, so the text
 * around it does not matter).
 */

/** Values shorter than this are not treated as secrets (they would mangle ordinary text). */
export const MIN_SECRET_LENGTH = 4;

const BEARER = /\bBearer\s+[^\s"',;]+/gi;
const API_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Every way `secret` may be written in a URL, a form body, JSON, HTML or an encoded blob. */
export function secretSpellings(secret: string): string[] {
  const spellings = new Set<string>([secret]);
  try {
    const uri = encodeURIComponent(secret);
    spellings.add(uri);
    spellings.add(uri.replace(/%20/g, '+'));
    spellings.add(encodeURI(secret));
    spellings.add(new URLSearchParams([['', secret]]).toString().slice(1));
  } catch {
    // lone surrogates: only the plain, JSON and HTML spellings remain
  }
  // JSON.stringify never throws for a string; slice drops the surrounding quotes.
  const json = JSON.stringify(secret).slice(1, -1);
  spellings.add(json);
  // Writers that escape everything outside ASCII (Python's default, PHP).
  spellings.add(
    json.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`),
  );
  spellings.add(secret.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] as string));
  for (const needle of encodedNeedles(secret)) spellings.add(needle);
  // The logs are JSON lines, and tool arguments are JSON inside them: whatever of the above has a
  // quote or a backslash is escaped again for each JSON string it is written inside of.
  for (let depth = 0; depth < 2; depth++) {
    for (const spelling of [...spellings]) spellings.add(JSON.stringify(spelling).slice(1, -1));
  }
  // Longest first, so a spelling that contains another one is masked whole.
  return [...spellings].filter(Boolean).sort((a, b) => b.length - a.length);
}

/** Masks a set of secrets, in every spelling of `secretSpellings`, with one fixed mask. */
export class SecretMasker {
  private readonly values = new Set<string>();
  private spellings: string[] | undefined;

  constructor(private readonly maskText: string) {}

  /** Registers a secret; false when it is not one (too short, not a string) or known already. */
  add(value: string | undefined | null): boolean {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return false;
    if (this.values.has(value)) return false;
    this.values.add(value);
    this.spellings = undefined;
    return true;
  }

  /** The registered secrets as they were given (raw form). */
  list(): string[] {
    return [...this.values];
  }

  get size(): number {
    return this.values.size;
  }

  /** Every registered spelling, longest first. */
  allSpellings(): string[] {
    this.spellings ??= [
      ...new Set([...this.values].flatMap((secret) => secretSpellings(secret))),
    ].sort((a, b) => b.length - a.length);
    return this.spellings;
  }

  /** Whether the text carries a registered secret in any spelling. */
  has(text: string): boolean {
    return this.allSpellings().some((spelling) => text.includes(spelling));
  }

  mask(text: string): string {
    let out = text;
    for (const spelling of this.allSpellings()) {
      if (out.includes(spelling)) out = out.split(spelling).join(this.maskText);
    }
    return out;
  }
}

export function redactPatterns(text: string): string {
  return text
    .replace(BEARER, 'Bearer [redacted]')
    .replace(API_KEY, 'sk-[redacted]')
    .replace(JWT, '[redacted-jwt]');
}

// ---------------------------------------------------------------------------------------------
// What a recording of a model answer must not keep
// ---------------------------------------------------------------------------------------------

/**
 * JSON fields of a model answer that name the account behind the key. Codex's Responses events
 * carry `safety_identifier`, which is the ChatGPT user id of whoever recorded.
 */
const ACCOUNT_FIELDS =
  /"(safety_identifier|user|user_id|chatgpt_user_id|chatgpt_account_id|account_id|organization|organization_id|org_id|project|project_id|email)"\s*:\s*"(?:[^"\\]|\\.)*"/g;

/** Claims of an access token that identify the account (`https://api.openai.com/auth` and more). */
const IDENTITY_CLAIMS = new Set([
  'chatgpt_account_id',
  'chatgpt_user_id',
  'chatgpt_account_user_id',
  'user_id',
  'account_id',
  'organization_id',
  'org_id',
  'email',
  'sub',
]);

/** Response headers of a provider that identify or describe the account, never replayed. */
const ACCOUNT_HEADERS =
  /^(x-codex-|x-ratelimit-|x-litellm-key-|openai-organization$|openai-project$)/i;

function claimsOf(token: string): unknown {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** The account-identifying strings in the claims of a JWT (any depth, `organizations[].id` too). */
function identitiesIn(value: unknown, out: string[] = [], parent = ''): string[] {
  if (Array.isArray(value)) {
    for (const item of value) identitiesIn(item, out, parent);
  } else if (value && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) {
      const identity = IDENTITY_CLAIMS.has(name) || (parent === 'organizations' && name === 'id');
      if (identity && typeof item === 'string') out.push(item);
      else identitiesIn(item, out, name);
    }
  }
  return out;
}

export class SecretRegistry {
  private readonly secrets = new SecretMasker('[redacted]');
  /** Account identifiers learnt from tokens: masked in recordings, never a reason to skip one. */
  private readonly identities = new SecretMasker('[redacted-id]');

  add(value: string | undefined | null): void {
    this.secrets.add(value);
  }

  /** The registered secrets as they were given. */
  list(): string[] {
    return this.secrets.list();
  }

  /**
   * Registers the token of an `Authorization: Bearer <token>` header value, and the account
   * identifiers in its claims (user id, account id, e-mail) for the recordings.
   */
  addAuthorization(header: string | undefined): void {
    if (!header) return;
    const token = header.replace(/^Bearer\s+/i, '').trim();
    this.add(token);
    for (const identity of identitiesIn(claimsOf(token))) this.identities.add(identity);
  }

  has(text: string): boolean {
    return this.secrets.has(text);
  }

  /** Masks registered secrets and anything that looks like a bearer token, API key or JWT. */
  redact(text: string): string {
    return redactPatterns(this.secrets.mask(text));
  }

  /**
   * A model answer as it may be kept in the cache (and committed): the account fields of its JSON
   * (`safety_identifier`, ...) and every identifier of the account in use blanked, wherever they
   * occur. Applies to JSON and to the SSE frames around it alike.
   */
  scrubRecordedBody(text: string): string {
    return this.identities.mask(text.replace(ACCOUNT_FIELDS, '"$1":"[redacted-id]"'));
  }

  /** The response headers worth replaying, without the ones that describe the account or plan. */
  scrubRecordedHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!ACCOUNT_HEADERS.test(name)) out[name] = this.identities.mask(value);
    }
    return out;
  }
}
