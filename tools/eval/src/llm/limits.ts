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
  | 'lifetime'
  | 'daily'
  | 'key_reserve'
  | 'run_budget'
  | 'agent_budget'
  /** A Codex usage limit was observed; answered locally with the same 429 until it resets. */
  | 'codex_cooldown';

/**
 * Every cap of the meter, and what refuses a request first: a request is checked, in this order,
 * against the kill switch, the requests of the run and of the agent, its estimated input size,
 * then (voucher) the lifetime ceiling and the day, the key's balance (`reserveUsd`), the cost of
 * the run and of the agent. Codex use has no cap of its own beyond the request counts: the plan
 * has no price per call, and its own usage limit is honoured as a cooldown. The ledger's figures
 * (lifetime, day) and the key's balance count every reservation in it, those of other processes
 * and of requests in flight included.
 *
 * `reserveUsd`, `perRunUsd` and `perRunRequests` are `MeterBudget` (contracts.ts): stop real calls
 * when the key's remaining balance would drop below the reserve, and cap one run's spend and
 * request count. For Codex runs (the plan has no price per call) only the request counts apply.
 *
 * The defaults are what a voucher run enforces, with one exception: the run loop gives each run
 * the cost limit of its fixture as `perRunUsd` (`RunLimits.maxCostUsd`, `--max-cost`; $1.50 for
 * the vida laboral fixtures), which is above the day and the per-agent caps, so on a voucher those
 * bind first. The meter's own `perRunUsd` is for a run that has no fixture.
 */
export interface MeterLimits extends MeterBudget {
  perRunRequests: number;
  /** One agent of a run (`assistant`, `procedure-3`, `answerer`). */
  perAgentUsd: number;
  /** Tighter caps by agent role (`answerer` talks a little, so it gets little). */
  perAgentUsdByRole: Record<string, number>;
  perAgentRequests: number;
  /** A request estimated above this many input tokens is refused before it is sent. */
  maxInputTokensPerRequest: number;
  /** Real voucher spend since the ledger's last epoch; undefined: only the key's own balance. */
  lifetimeUsd?: number;
  /** Real voucher spend per UTC day. */
  dailyUsd: number;
}

export type MeterLimitsInput = Partial<MeterLimits>;

export const DEFAULT_LIMITS: MeterLimits = {
  // The user's rule for the voucher: no real call when the key would be left with less than $1.
  // The runner refuses to start under it too (`VOUCHER_FLOOR_USD` is this number).
  reserveUsd: 1,
  perRunUsd: 0.5,
  perRunRequests: 250,
  perAgentUsd: 0.35,
  perAgentUsdByRole: { answerer: 0.05 },
  perAgentRequests: 200,
  maxInputTokensPerRequest: 400_000,
  dailyUsd: 1,
};

export function resolveLimits(...layers: (MeterLimitsInput | undefined)[]): MeterLimits {
  const out: MeterLimits = {
    ...DEFAULT_LIMITS,
    perAgentUsdByRole: { ...DEFAULT_LIMITS.perAgentUsdByRole },
  };
  for (const layer of layers) {
    if (!layer) continue;
    const { perAgentUsdByRole, ...rest } = layer;
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
    }
    if (perAgentUsdByRole)
      out.perAgentUsdByRole = { ...out.perAgentUsdByRole, ...perAgentUsdByRole };
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
