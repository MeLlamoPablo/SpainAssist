import type { Rule, RuleOutcome, RunResult, ScoringConfig } from '../contracts';

/** The defaults of docs/EVAL.md: 5 points per wrong turn, at most 50 points in total. */
export const DEFAULT_SCORING: ScoringConfig = { wrongTurnPenalty: 0.05, wrongTurnPenaltyCap: 0.5 };

function assertFraction(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`scoring.${name} must be a number from 0 to 1, got ${value}`);
  }
}

/** The fixture's scoring config over the defaults, validated. */
export function resolveScoring(overrides: Partial<ScoringConfig> = {}): ScoringConfig {
  const config = { ...DEFAULT_SCORING };
  if (overrides.wrongTurnPenalty !== undefined)
    config.wrongTurnPenalty = overrides.wrongTurnPenalty;
  if (overrides.wrongTurnPenaltyCap !== undefined) {
    config.wrongTurnPenaltyCap = overrides.wrongTurnPenaltyCap;
  }
  assertFraction('wrongTurnPenalty', config.wrongTurnPenalty);
  assertFraction('wrongTurnPenaltyCap', config.wrongTurnPenaltyCap);
  return config;
}

/** Weight of a scored rule (default 1). */
export function ruleWeight(rule: Pick<Rule, 'weight'>): number {
  return rule.weight ?? 1;
}

/** Scores are kept to six decimals so sums such as 0.1 + 0.2 do not leak float noise. */
export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export interface ScoreBreakdown {
  /** Ids of the required rules that failed. Any of them makes the score 0. */
  failedRequired: string[];
  earnedWeight: number;
  totalWeight: number;
  /** 0..1: the share of scored weight earned; 0 when a required rule failed. */
  scoreBeforePenalty: number;
  /** Points (0..cap) taken off for wrong turns. 0 when a required rule failed. */
  penalty: number;
  /** 0..1. */
  score: number;
}

/**
 * The score of a finished run (docs/EVAL.md): any failed required rule gives 0; otherwise the
 * earned share of the scored rules' weight, minus `wrongTurnPenalty` per wrong turn up to
 * `wrongTurnPenaltyCap`, never below 0. A fixture without scored rules scores 1 before the penalty.
 */
export function computeScore(input: {
  rules: readonly Rule[];
  outcomes: readonly RuleOutcome[];
  wrongTurns: number;
  scoring?: Partial<ScoringConfig>;
}): ScoreBreakdown {
  const config = resolveScoring(input.scoring);
  const outcomes = new Map(input.outcomes.map((outcome) => [outcome.ruleId, outcome]));
  const failedRequired: string[] = [];
  let earnedWeight = 0;
  let totalWeight = 0;
  for (const rule of input.rules) {
    const outcome = outcomes.get(rule.id);
    if (!outcome) throw new Error(`No outcome for rule "${rule.id}"`);
    if (rule.kind === 'required') {
      if (!outcome.passed) failedRequired.push(rule.id);
    } else {
      const weight = ruleWeight(rule);
      totalWeight += weight;
      if (outcome.passed) earnedWeight += weight;
    }
  }
  if (failedRequired.length > 0) {
    return {
      failedRequired,
      earnedWeight,
      totalWeight,
      scoreBeforePenalty: 0,
      penalty: 0,
      score: 0,
    };
  }
  const scoreBeforePenalty = totalWeight === 0 ? 1 : earnedWeight / totalWeight;
  const wrongTurns = Math.max(0, Math.floor(input.wrongTurns));
  const penalty = Math.min(config.wrongTurnPenaltyCap, config.wrongTurnPenalty * wrongTurns);
  return {
    failedRequired,
    earnedWeight,
    totalWeight,
    scoreBeforePenalty: round6(scoreBeforePenalty),
    penalty: round6(penalty),
    score: round6(Math.max(0, scoreBeforePenalty - penalty)),
  };
}

/** The mean score of the runs that have one (an error, an abort or an inconclusive run has none). */
export function meanScore(results: readonly Pick<RunResult, 'score'>[]): number | undefined {
  const scores = results.flatMap((result) => (result.score === null ? [] : [result.score]));
  if (scores.length === 0) return undefined;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}
