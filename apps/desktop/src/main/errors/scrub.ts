import type { ScrubResult } from '@sa/pii';

/** Top-level fields that may identify the user or the machine, or hold browsing history. */
const DROP = new Set(['user', 'request', 'breadcrumbs', 'server_name', 'modules']);

/** Top-level fields that are ids, enums or numbers: never personal data, left as they are. */
const KEEP = new Set([
  'event_id',
  'timestamp',
  'start_timestamp',
  'level',
  'platform',
  'release',
  'dist',
  'environment',
  'sdk',
  'type',
]);

/**
 * Removes personal data from an error report before it leaves the device (D29): no user, request,
 * breadcrumbs or machine name, and every remaining string with the home folder replaced by `~`
 * (paths carry the account name) and Spanish PII (DNI, IBAN, phone, e-mail…) replaced by
 * placeholders.
 */
export function scrubReport<T extends object>(
  event: T,
  opts: { homeDir: string; scrubPii: (text: string) => ScrubResult },
): T {
  const homes = [opts.homeDir, opts.homeDir.replaceAll('\\', '/')].filter((h) => h.length > 1);
  const text = (value: string): string => {
    let out = value;
    for (const home of homes) out = out.replaceAll(home, '~');
    return opts.scrubPii(out).text;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [text(k), walk(v)]));
    return value;
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (DROP.has(key)) continue;
    out[key] = KEEP.has(key) ? value : walk(value);
  }
  return out as T;
}
