/**
 * Text helpers shared by the answer matchers and the rule conditions: diacritic folding and
 * regular expressions that are safe to reuse (`g`/`y` flags keep state in `lastIndex`).
 */

const COMBINING_MARKS = /\p{M}/gu;

/** "Cl@ve Móvil" -> "Cl@ve Movil". Case is kept. */
export function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
}

const stateless = new WeakMap<RegExp, RegExp>();

/** `pattern.test(subject)` without the `lastIndex` state of `g` and `y` expressions. */
export function testRegex(pattern: RegExp, subject: string): boolean {
  if (!pattern.global && !pattern.sticky) return pattern.test(subject);
  let safe = stateless.get(pattern);
  if (!safe) {
    safe = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
    stateless.set(pattern, safe);
  }
  return safe.test(subject);
}

/**
 * Whether the pattern matches the text as it is or with its accents removed, so a pattern
 * written with or without accents ("autenticación", "autenticacion") finds both spellings.
 */
export function testPattern(pattern: RegExp, subject: string): boolean {
  return testRegex(pattern, subject) || testRegex(pattern, stripDiacritics(subject));
}

const compiled = new Map<string, RegExp>();

/**
 * Compiles the case-insensitive regular expression of an `AnswerMatcher` field. Throws a
 * descriptive error for an invalid expression (fixtures are validated with it).
 */
export function compilePattern(source: string, where: string): RegExp {
  const cached = compiled.get(source);
  if (cached) return cached;
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, 'i');
  } catch (error) {
    throw new Error(
      `${where}: invalid regular expression /${source}/ (${(error as Error).message})`,
    );
  }
  compiled.set(source, pattern);
  return pattern;
}

/** Matches a host against an exact name or a `*.suffix` pattern (the suffix itself included). */
export function hostMatches(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  const p = normalizeHost(pattern);
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith(`.${suffix}`);
  }
  return h === p;
}

/** Lowercase, no trailing dot and no port. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/** One line, at most `max` characters, for details and notes. */
export function shorten(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
