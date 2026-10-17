import './helpers/no-network';
import { describe, expect, it } from 'vitest';
import {
  capAnswer,
  codexCapAnswer,
  codexCooldownAnswer,
  DEFAULT_LIMITS,
  formatUsd,
  replayMissAnswer,
  resolveLimits,
} from '../../src/llm/limits';

describe('meter limits', () => {
  it('has conservative defaults, and a lower request cap per run for Codex', () => {
    expect(resolveLimits('voucher')).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits('mock')).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits('codex').perRunRequests).toBe(120);
    expect(DEFAULT_LIMITS).toMatchObject({
      reserveUsd: 1,
      perRunUsd: 0.5,
      perRunRequests: 250,
      perAgentUsd: 0.35,
      dailyUsd: 1,
      perAgentUsdByRole: { answerer: 0.05 },
      codex: { requestsPer5h: 150, requestsPerDay: 400 },
    });
    expect(DEFAULT_LIMITS.lifetimeUsd).toBeUndefined();
  });

  it('layers overrides without touching the defaults, merging the nested ones', () => {
    const limits = resolveLimits(
      'voucher',
      { perRunUsd: 2, perAgentUsdByRole: { assistant: 0.5 }, codex: { requestsPer5h: 10 } },
      { perRunRequests: 7, perRunUsd: undefined, codex: { inputTokensPerRun: 99 } },
      undefined,
    );
    expect(limits).toMatchObject({
      perRunUsd: 2,
      perRunRequests: 7,
      perAgentUsdByRole: { answerer: 0.05, assistant: 0.5 },
      codex: { requestsPer5h: 10, requestsPerDay: 400, inputTokensPerRun: 99 },
    });
    expect(DEFAULT_LIMITS.perRunUsd).toBe(0.5);
    expect(DEFAULT_LIMITS.perAgentUsdByRole).toEqual({ answerer: 0.05 });
    expect(DEFAULT_LIMITS.codex).toEqual({ requestsPer5h: 150, requestsPerDay: 400 });
  });

  it('answers caps with a non-retryable 402 that says "out of budget"', () => {
    const answer = capAnswer('run_budget', 'this run spent $0.51 of $0.50');
    expect(answer.status).toBe(402);
    expect(answer.headers).toMatchObject({ 'x-should-retry': 'false', 'x-sa-eval': 'budget' });
    expect(JSON.parse(answer.body)).toEqual({
      error: {
        message: 'Eval budget exceeded: out of budget (this run spent $0.51 of $0.50)',
        type: 'budget_exceeded',
        param: null,
        code: 'budget_exceeded',
        eval_reason: 'run_budget',
      },
    });
    expect(capAnswer('stopped', 'x').headers['x-sa-eval']).toBe('stopped');
    expect(JSON.parse(codexCapAnswer('requests_cap', '3 of 3').body).error.message).toBe(
      'Eval cap reached: quota exceeded (out of budget): 3 of 3',
    );
  });

  it("answers a replay miss with 424 and a Codex cooldown with the backend's own 429 shape", () => {
    expect(replayMissAnswer('Replay cache miss: x')).toMatchObject({ status: 424 });
    expect(JSON.parse(replayMissAnswer('m').body).error).toMatchObject({ type: 'replay_miss' });
    const cooldown = codexCooldownAnswer({ untilMs: 1_893_456_000_500, planType: 'plus' });
    expect(cooldown.status).toBe(429);
    expect(JSON.parse(cooldown.body)).toEqual({
      error: {
        type: 'usage_limit_reached',
        message: 'The usage limit has been reached',
        plan_type: 'plus',
        resets_at: 1_893_456_001,
      },
    });
    expect(JSON.parse(codexCooldownAnswer({ untilMs: 1000 }).body).error).not.toHaveProperty(
      'plan_type',
    );
  });

  it('formats dollars', () => {
    expect(formatUsd(0.5)).toBe('$0.5000');
    expect(formatUsd(0.00123)).toBe('$0.0012');
  });
});
