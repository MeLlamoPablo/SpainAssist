/**
 * An eval run's checks (`tools/eval`: the fixture's rules, as `result.json` judged them) on the
 * spans that made them pass or fail. The server reads the run (`src/server/eval.ts`) and gives
 * each check the time its condition first held and the tool calls in flight then; here each
 * check goes on the innermost span of that moment: a run's `api.*` call, else the tool call.
 */
import { type Span, type Trace, walk } from './model.ts';

/** The file the server adds to an eval run's listing. */
export const EVAL_FILE = 'eval.json';

export interface EvalHarm {
  id: string;
  /** Above 0: a run that shows it scores minus this. */
  penalty: number;
  /** Rule ids, and whether each one's condition was ever true: all must hold. */
  when: Record<string, 'matched' | 'unmatched'>;
}

export interface EvalCheck {
  ruleId: string;
  kind: 'required' | 'scored' | 'precondition';
  negate: boolean;
  /** Whether the condition was ever true. */
  matched: boolean;
  /** Required: ok. Scored: earned. Precondition: held. */
  passed: boolean;
  /** What the rule asks for (from the fixture). */
  description?: string;
  /** How the eval judged it. */
  detail?: string;
  /** A scored rule's weight (from the fixture). */
  weight?: number;
  /** When the condition first held (epoch ms). */
  at?: number;
  /** The event at which the eval first found it true, in short (the rules are judged per event). */
  seen?: string;
  /** Tool calls in flight then, the first started first. */
  toolCallIds?: string[];
  /** The fixture's harms that name this rule. */
  harms?: EvalHarm[];
  /** Where the loader placed it. */
  traceId?: string;
  spanId?: string;
  /** What its outcome does to the run (`consequence`), filled by the loader. */
  consequence?: string;
}

export interface EvalRun {
  runId: string;
  fixtureId: string;
  fixtureTitle?: string;
  status: string;
  /** 0..1, below 0 for a harm, null without a score. */
  score: number | null;
  /** The harms the run showed. */
  harms?: string[];
  endedBy?: string;
  /** The scored rules' weights, added up (from the fixture). */
  totalWeight?: number;
  /** Whether the fixture was found, for descriptions, weights and harms. */
  fixtureKnown: boolean;
  checks: EvalCheck[];
}

/** Slack between the eval's clock and the agents' (the same machine, read at other points). */
const SLACK_MS = 50;
/** How long after a span a check can still be its doing (a message logged after its model call). */
const AFTER_MS = 30_000;
const HOSTS = new Set<Span['kind']>(['tool', 'run', 'op', 'wait', 'llm']);

/** Puts each check that has a time on its span (`span.checks`), and notes where on the check. */
export function placeChecks(run: EvalRun, traces: Trace[]): void {
  const agents = traces.filter((t) => t.group !== 'browser');
  const tools = new Map<string, { span: Span; trace: Trace }>();
  for (const trace of agents)
    for (const span of walk(trace.root))
      if (span.toolCallId) tools.set(span.toolCallId, { span, trace });

  for (const check of run.checks) {
    if (check.at === undefined) continue;
    const at = check.at;
    const host = [...(check.toolCallIds ?? [])]
      .reverse()
      .map((id) => tools.get(id))
      .find(Boolean);
    const place = host
      ? { span: innermost([host.span], at) ?? host.span, trace: host.trace }
      : around(agents, at);
    if (!place) continue;
    place.span.checks = [...(place.span.checks ?? []), check];
    check.traceId = place.trace.id;
    check.spanId = place.span.id;
  }
}

/** The shortest span under these roots that was in flight at `at`. */
function innermost(roots: Span[], at: number): Span | undefined {
  let best: Span | undefined;
  for (const root of roots)
    for (const span of walk(root)) {
      if (!HOSTS.has(span.kind)) continue;
      if (span.start - SLACK_MS > at || (span.end ?? Number.POSITIVE_INFINITY) + SLACK_MS < at)
        continue;
      if (!best || length(span) < length(best)) best = span;
    }
  return best;
}

/** The span in flight at `at` in any agent, else the last one that ended shortly before it. */
function around(traces: Trace[], at: number): { span: Span; trace: Trace } | undefined {
  for (const trace of traces) {
    const span = innermost([trace.root], at);
    if (span) return { span, trace };
  }
  let best: { span: Span; trace: Trace } | undefined;
  for (const trace of traces)
    for (const span of walk(trace.root)) {
      if (!HOSTS.has(span.kind) || span.end === undefined) continue;
      if (span.end > at || at - span.end > AFTER_MS) continue;
      if (!best || span.end > (best.span.end ?? 0)) best = { span, trace };
    }
  return best;
}

function length(span: Span): number {
  return (span.end ?? Number.POSITIVE_INFINITY) - span.start;
}

/** What a check's outcome does to the run's score, in a sentence or two. */
export function consequence(check: EvalCheck, run: EvalRun): string {
  const lines = [outcomeEffect(check, run), ...harmEffects(check, run)];
  if (isStop(check, run)) lines.push('The eval stopped the run here.');
  return lines.join(' ');
}

function outcomeEffect(check: EvalCheck, run: EvalRun): string {
  if (check.kind === 'precondition')
    return check.passed
      ? 'Precondition met: the run can be scored.'
      : 'Precondition failed: the run is inconclusive and has no score.';
  if (check.kind === 'required') {
    if (check.passed && check.negate) return 'Required: it never happened, as it must.';
    if (check.passed) return 'Required, met: without it the run would fail with score 0.';
    if (check.negate)
      return 'Required: this must never happen. It happened, so the run fails: score 0.';
    return 'Required, never met: the run fails, score 0.';
  }
  const share =
    check.weight !== undefined && run.totalWeight
      ? ` ${check.weight} of ${run.totalWeight} points (${check.passed ? '+' : '−'}${percent(check.weight / run.totalWeight)})`
      : ' its share of the score';
  const effect = `Scored: ${check.passed ? 'earns' : 'loses'}${share}.`;
  if (run.status !== 'failed_required' && !run.harms?.length) return effect;
  return `${effect} It does not count: a required check failed, so the run scores ${percent(run.score ?? 0)}.`;
}

function harmEffects(check: EvalCheck, run: EvalRun): string[] {
  return (check.harms ?? [])
    .filter((harm) => (harm.when[check.ruleId] === 'matched') === check.matched)
    .map((harm) =>
      run.harms?.includes(harm.id)
        ? `Harm "${harm.id}": the run scores −${percent(harm.penalty)}.`
        : `Part of harm "${harm.id}" (−${percent(harm.penalty)}), but its other conditions did not hold.`,
    );
}

/** The negated required check that ended the run (`endedBy: required-failed`): the first seen. */
function isStop(check: EvalCheck, run: EvalRun): boolean {
  if (run.endedBy !== 'required-failed' || check.kind !== 'required' || !check.negate) return false;
  if (check.passed || check.at === undefined) return false;
  const first = run.checks
    .filter((c) => c.kind === 'required' && c.negate && !c.passed && c.at !== undefined)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))[0];
  return first === check;
}

function percent(share: number): string {
  return `${share < 0 ? '−' : ''}${Math.round(Math.abs(share) * 1000) / 10}%`;
}
