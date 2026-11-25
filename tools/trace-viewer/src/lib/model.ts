/**
 * What the viewer draws: a tree of timed spans per trace. Times are epoch milliseconds, so spans
 * from different files (an agent's pi session, a Playwright trace) line up on one clock.
 */
import type { EvalCheck } from './checks.ts';

export type SpanKind =
  /** A whole agent session (the root). */
  | 'agent'
  /** What one user message (or a run's report) set off, until the next. */
  | 'turn'
  /** One model request. */
  | 'llm'
  /** A tool call of the model (`codemode`, the coordinator's tools). */
  | 'tool'
  /** A codemode run: the module executing (`spainassist.run_trace`). */
  | 'run'
  /** One `api.*` call of a run. */
  | 'op'
  /** A run's interface, open until the user answered it. */
  | 'wait'
  /** A Playwright call (from a trace.zip). */
  | 'browser'
  /** A Playwright trace, as a root. */
  | 'page';

type SpanStatus = 'ok' | 'error' | 'running';

export interface Span {
  id: string;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  start: number;
  /** Missing while running (or when the session ends before it finished). */
  end?: number;
  /** Muted text after the name: a model, a URL, a selector. */
  detail?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  /** Dollars, as the provider reported them (agents add their children's up). */
  cost?: number;
  input?: string;
  output?: string;
  error?: string;
  /** Extra facts shown in the details panel. */
  attrs?: [string, string][];
  /** The Playwright trace this span comes from (browser spans). */
  browser?: { traceId: string; callId?: string };
  /** The model's id of a tool call (`tool` spans). */
  toolCallId?: string;
  /** An eval run's checks that this span made pass or fail (`placeChecks`). */
  checks?: EvalCheck[];
  children: Span[];
}

/** A screenshot of a page (Playwright's screencast). */
export interface Frame {
  at: number;
  width: number;
  height: number;
  pageId: string;
  read(): Promise<Uint8Array>;
}

/** One Playwright trace.zip. */
export interface BrowserTrace {
  id: string;
  title: string;
  /** The procedure whose browser it recorded (browser captures). */
  procedureId?: string;
  /** Where it was found, e.g. `procedures/p_…/capture/<run>/trace.zip`. */
  path: string;
  root: Span;
  frames: Frame[];
  /** Its bytes, for the Playwright trace viewer. */
  read(): Promise<Uint8Array>;
}

type TraceGroup = 'coordinator' | 'agent' | 'browser';

export interface Trace {
  id: string;
  group: TraceGroup;
  title: string;
  subtitle?: string;
  path: string;
  root: Span;
  /** Procedures the agent served (agent.json), to find its browser captures. */
  procedures: string[];
  /** Playwright traces whose actions were placed in this trace. */
  browser: BrowserTrace[];
}

/** Every span of a tree, depth first. */
export function* walk(span: Span): Generator<Span> {
  yield span;
  for (const child of span.children) yield* walk(child);
}

/** A span's ids and texts a search looks in: its name, detail, tool call id and facts (a run id). */
function searchable(span: Span): (string | undefined)[] {
  return [
    span.id,
    span.name,
    span.detail,
    span.toolCallId,
    ...(span.attrs ?? []).map(([, v]) => v),
  ];
}

/** Whether one of a span's ids or texts contains `query` (any case). */
export function spanMatches(span: Span, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q !== '' && searchable(span).some((v) => v?.toLowerCase().includes(q));
}

/**
 * The span a search leads to, in the traces' order: one whose id or text is `query` exactly (a
 * pasted run id or tool call id) before one that only contains it.
 */
export function findSpan(
  traces: readonly Trace[],
  query: string,
): { trace: Trace; span: Span; exact: boolean } | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  let partial: { trace: Trace; span: Span; exact: boolean } | undefined;
  for (const trace of traces) {
    for (const span of walk(trace.root)) {
      if (searchable(span).some((v) => v?.toLowerCase() === q)) return { trace, span, exact: true };
      if (!partial && spanMatches(span, q)) partial = { trace, span, exact: false };
    }
  }
  return partial;
}

/** Cost of a span and everything under it. */
export function totalCost(span: Span): number {
  let sum = 0;
  for (const s of walk(span)) sum += s.cost ?? 0;
  return sum;
}

export function totalTokens(span: Span): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const s of walk(span)) {
    input += s.tokensIn ?? 0;
    output += s.tokensOut ?? 0;
  }
  return { input, output };
}

/** Failed spans that are the cause: none of their children failed (an op and its click count once). */
export function failures(span: Span): Span[] {
  const out: Span[] = [];
  for (const s of walk(span))
    if (s.status === 'error' && !s.children.some((c) => c.status === 'error')) out.push(s);
  return out;
}
