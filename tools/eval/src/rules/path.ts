import { testRegex } from '../answers/text';

/**
 * A safe path into JSON-like data (`bench` conditions, tool call arguments, record filters).
 *
 * Segments are separated by dots. A segment is an own property name, an array index (negative
 * counts from the end), `length` of an array or string, or `*` for every item of an array or
 * every value of an object. Anything else resolves to nothing: the walk never reaches the
 * prototype chain.
 */

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

/** Splits and validates a path. Throws on empty or forbidden segments. */
export function parsePath(path: string): string[] {
  const segments = path.split('.');
  for (const segment of segments) {
    if (segment === '') throw new Error(`Invalid path "${path}": empty segment`);
    if (FORBIDDEN.has(segment))
      throw new Error(`Invalid path "${path}": "${segment}" is not allowed`);
  }
  return segments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every value the path reaches (several when it fans out with `*`). Empty when nothing matches. */
export function resolvePath(root: unknown, path: string | readonly string[]): unknown[] {
  const segments = typeof path === 'string' ? parsePath(path) : path;
  let current: unknown[] = [root];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      if (segment === '*') {
        if (Array.isArray(value)) next.push(...value);
        else if (isRecord(value)) next.push(...Object.values(value));
      } else if (Array.isArray(value)) {
        if (segment === 'length') next.push(value.length);
        else if (/^-?\d+$/.test(segment)) {
          const index = Number(segment);
          const at = index < 0 ? value.length + index : index;
          if (at >= 0 && at < value.length) next.push(value[at]);
        }
      } else if (typeof value === 'string' && segment === 'length') {
        next.push(value.length);
      } else if (isRecord(value) && Object.hasOwn(value, segment)) {
        next.push(value[segment]);
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current;
}

/** Structural equality of JSON-like values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

export interface ValueComparison {
  equals?: unknown;
  matches?: RegExp;
  gte?: number;
  lte?: number;
}

/** Whether one value satisfies every comparison that is set. */
export function compareValue(value: unknown, comparison: ValueComparison): boolean {
  if ('equals' in comparison && !deepEqual(value, comparison.equals)) return false;
  if (comparison.matches !== undefined) {
    const scalar =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    if (!scalar || !testRegex(comparison.matches, String(value))) return false;
  }
  if (comparison.gte !== undefined && !(typeof value === 'number' && value >= comparison.gte)) {
    return false;
  }
  if (comparison.lte !== undefined && !(typeof value === 'number' && value <= comparison.lte)) {
    return false;
  }
  return true;
}

/** Whether any value reached by the path satisfies the comparison (no comparison: it exists). */
export function pathSatisfies(
  root: unknown,
  path: string | readonly string[],
  comparison: ValueComparison,
): { matched: boolean; values: unknown[] } {
  const values = resolvePath(root, path);
  const constrained =
    'equals' in comparison ||
    comparison.matches !== undefined ||
    comparison.gte !== undefined ||
    comparison.lte !== undefined;
  const matched = constrained
    ? values.some((value) => compareValue(value, comparison))
    : values.some((value) => value !== undefined && value !== null);
  return { matched, values };
}

/** A compact rendering of resolved values for details (never more than `max` characters). */
export function showValues(values: readonly unknown[], max = 160): string {
  if (values.length === 0) return 'not found';
  let text: string;
  try {
    text = JSON.stringify(values.length === 1 ? values[0] : values) ?? 'undefined';
  } catch {
    text = String(values);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
