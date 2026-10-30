/**
 * Errors thrown by the browser service. Messages are written for the model (short, actionable,
 * English) and never contain secrets or Playwright call logs.
 */

export type BrowserErrorCode =
  /** The ref is not in the latest snapshot (page changed, or a typo). */
  | 'stale_ref'
  /** The ref string is not a ref at all. */
  | 'invalid_ref'
  /** No tab is open for this procedure. */
  | 'no_page'
  /** Bad arguments (unknown tab index, bad URL, unknown option...). */
  | 'bad_input'
  /** Navigation failed (DNS, connection refused, TLS...). */
  | 'navigation'
  /** The action could not be performed on the element. */
  | 'action'
  /** Client-certificate problem (wrong password, unreadable file...). */
  | 'certificate'
  /** The element did not match what the caller required (e.g. not a password field). */
  | 'expectation_failed'
  /** The service was shut down. */
  | 'closed'
  /** The browser keeps closing by itself right after launch, so the service stopped relaunching it. */
  | 'unavailable'
  | 'internal';

export class BrowserError extends Error {
  readonly code: BrowserErrorCode;
  constructor(code: BrowserErrorCode, message: string) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes in Playwright errors
const ANSI = /\u001b\[[0-9;]*m/g;

/** First meaningful part of a Playwright error message, without the call log. */
export function cleanPlaywrightMessage(message: string): string {
  const withoutLog = message.split(/\n\s*(?:Call log|=+ logs =+):?/)[0] ?? message;
  return withoutLog
    .replace(ANSI, '')
    .replace(/^(?:\w+\.)+\w+: /, '') // "locator.click: " / "page.goto: "
    .trim()
    .slice(0, 400);
}

/** Replaces every secret (and its common encodings) in `text` with "••••". */
export function maskSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  return out;
}

export const MASK = '••••';

/** Variants of a secret as it may appear in URLs, form bodies or escaped strings. */
export function secretVariants(secret: string): string[] {
  const variants = new Set<string>([secret]);
  try {
    const uri = encodeURIComponent(secret);
    variants.add(uri);
    variants.add(uri.replace(/%20/g, '+'));
    variants.add(encodeURI(secret));
    // application/x-www-form-urlencoded, as in the URL of a GET form submission
    variants.add(new URLSearchParams([['', secret]]).toString().slice(1));
  } catch {
    // lone surrogates: ignore
  }
  variants.add(JSON.stringify(secret).slice(1, -1));
  // Longest first so that a variant containing another is replaced whole.
  return [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
}

/**
 * Turns any error from an action into a model-friendly BrowserError. `secrets` are masked from
 * the message as a last line of defense.
 */
export function toActionError(
  err: unknown,
  what: string,
  secrets: Iterable<string> = [],
): BrowserError {
  if (err instanceof BrowserError) {
    return new BrowserError(err.code, maskSecrets(err.message, secrets));
  }
  const raw = err instanceof Error ? err.message : String(err);
  const msg = cleanPlaywrightMessage(raw);
  let friendly: string;
  if (/intercepts pointer events/i.test(raw)) {
    friendly = `Could not ${what}: another element is on top of it (for example a cookie banner, a popup or a loading overlay). Close it or wait, then take a new snapshot.`;
  } else if (
    /Target (?:page, context or browser )?(?:has been )?closed|browser has been closed/i.test(raw)
  ) {
    friendly = `Could not ${what}: the tab was closed. Take a new snapshot.`;
  } else if (
    /element is not (?:an <input>|fillable)|Element is not an <input>, <textarea>|not an <input>, <textarea>, <select>/i.test(
      raw,
    )
  ) {
    friendly = `Could not ${what}: the element is not a text field. Use the ref of a textbox.`;
  } else if (/Malformed value/i.test(raw)) {
    friendly = `Could not ${what}: the field rejected the value format (date fields need YYYY-MM-DD, time fields HH:MM).`;
  } else if (/Not a checkbox or radio button/i.test(raw)) {
    friendly = `Could not ${what}: the element is not a checkbox or radio button.`;
  } else if (/Clicking the checkbox did not change its state/i.test(raw)) {
    friendly = `Could not ${what}: clicking it did not change its state. Take a new snapshot and check the page.`;
  } else if (/element is not enabled|element is disabled|is disabled/i.test(raw)) {
    friendly = `Could not ${what}: the element is disabled. Fill in what the page asks first, then take a new snapshot.`;
  } else if (/element is not editable|readonly/i.test(raw)) {
    friendly = `Could not ${what}: the field is read-only.`;
  } else if (/element is not visible|not visible|outside of the viewport/i.test(raw)) {
    friendly = `Could not ${what}: the element is not visible right now. Take a new snapshot.`;
  } else if (/Timeout \d+ms exceeded|timed out/i.test(raw)) {
    friendly = `Could not ${what}: it did not become ready in time (it may be hidden, disabled or covered). Take a new snapshot.`;
  } else if (/Unknown key/i.test(raw)) {
    friendly = `Could not ${what}: unknown key name. Use names like Enter, Tab, Escape, ArrowDown, Backspace or Control+A.`;
  } else {
    friendly = `Could not ${what}: ${msg}`;
  }
  return new BrowserError('action', maskSecrets(friendly, secrets));
}

export function staleRefError(ref: string): BrowserError {
  return new BrowserError(
    'stale_ref',
    `Ref ${ref} not found — take a new snapshot (the page may have changed) and use a ref from it.`,
  );
}
