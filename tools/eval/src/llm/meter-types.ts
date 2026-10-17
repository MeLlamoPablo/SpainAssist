import type { CacheMode, EvalProvider, MeterUsage } from '../contracts';
import type { MissDiagnostic } from './cache';
import type { VolatilePattern } from './canonical';
import type { PriceTable, TokenCounts } from './cost';
import type { Ledger } from './ledger';
import type { CapReason, MeterLimitsInput } from './limits';
import type { SecretForm } from './request-secrets';

/** The public types of the meter proxy (see meter.ts). */

export interface MeterOptions {
  /** Credentials home: ledger, record/replay cache, kill switch, Codex cooldown (default `evalHome()`). */
  home?: string;
  /**
   * The real base URL hosts would use in production, by provider: `voucher` = the gateway of
   * `litellm.json` (ends in `/v1`), `codex` = `https://chatgpt.com/backend-api`, `mock` = a
   * tools/mock-llm `baseUrl`. Tests point them at local fakes.
   */
  upstreams: Partial<Record<EvalProvider, string>>;
  limits?: MeterLimitsInput;
  /** Prices to add to or override `DEFAULT_PRICES`. */
  prices?: PriceTable;
  /** The key's remaining USD when the meter starts (from `budgetStatus`); headers refine it. */
  keyRemainingUsd?: number;
  /** Where the record/replay cache lives (default `<home>/llm-cache`). */
  cacheDir?: string;
  /** Default 0: any free port. */
  port?: number;
  /** Codex consent (the flag); `SA_EVAL_CODEX_CONSENT=1` does the same. */
  codexConsent?: boolean;
  env?: Record<string, string | undefined>;
  /** Tests: the clock. */
  now?: () => Date;
  /** Largest request body accepted (default 64 MB; screenshots make bodies large). */
  maxBodyBytes?: number;
  /** Extra CA certificate(s) to trust for an HTTPS upstream (a private gateway, a test server). */
  upstreamCa?: string | Buffer;
  /** Called with a failure inside the proxy itself (a full disk, a bug); the request gets a 502. */
  onError?: (error: Error) => void;
}

export interface OpenRunOptions {
  /** The run id written in the ledger. */
  runId: string;
  provider: EvalProvider;
  /** Default `off`. */
  cache?: CacheMode;
  /** Independent samples of the same conversation (the cache key includes it). */
  variant?: string;
  /**
   * Put the hash of each screenshot into the cache key. Without it a request with another
   * screenshot has the same key, and a hit that answers another picture counts as a loose hit.
   */
  strictImages?: boolean;
  /** Run-specific volatile text (the run directory, ids, ports) to normalise out of cache keys. */
  volatile?: readonly VolatilePattern[];
  /** Caps for this run over the meter's. */
  limits?: MeterLimitsInput;
  /** Usage already spent before a resume: counts toward this run's totals and caps. */
  baseline?: MeterUsage;
}

export interface MeterRequestInfo {
  agent: string;
  model?: string;
  kind: 'forward' | 'replay';
  status: number;
  usage: TokenCounts;
  /** Real (mock: simulated) USD charged by this request. */
  costUsd: number;
  aborted: boolean;
  ms: number;
  /** A replay that was not an exact replay of its recording (see `MeterUsage.looseHits`). */
  loose?: boolean;
}

export type MeterEvent =
  /** A request finished (served or replayed); totals include it. */
  | {
      type: 'usage';
      runId: string;
      agent: string;
      request: MeterRequestInfo;
      agentUsage: MeterUsage;
      runUsage: MeterUsage;
    }
  /** A cap or the kill switch refused a request: the run should end as a budget stop. */
  | { type: 'cap'; runId: string; agent: string; reason: CapReason; message: string }
  /** Replay mode had no recording for a request: the run cannot continue. */
  | { type: 'replay_miss'; runId: string; agent: string; diagnostic: MissDiagnostic }
  /**
   * A registered secret (`MeterRun.addSecret`) is in a request body, whatever the text it is in:
   * the system prompt, a message, a tool result, a compaction summary. The request is still
   * served; the event says where (`agent`, `path`) and in which spellings, never the secret.
   */
  | {
      type: 'secret_in_request';
      runId: string;
      agent: string;
      path: string;
      model?: string;
      forms: SecretForm[];
    }
  /** The gateway or the plan itself said no (LiteLLM budget, Codex usage limit). */
  | {
      type: 'gateway_limit';
      runId: string;
      agent: string;
      kind: 'budget' | 'usage_limit';
      status: number;
      message: string;
      /** ISO time the Codex usage limit resets. */
      resetsAt?: string;
    };

export interface MeterRunSummary {
  runId: string;
  provider: EvalProvider;
  cache: CacheMode;
  usage: MeterUsage;
  /** What the cache hits would have cost live. */
  replayedCostUsd: number;
  /** Codex: the tokens priced as API usage (informational; the plan is metered by requests). */
  apiEquivalentUsd: number;
  /** Refusals by reason (`run_budget`, `replay_miss`, ...). */
  rejects: Record<string, number>;
  agents: Record<string, { usage: MeterUsage; rejects: Record<string, number> }>;
  /** Requests being served right now. */
  inflight: number;
}

export interface MeterRun {
  readonly runId: string;
  /** The capability token in the URLs of this run. */
  readonly token: string;
  readonly provider: EvalProvider;
  readonly cache: CacheMode;
  /** The base URL to put in an agent's model config: `.../r/<token>/a/<agentKey><base path>`. */
  agentBaseUrl(agentKey: string): string;
  /** The whole run's usage, live. */
  usage(): MeterUsage;
  agentUsage(agentKey: string): MeterUsage;
  agentKeys(): string[];
  /**
   * Registers a secret of the run (a password): every model request body of this run is searched
   * for it from now on, in the spellings a body can hold it in (`request-secrets.ts`), and a hit
   * is a `secret_in_request` event.
   */
  addSecret(value: string): void;
  summary(): MeterRunSummary;
  on(listener: (event: MeterEvent) => void): () => void;
  /** Stops serving this token (requests in flight finish) and returns the final summary. */
  close(): MeterRunSummary;
}

export interface MeterHandle {
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  readonly home: string;
  readonly ledger: Ledger;
  openRun(options: OpenRunOptions): MeterRun;
  /** The URL of an agent of an open run (same as `MeterRun.agentBaseUrl`). */
  agentBaseUrl(runToken: string, agentKey: string): string;
  /** What the meter believes the key has left (USD); undefined until it knows. */
  keyRemainingUsd(): number | undefined;
  close(): Promise<void>;
}
