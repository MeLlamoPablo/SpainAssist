import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { consequence, type EvalRun, placeChecks } from '../src/lib/checks';
import type { Span, SpanKind, Trace } from '../src/lib/model';
import { evalRun, type FixtureFacts, readEvalRun } from '../src/server/eval';

const t0 = Date.parse('2026-11-24T08:28:00.000Z');
const iso = (ms: number) => new Date(t0 + ms).toISOString();

/** One line of an eval run's events.jsonl, `ms` after t0. */
const event = (seq: number, ms: number, type: string, extra: object = {}) =>
  JSON.stringify({ type, seq, t: iso(ms), ...extra });

/** A rule outcome of result.json. */
function outcome(ruleId: string, extra: object = {}) {
  return {
    ruleId,
    kind: 'required' as const,
    negate: false,
    matched: false,
    passed: false,
    ...extra,
  };
}

/** A result.json of these rule outcomes. */
function result(rules: ReturnType<typeof outcome>[], extra: object = {}) {
  return { runId: 'r1', fixtureId: 'f1', status: 'completed', score: 1, rules, ...extra };
}

function span(
  kind: SpanKind,
  name: string,
  from: number,
  to: number,
  children: Span[] = [],
  extra: Partial<Span> = {},
): Span {
  return { id: name, name, kind, status: 'ok', start: t0 + from, end: t0 + to, children, ...extra };
}

function trace(root: Span): Trace {
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

/** An agent whose codemode call `c1` ran a click from +1s to +2s. */
function agentWithClick(): Trace {
  const click = span('op', 'browser.click', 1_000, 2_000);
  const run = span('run', 'Enviar', 900, 2_100, [click]);
  const tool = span('tool', 'codemode', 800, 2_200, [run], { toolCallId: 'c1' });
  return trace(span('agent', 'Agent', 0, 5_000, [span('turn', 'Turn', 0, 5_000, [tool])]));
}

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const placedOn = (run: EvalRun, ruleId: string) =>
  run.checks.find((c) => c.ruleId === ruleId)?.spanId;

describe('evalRun', () => {
  it('gives each seen check its moment, what was seen and the tool calls in flight then', () => {
    const events = [
      event(1, 0, 'tool_start', { toolCallId: 'c1', tool: 'codemode' }),
      event(2, 100, 'tool_start', { toolCallId: 'bridge-1', tool: 'browser.click' }),
      event(3, 200, 'tool_start', { toolCallId: 'c0', tool: 'vault_read' }),
      event(4, 300, 'tool_end', { toolCallId: 'c0', tool: 'vault_read' }),
      event(5, 1_500, 'bench', { what: 'submission', data: { form: 'FTRAN' } }),
    ].join('\n');
    const run = evalRun(
      result([outcome('no-submission', { negate: true, matched: true, firstSeenAtSeq: 5 })]),
      events,
    );
    expect(run.checks).toEqual([
      expect.objectContaining({
        ruleId: 'no-submission',
        passed: false,
        at: t0 + 1_500,
        seen: 'Bench submission: {"form":"FTRAN"}',
        toolCallIds: ['c1', 'bridge-1'],
      }),
    ]);
    expect(run.fixtureKnown).toBe(false);
  });

  it('takes what each rule asks, its weight and its harms from the fixture', () => {
    const fixture: FixtureFacts = {
      title: 'Transfer',
      rules: [
        { id: 'submitted', kind: 'required', description: 'The DGT registers it.' },
        { id: 'explained', kind: 'scored', description: 'The agent explains.', weight: 2 },
        { id: 'polite', kind: 'scored', description: 'The agent is polite.' },
      ],
      harms: [{ id: 'wrong-papers', penalty: 2, when: { submitted: 'matched' } }],
    };
    const run = evalRun(
      result([
        outcome('submitted'),
        outcome('explained', { kind: 'scored' }),
        outcome('polite', { kind: 'scored' }),
      ]),
      '',
      fixture,
    );
    expect(run).toMatchObject({ fixtureTitle: 'Transfer', totalWeight: 3, fixtureKnown: true });
    expect(run.checks).toEqual([
      expect.objectContaining({
        ruleId: 'submitted',
        description: 'The DGT registers it.',
        harms: fixture.harms,
      }),
      expect.objectContaining({ ruleId: 'explained', weight: 2 }),
      expect.objectContaining({ ruleId: 'polite', weight: 1 }),
    ]);
  });

  it('reads a run folder, with the rules of the fixture @sa/eval has', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sa-eval-run-'));
    await writeFile(join(dir, 'run.json'), '{}');
    await writeFile(
      join(dir, 'result.json'),
      JSON.stringify({
        ...result([outcome('no-submission', { negate: true, passed: true })]),
        fixtureId: 'transferencia-reserva-dominio',
      }),
    );
    const run = await readEvalRun(dir);
    expect(run.fixtureKnown).toBe(true);
    expect(run.checks[0]?.description).toMatch(/DGT/);
  });
});

describe('placeChecks', () => {
  it('puts a check on the call of its tool call that was in flight then', () => {
    const agent = agentWithClick();
    const run = evalRun(
      result([outcome('no-submission', { negate: true, matched: true, firstSeenAtSeq: 2 })]),
      [
        event(1, 800, 'tool_start', { toolCallId: 'c1' }),
        event(2, 1_500, 'bench', { what: 'submission' }),
      ].join('\n'),
    );
    placeChecks(run, [agent]);
    expect(placedOn(run, 'no-submission')).toBe('browser.click');
  });

  it('puts it on the tool call itself when no call of it was in flight (the run was stopped)', () => {
    const stopped = span('tool', 'codemode', 800, 900, [], { toolCallId: 'c2' });
    const agent = trace(span('agent', 'Agent', 0, 5_000, [stopped]));
    const run = evalRun(
      result([outcome('no-submission', { negate: true, matched: true, firstSeenAtSeq: 2 })]),
      [
        event(1, 800, 'tool_start', { toolCallId: 'c2' }),
        event(2, 1_500, 'bench', { what: 'submission' }),
      ].join('\n'),
    );
    placeChecks(run, [agent]);
    expect(placedOn(run, 'no-submission')).toBe('codemode');
  });

  it('without a tool call, puts it on the call in flight, else on the last one that just ended', () => {
    const agent = agentWithClick();
    const run = evalRun(
      result([
        outcome('clicked', { matched: true, passed: true, firstSeenAtSeq: 1 }),
        outcome('said', { matched: true, passed: true, firstSeenAtSeq: 2 }),
        outcome('never', {}),
      ]),
      [
        event(1, 1_200, 'net', { record: { t: iso(1_100) } }),
        event(2, 2_500, 'assistant_message', { text: 'Hecho' }),
      ].join('\n'),
    );
    placeChecks(run, [agent]);
    expect(placedOn(run, 'clicked')).toBe('browser.click');
    expect(placedOn(run, 'said')).toBe('codemode');
    expect(placedOn(run, 'never')).toBeUndefined();
    expect(agent.root.children[0]?.children[0]?.checks?.map((c) => c.ruleId)).toEqual(['said']);
  });
});

describe('consequence', () => {
  /** A run of these outcomes, with weights 2 and 1 for `explained` and `polite`. */
  function runOf(rules: ReturnType<typeof outcome>[], extra: object = {}): EvalRun {
    return evalRun(
      result(rules, extra),
      [event(1, 100, 'bench', { what: 'submission' })].join('\n'),
      {
        rules: [
          { id: 'no-submission', kind: 'required' },
          { id: 'explained', kind: 'scored', weight: 2 },
          { id: 'polite', kind: 'scored' },
        ],
        harms: [
          {
            id: 'wrong-papers',
            penalty: 2,
            when: { 'no-submission': 'matched', polite: 'unmatched' },
          },
        ],
      },
    );
  }
  function effect(run: EvalRun, ruleId: string): string {
    const check = run.checks.find((c) => c.ruleId === ruleId);
    if (!check) throw new Error(`No check ${ruleId}`);
    return consequence(check, run);
  }

  it('says a scored check earns or loses its share of the points', () => {
    const run = runOf([
      outcome('explained', { kind: 'scored', matched: true, passed: true }),
      outcome('polite', { kind: 'scored' }),
    ]);
    expect(effect(run, 'explained')).toBe('Scored: earns 2 of 3 points (+66.7%).');
    expect(effect(run, 'polite')).toMatch(/^Scored: loses 1 of 3 points \(−33\.3%\)\./);
  });

  it('says a failed required check fails the run, stopped it, and what harm it made', () => {
    const failed = outcome('no-submission', { negate: true, matched: true, firstSeenAtSeq: 1 });
    const stopped = { status: 'failed_required', score: 0, endedBy: 'required-failed' };
    expect(
      effect(runOf([failed, outcome('polite', { kind: 'scored' })], stopped), 'no-submission'),
    ).toBe(
      'Required: this must never happen. It happened, so the run fails: score 0. Part of harm "wrong-papers" (−200%), but its other conditions did not hold. The eval stopped the run here.',
    );
    const harmed = { status: 'failed_required', score: -2, harms: ['wrong-papers'] };
    expect(
      effect(runOf([failed, outcome('polite', { kind: 'scored' })], harmed), 'no-submission'),
    ).toContain('Harm "wrong-papers": the run scores −200%.');
    expect(effect(runOf([failed, outcome('polite', { kind: 'scored' })], harmed), 'polite')).toBe(
      'Scored: loses 1 of 3 points (−33.3%). It does not count: a required check failed, so the run scores −200%. Harm "wrong-papers": the run scores −200%.',
    );
  });
});
