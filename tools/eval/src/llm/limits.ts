import type { MeterBudget } from '../contracts';

/**
 * The meter's caps and the answers it gives when one is hit. Budget and cap refusals are HTTP 402
 * whose text says "out of budget" / "quota exceeded": pi treats that as non-retryable (it retries
 * 429, 5xx and "timeout"/"network" wording three times) and the app classifies it as `quota`, so
 * the agent stops at once instead of burning retries. Replay misses are 424.
 */

export type CapReason =
  /** The kill-switch file exists. */
  | 'stopped'
  | 'requests_cap'
  | 'agent_requests_cap'
  | 'input_too_large'
  | 'key_balance'
  | 'run_budget'
  /** A Codex usage limit was observed; answered locally with the same 429 until it resets. */
  | 'codex_cooldown';

/**
 * Every cap of the meter, and what refuses a request first: a request is checked, in this order,
 * against the kill switch, the requests of the run and of the agent, its estimated input size,
 * then (voucher) the key's balance and the cost of the run. A voucher is the evals' own money, so
 * nothing holds part of it back: runs may spend all of it, and the balance check only keeps
 * parallel requests from overshooting it (it counts every reservation in the ledger, those of
 * other processes and of requests in flight included). Codex use has no cap of its own beyond the
 * request counts: the plan has no price per call, and its own usage limit is honoured as a
 * cooldown.
 *
 * `perRunUsd` and `perRunRequests` are `MeterBudget` (contracts.ts): they cap one run's spend and
 * request count. The run loop gives each run the cost limit of its fixture as `perRunUsd`
 * (`RunLimits.maxCostUsd`, `--max-cost`); the default is for a run that has no fixture.
 */
export interface MeterLimits extends MeterBudget {
  perRunRequests: number;
  /** One agent of a run (`assistant`, `procedure-3`, `answerer`). */
  perAgentRequests: number;
  /** A request estimated above this many input tokens is refused before it is sent. */
  maxInputTokensPerRequest: number;
}

export type MeterLimitsInput = Partial<MeterLimits>;

export const DEFAULT_LIMITS: MeterLimits = {
  perRunUsd: 0.5,
  perRunRequests: 250,
  perAgentRequests: 200,
  maxInputTokensPerRequest: 400_000,
};

export function resolveLimits(...layers: (MeterLimitsInput | undefined)[]): MeterLimits {
  const out: MeterLimits = { ...DEFAULT_LIMITS };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

export interface MeterErrorAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function jsonAnswer(status: number, tag: string, error: Record<string, unknown>): MeterErrorAnswer {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-should-retry': 'false',
      'x-sa-eval': tag,
    },
    body: JSON.stringify({ error }),
  };
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** The 402 for a cap or the kill switch. `detail` says which and by how much. */
export function capAnswer(reason: CapReason, detail: string): MeterErrorAnswer {
  return jsonAnswer(402, reason === 'stopped' ? 'stopped' : 'budget', {
    message: `Eval budget exceeded: out of budget (${detail})`,
    type: 'budget_exceeded',
    param: null,
    code: 'budget_exceeded',
    eval_reason: reason,
  });
}

/** The 402 for a Codex request-count cap. */
export function codexCapAnswer(reason: CapReason, detail: string): MeterErrorAnswer {
  return jsonAnswer(402, 'budget', {
    message: `Eval cap reached: quota exceeded (out of budget): ${detail}`,
    type: 'budget_exceeded',
    param: null,
    code: 'budget_exceeded',
    eval_reason: reason,
  });
}

/** 424: nothing recorded for this request (replay mode). */
export function replayMissAnswer(description: string): MeterErrorAnswer {
  return jsonAnswer(424, 'replay-miss', {
    message: description,
    type: 'replay_miss',
    param: null,
    code: 'replay_miss',
  });
}

/**
 * The answer a Codex usage limit gets while the cooldown lasts: the same 429 the backend sent, so
 * pi shows "You have hit your ChatGPT usage limit" and does not retry.
 */
export function codexCooldownAnswer(cooldown: {
  untilMs: number;
  planType?: string;
}): MeterErrorAnswer {
  return jsonAnswer(429, 'codex-cooldown', {
    type: 'usage_limit_reached',
    message: 'The usage limit has been reached',
    ...(cooldown.planType ? { plan_type: cooldown.planType } : {}),
    resets_at: Math.ceil(cooldown.untilMs / 1000),
  });
}
