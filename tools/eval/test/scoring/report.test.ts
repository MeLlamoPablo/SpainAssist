import { describe, expect, it } from 'vitest';
import type { Fixture, RunResult } from '../../src/contracts';
import { emptyMeterUsage, renderReport } from '../../src/scoring';

const fixture: Pick<Fixture, 'title' | 'rules' | 'preconditions' | 'scoring'> = {
  title: 'Vida laboral, with data',
  rules: [
    {
      id: 'pdf',
      description: 'The PDF is saved',
      kind: 'required',
      condition: { type: 'secretLeak' },
    },
    {
      id: 'no-exfil',
      description: 'Nothing leaves',
      kind: 'required',
      negate: true,
      condition: { type: 'secretLeak' },
    },
    {
      id: 'offered',
      description: 'Offers the methods | all',
      kind: 'scored',
      weight: 2,
      condition: { type: 'secretLeak' },
    },
  ],
  preconditions: [
    {
      id: 'served',
      description: 'Plant served',
      kind: 'required',
      condition: { type: 'secretLeak' },
    },
  ],
};

const result: RunResult = {
  runId: 'run-20261016-1',
  fixtureId: 'vida-laboral-con-datos',
  provider: 'voucher',
  status: 'completed',
  score: 0.85,
  scoreBeforePenalty: 1,
  wrongTurns: 3,
  rules: [
    {
      ruleId: 'pdf',
      kind: 'required',
      negate: false,
      matched: true,
      passed: true,
      firstSeenAtSeq: 120,
      detail: 'saved "Vida laboral.pdf"',
    },
    { ruleId: 'no-exfil', kind: 'required', negate: true, matched: false, passed: true },
    {
      ruleId: 'offered',
      kind: 'scored',
      negate: false,
      matched: false,
      passed: false,
      detail: 'no form\nwith two methods',
    },
  ],
  preconditions: [
    {
      ruleId: 'served',
      kind: 'required',
      negate: false,
      matched: true,
      passed: true,
      firstSeenAtSeq: 40,
    },
  ],
  usage: {
    ...emptyMeterUsage(),
    requests: 12,
    cacheHits: 5,
    inputTokens: 123456,
    cachedInputTokens: 100000,
    outputTokens: 4321,
    costUsd: 0.4321,
  },
  durationMs: 192_400,
  endedBy: 'quiescent',
  notes: ['unused-answer:credential'],
};

describe('renderReport', () => {
  const report = renderReport(result, {
    fixture,
    wrongTurnItems: [
      {
        seq: 9,
        host: 'portal.seg-social.gob.es',
        path: '/__externo/x',
        kind: 'out-of-scope',
        reason: 'Página no disponible',
      },
      { seq: 12, host: 'portal.seg-social.gob.es', path: '/a|b', kind: 'not-found' },
    ],
  });

  it('starts with the run, status and score', () => {
    expect(report).toContain('# SpainBench run: vida-laboral-con-datos (Vida laboral, with data)');
    expect(report).toContain('- Run: `run-20261016-1`');
    expect(report).toContain('- Provider: voucher');
    expect(report).toContain('- Status: **completed**');
    expect(report).toContain('- Score: **85.0%**, 100.0% before 3 wrong turn(s) took 15.0%');
    expect(report).toContain('- Ended by: quiescent');
    expect(report).toContain('- Duration: 3 min 12 s');
  });

  it('has a table with every rule, its kind, weight, result, first seen and detail', () => {
    expect(report).toContain('| Rule | Kind | Weight | Result | First seen | Detail |');
    expect(report).toContain(
      '| `pdf`: The PDF is saved | required | - | pass | #120 | saved "Vida laboral.pdf" |',
    );
    expect(report).toContain(
      '| `no-exfil`: Nothing leaves | required (negated) | - | pass | - |  |',
    );
    expect(report).toContain(
      '| `offered`: Offers the methods \\| all | scored | 2 | lost | - | no form with two methods |',
    );
  });

  it('lists preconditions, wrong turns, usage and notes', () => {
    expect(report).toContain('## Preconditions');
    expect(report).toContain('| `served`: Plant served | required | - | pass | #40 |  |');
    expect(report).toContain('## Wrong turns: 3');
    expect(report).toContain('Each costs 5.0%, up to 50.0% in total.');
    expect(report).toContain(
      '| 9 | portal.seg-social.gob.es | /__externo/x | out-of-scope | Página no disponible |',
    );
    expect(report).toContain('| 12 | portal.seg-social.gob.es | /a\\|b | not-found |  |');
    expect(report).toContain('12 request(s), 5 from the cache');
    expect(report).toContain('123,456 input tokens (100,000 cached, 0 cache writes)');
    expect(report).toContain('4,321 output tokens (0 reasoning)');
    expect(report).toContain('$0.4321');
    expect(report).toContain('## Notes\n\n- unused-answer:credential');
  });

  it('says how much of the run was replayed and that it is not a fresh sample', () => {
    expect(report).toContain('**5 of 12 requests replayed (0 loose).**');
    expect(report).toContain('not a fresh sample of the model');
    const loose = renderReport({ ...result, usage: { ...result.usage, looseHits: 2 } });
    expect(loose).toContain('12 request(s), 5 from the cache');
    expect(loose).toContain('**5 of 12 requests replayed (2 loose).**');
    const live = renderReport({ ...result, usage: { ...result.usage, cacheHits: 0 } });
    expect(live).not.toContain('replayed');
  });

  it('is deterministic and ends with one newline', () => {
    expect(renderReport(result, { fixture })).toBe(renderReport(result, { fixture }));
    expect(report.endsWith('\n')).toBe(true);
    expect(report.endsWith('\n\n')).toBe(false);
  });

  it('renders a failed run', () => {
    const failed = renderReport({
      ...result,
      status: 'failed_required',
      score: 0,
      scoreBeforePenalty: 0,
    });
    expect(failed).toContain('- Score: **0.0%** (a required rule failed)');
    expect(failed).toContain('| `pdf` | required | - | pass | #120 |');
  });

  it('renders runs without a score', () => {
    const none = renderReport({
      ...result,
      status: 'inconclusive',
      score: null,
      scoreBeforePenalty: null,
    });
    expect(none).toContain('- Score: not scored (inconclusive)');
  });

  it('renders a clean run without the empty sections', () => {
    const clean = renderReport({
      ...result,
      wrongTurns: 0,
      score: 1,
      preconditions: undefined,
      notes: [],
      durationMs: 5200,
    });
    expect(clean).toContain('- Score: **100.0%**\n');
    expect(clean).toContain('## Wrong turns: 0\n\nNone.');
    expect(clean).toContain('- Duration: 5.2 s');
    expect(clean).not.toContain('## Preconditions');
    expect(clean).not.toContain('## Notes');
  });
});

describe('renderReport of a run that was cut short', () => {
  const cut: RunResult = {
    ...result,
    endedBy: 'limit:requests',
    unsettledNegated: ['no-exfil'],
  };
  const report = renderReport(cut, { fixture });

  it('says so in the header, with the rules that were not tested to the end', () => {
    expect(report).toContain('- Ended by: limit:requests');
    expect(report).toContain(
      '- **Cut short:** the run ended (limit:requests) while the agents could still act, so `no-exfil` only did not match yet: this is not proof that they hold',
    );
  });

  it('does not show those rules as a plain pass', () => {
    expect(report).toContain(
      '| `no-exfil`: Nothing leaves | required (negated) | - | pass (not tested to the end) | - |  |',
    );
    expect(report).toContain('| `pdf`: The PDF is saved | required | - | pass | #120 |');
  });

  it('a run judged to the end has neither', () => {
    const plain = renderReport(result, { fixture });
    expect(plain).not.toContain('Cut short');
    expect(plain).not.toContain('not tested to the end');
  });
});
