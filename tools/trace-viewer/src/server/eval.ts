/**
 * An eval run's checks (`tools/eval`), for the viewer to place on spans (`src/lib/checks.ts`):
 * the rule outcomes of `result.json`, each with the moment its condition first held
 * (`firstSeenAtSeq`, a `seq` of `events.jsonl`) and the tool calls in flight then. The fixture,
 * when `@sa/eval` still has it, adds what each rule asks for, the weights and the harms.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalCheck, EvalHarm, EvalRun } from '../lib/checks.ts';

interface RuleOutcome {
  ruleId: string;
  kind: 'required' | 'scored';
  negate: boolean;
  matched: boolean;
  passed: boolean;
  firstSeenAtSeq?: number;
  detail?: string;
}

interface RunResult {
  runId: string;
  fixtureId: string;
  status: string;
  score: number | null;
  rules: RuleOutcome[];
  preconditions?: RuleOutcome[];
  harms?: string[];
  endedBy?: string;
}

/** What the viewer needs of a fixture (`Fixture` of `@sa/eval`). */
export interface FixtureFacts {
  title?: string;
  rules: { id: string; kind: string; description?: string; weight?: number }[];
  harms?: EvalHarm[];
}

interface Event {
  type: string;
  seq: number;
  t?: string;
  toolCallId?: string;
  tool?: string;
  text?: string;
  what?: string;
  data?: unknown;
  record?: { t?: string; method?: string; url?: string; channel?: string };
  prompt?: { title?: string };
  answerId?: string;
}

/** Whether this folder is an eval run with a result. */
export function isEvalRun(dir: string): boolean {
  return existsSync(join(dir, 'run.json')) && existsSync(join(dir, 'result.json'));
}

/** The run's checks, with the fixture as `@sa/eval` has it now (when it loads). */
export async function readEvalRun(dir: string): Promise<EvalRun> {
  const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as RunResult;
  const events = existsSync(join(dir, 'events.jsonl'))
    ? readFileSync(join(dir, 'events.jsonl'), 'utf8')
    : '';
  return evalRun(result, events, await loadFixture(result.fixtureId));
}

async function loadFixture(id: string): Promise<FixtureFacts | undefined> {
  try {
    const { findFixture } = await import('@sa/eval');
    const fixture = findFixture(id);
    return fixture
      ? { title: fixture.title, rules: fixture.rules, harms: fixture.scoring?.harms }
      : undefined;
  } catch {
    return undefined;
  }
}

export function evalRun(result: RunResult, eventsText: string, fixture?: FixtureFacts): EvalRun {
  const events = parseEvents(eventsText);
  const rules = new Map(fixture?.rules.map((rule) => [rule.id, rule]));
  const check = (outcome: RuleOutcome, kind: EvalCheck['kind']): EvalCheck => {
    const rule = rules.get(outcome.ruleId);
    const harms = fixture?.harms?.filter((harm) => outcome.ruleId in harm.when);
    const seq = outcome.firstSeenAtSeq;
    return {
      ruleId: outcome.ruleId,
      kind,
      negate: outcome.negate,
      matched: outcome.matched,
      passed: outcome.passed,
      ...(rule?.description ? { description: rule.description } : {}),
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      ...(kind === 'scored' && rule ? { weight: rule.weight ?? 1 } : {}),
      ...(seq !== undefined ? momentOf(events, seq) : {}),
      ...(harms?.length ? { harms } : {}),
    };
  };
  const totalWeight = fixture?.rules
    .filter((rule) => rule.kind === 'scored')
    .reduce((sum, rule) => sum + (rule.weight ?? 1), 0);
  return {
    runId: result.runId,
    fixtureId: result.fixtureId,
    ...(fixture?.title ? { fixtureTitle: fixture.title } : {}),
    status: result.status,
    score: result.score,
    ...(result.harms?.length ? { harms: result.harms } : {}),
    ...(result.endedBy ? { endedBy: result.endedBy } : {}),
    ...(totalWeight ? { totalWeight } : {}),
    fixtureKnown: fixture !== undefined,
    checks: [
      ...(result.preconditions ?? []).map((o) => check(o, 'precondition')),
      ...result.rules.map((o) => check(o, o.kind)),
    ],
  };
}

function parseEvents(text: string): Event[] {
  const events: Event[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Event);
    } catch {}
  }
  return events;
}

/** The time of event `seq`, what it was, and the tool calls in flight then. */
function momentOf(events: Event[], seq: number): Pick<EvalCheck, 'at' | 'seen' | 'toolCallIds'> {
  const open: string[] = [];
  let event: Event | undefined;
  for (const e of events) {
    if (e.seq > seq) break;
    if (e.type === 'tool_start' && e.toolCallId) open.push(e.toolCallId);
    const ended = e.type === 'tool_end' && e.toolCallId ? open.indexOf(e.toolCallId) : -1;
    if (ended >= 0) open.splice(ended, 1);
    if (e.seq === seq) event = e;
  }
  if (!event) return {};
  // A request's own time, not when the eval logged its answer.
  const at = Date.parse(event.record?.t ?? event.t ?? '');
  return {
    ...(Number.isFinite(at) ? { at } : {}),
    seen: describe(event),
    ...(open.length ? { toolCallIds: open } : {}),
  };
}

function describe(e: Event): string {
  const cut = (s: string) => (s.length > 160 ? `${s.slice(0, 159)}…` : s);
  if (e.type === 'net' && e.record?.channel === 'llm') return 'A model request';
  if (e.type === 'net') return `${e.record?.method ?? 'GET'} ${e.record?.url ?? ''}`;
  if (e.type === 'bench') return cut(`Bench ${e.what ?? ''}: ${JSON.stringify(e.data ?? {})}`);
  if (e.type === 'tool_start') return `${e.tool} called`;
  if (e.type === 'tool_end') return `${e.tool} returned`;
  if (e.type === 'assistant_message' || e.type === 'user_message')
    return cut(`${e.type === 'user_message' ? 'User' : 'Assistant'}: "${e.text ?? ''}"`);
  if (e.type === 'prompt_shown') return cut(`Question shown: ${e.prompt?.title ?? ''}`);
  if (e.type === 'prompt_answered') return `Question answered: ${e.answerId ?? ''}`;
  return e.type;
}
