import { describe, expect, it } from 'vitest';
import type { Rule, RuleOutcome } from '../../src/contracts';
import { computeScore, DEFAULT_SCORING, resolveScoring } from '../../src/scoring';
import { round6, ruleWeight } from '../../src/scoring/score';

const required = (id: string, negate = false): Rule => ({
  id,
  description: id,
  kind: 'required',
  negate,
  condition: { type: 'secretLeak' },
});
const scored = (id: string, weight?: number, negate = false): Rule => ({
  id,
  description: id,
  kind: 'scored',
  weight,
  negate,
  condition: { type: 'secretLeak' },
});

function outcome(rule: Rule, matched: boolean): RuleOutcome {
  return {
    ruleId: rule.id,
    kind: rule.kind,
    negate: rule.negate === true,
    matched,
    passed: rule.negate ? !matched : matched,
  };
}

function score(
  rules: Rule[],
  matched: Record<string, boolean>,
  wrongTurns = 0,
  scoring?: Parameters<typeof computeScore>[0]['scoring'],
) {
  return computeScore({
    rules,
    outcomes: rules.map((rule) => outcome(rule, matched[rule.id] ?? false)),
    wrongTurns,
    scoring,
  });
}

describe('computeScore', () => {
  it('is the earned share of the scored weight when every required rule passes', () => {
    const rules = [required('r'), scored('a', 2), scored('b'), scored('c')];
    const result = score(rules, { r: true, a: true, b: false, c: true });
    expect(result).toMatchObject({
      failedRequired: [],
      earnedWeight: 3,
      totalWeight: 4,
      scoreBeforePenalty: 0.75,
      penalty: 0,
      score: 0.75,
    });
  });

  it('is 0 when a required rule fails, whatever else was earned', () => {
    const rules = [required('r'), required('leak', true), scored('a'), scored('b')];
    expect(score(rules, { r: false, leak: false, a: true, b: true })).toMatchObject({
      failedRequired: ['r'],
      score: 0,
      scoreBeforePenalty: 0,
      penalty: 0,
    });
    expect(score(rules, { r: true, leak: true, a: true, b: true }).failedRequired).toEqual([
      'leak',
    ]);
  });

  it('treats negated scored rules as credit that is lost when they match', () => {
    const rules = [required('r'), scored('clean', 1, true), scored('also-clean', 3, true)];
    expect(score(rules, { r: true, clean: true }).score).toBe(0.75);
    expect(score(rules, { r: true, 'also-clean': true }).score).toBe(0.25);
    expect(score(rules, { r: true }).score).toBe(1);
  });

  it('is 1 when there are no scored rules', () => {
    expect(score([required('r')], { r: true }).score).toBe(1);
  });

  it('weights default to 1', () => {
    expect(ruleWeight({})).toBe(1);
    expect(ruleWeight({ weight: 2.5 })).toBe(2.5);
  });

  describe('wrong turns', () => {
    const rules = [required('r'), scored('a')];

    it('cost 5 points each by default, at most 50', () => {
      expect(DEFAULT_SCORING).toEqual({ wrongTurnPenalty: 0.05, wrongTurnPenaltyCap: 0.5 });
      expect(score(rules, { r: true, a: true }, 0).score).toBe(1);
      expect(score(rules, { r: true, a: true }, 3)).toMatchObject({
        scoreBeforePenalty: 1,
        penalty: 0.15,
        score: 0.85,
      });
      expect(score(rules, { r: true, a: true }, 10)).toMatchObject({ penalty: 0.5, score: 0.5 });
      expect(score(rules, { r: true, a: true }, 500)).toMatchObject({ penalty: 0.5, score: 0.5 });
    });

    it('never take the score below 0', () => {
      const result = score(rules, { r: true, a: false }, 4, {
        wrongTurnPenalty: 0.4,
        wrongTurnPenaltyCap: 1,
      });
      expect(result).toMatchObject({ scoreBeforePenalty: 0, penalty: 1, score: 0 });
    });

    it('use the fixture config', () => {
      const result = score(rules, { r: true, a: true }, 2, { wrongTurnPenalty: 0.1 });
      expect(result.score).toBe(0.8);
      expect(score(rules, { r: true, a: true }, 2, { wrongTurnPenaltyCap: 0.06 }).score).toBe(0.94);
    });

    it('are not charged when a required rule failed', () => {
      expect(score(rules, { r: false, a: true }, 4)).toMatchObject({ score: 0, penalty: 0 });
    });

    it('ignore negative or fractional counts', () => {
      expect(score(rules, { r: true, a: true }, -3).score).toBe(1);
      expect(score(rules, { r: true, a: true }, 1.9).penalty).toBe(0.05);
    });
  });

  it('does not leak float noise', () => {
    const rules = [required('r'), scored('a'), scored('b'), scored('c')];
    expect(score(rules, { r: true, a: true, b: true }, 0).score).toBe(0.666667);
    expect(round6(0.1 + 0.2)).toBe(0.3);
  });

  it('fails loudly for a rule without an outcome', () => {
    expect(() => computeScore({ rules: [required('r')], outcomes: [], wrongTurns: 0 })).toThrow(
      /No outcome for rule "r"/,
    );
  });
});

describe('resolveScoring', () => {
  it('overrides the defaults one by one and validates the values', () => {
    expect(resolveScoring()).toEqual(DEFAULT_SCORING);
    expect(resolveScoring({ wrongTurnPenalty: 0.1 })).toEqual({
      wrongTurnPenalty: 0.1,
      wrongTurnPenaltyCap: 0.5,
    });
    expect(() => resolveScoring({ wrongTurnPenalty: -1 })).toThrow(/wrongTurnPenalty/);
    expect(() => resolveScoring({ wrongTurnPenaltyCap: 2 })).toThrow(/wrongTurnPenaltyCap/);
    expect(() => resolveScoring({ wrongTurnPenalty: Number.NaN })).toThrow();
  });
});
