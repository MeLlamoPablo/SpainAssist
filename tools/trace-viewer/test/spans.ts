/** Span trees for tests: times are milliseconds after `t0`, ids are the names. */
import type { Span, SpanKind, Trace } from '../src/lib/model';

export const t0 = Date.parse('2026-11-24T08:28:00.000Z');

export function span(
  kind: SpanKind,
  name: string,
  from: number,
  to: number,
  children: Span[] = [],
  extra: Partial<Span> = {},
): Span {
  return { id: name, name, kind, status: 'ok', start: t0 + from, end: t0 + to, children, ...extra };
}

export function trace(root: Span): Trace {
  return {
    id: root.id,
    group: 'agent',
    title: root.name,
    path: root.id,
    root,
    procedures: [],
    browser: [],
  };
}
