/**
 * The run's secrets, looked for in everything a model is sent. The meter sees every request body of
 * every agent of the run (system prompt, user messages, tool results, compaction summaries, what
 * the answerer is asked), so it is the one place that can say a registered secret (the persona's
 * Cl@ve password) reached a model, however it got there.
 *
 * A secret is looked for as it is, and in the spellings a body can hold it in: escaped for JSON
 * (once for a field, twice for a tool result that is JSON text, a third time for that inside
 * another), percent-encoded and form-encoded, and hidden by an encoding (base64 at any of the
 * three byte alignments, hex, base32: `encodedNeedles` of the canary scanner). Screenshots are not
 * scanned (a data URL is cut out first: a picture of a screen cannot be searched, and its bytes
 * would only match a short secret by chance).
 *
 * Values shorter than six characters are not registered, as in every other registry of the meter:
 * a request body is large, and a short value is in one by chance.
 */
import { encodedNeedles } from '../net/canary';

const MIN_SECRET_LENGTH = 6;
/** Below this length the encodings are not searched: a short needle would match by chance. */
const MIN_ENCODED_LENGTH = 8;
/** How many times a string can be escaped on its way into a body: a field, JSON in a field, JSON in that. */
const ESCAPE_LEVELS = 3;

/** How a secret was found. */
export type SecretForm = 'plain' | 'escaped' | 'url' | 'encoded';

const DATA_URL = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]{256,}/gi;

function escapeJson(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

export class RequestSecrets {
  /** Needle to the form it is looked for in, in the order they are tried. */
  private readonly needles = new Map<string, SecretForm>();

  /** Registers a secret (a value that is too short is ignored). */
  add(value: string | null | undefined): void {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
    const put = (needle: string, form: SecretForm) => {
      if (needle.length >= MIN_SECRET_LENGTH && !this.needles.has(needle)) {
        this.needles.set(needle, form);
      }
    };
    put(value, 'plain');
    let escaped = value;
    for (let level = 0; level < ESCAPE_LEVELS; level++) {
      escaped = escapeJson(escaped);
      put(escaped, 'escaped');
    }
    try {
      const uri = encodeURIComponent(value);
      put(uri, 'url');
      put(uri.replace(/%20/g, '+'), 'url');
      put(encodeURI(value), 'url');
    } catch {
      // a lone surrogate has no percent-encoding: the other spellings remain
    }
    if (value.length >= MIN_ENCODED_LENGTH) {
      for (const needle of encodedNeedles(value)) put(needle, 'encoded');
    }
  }

  get size(): number {
    return this.needles.size;
  }

  /** The forms in which a registered secret is in `text`, empty when none is. */
  scan(text: string): SecretForm[] {
    if (this.needles.size === 0) return [];
    const body = text.replace(DATA_URL, '');
    const found = new Set<SecretForm>();
    for (const [needle, form] of this.needles) {
      if (!found.has(form) && body.includes(needle)) found.add(form);
    }
    return [...found];
  }
}
