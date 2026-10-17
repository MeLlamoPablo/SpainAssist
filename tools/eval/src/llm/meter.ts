import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { CacheMode, EvalProvider } from '../contracts';
import { alignIds } from './align';
import { agentRole, type CacheHit, keptHeaders, type MissDiagnostic, ResponseCache } from './cache';
import { type CanonicalRequest, canonicalizeRequest } from './canonical';
import { requireCodexConsent } from './codex-auth';
import { cooldownFromError, isUsageLimit, readCooldown, writeCooldown } from './codex-cooldown';
import {
  DEFAULT_PRICES,
  estimateInputTokens,
  NO_TOKENS,
  type NormalizedUsage,
  type PriceEntry,
  type PriceTable,
  parseResponseCostHeader,
  priceFor,
  reserveCost,
  resolveCost,
} from './cost';
import { homePaths } from './home';
import { Ledger, type LedgerRecord, WINDOW_5H_MS, WINDOW_DAY_MS } from './ledger';
import {
  type CapReason,
  capAnswer,
  codexCapAnswer,
  codexCooldownAnswer,
  formatUsd,
  type MeterErrorAnswer,
  type MeterLimits,
  replayMissAnswer,
  resolveLimits,
} from './limits';
import type {
  MeterEvent,
  MeterHandle,
  MeterOptions,
  MeterRequestInfo,
  MeterRunSummary,
  OpenRunOptions,
} from './meter-types';
import { SecretRegistry } from './redact';
import { RequestSecrets } from './request-secrets';
import { isSseBody, parseErrorBody, summarizeBody, type UpstreamError, type WireApi } from './sse';
import {
  basePathOf,
  type ForwardResult,
  forwardToUpstream,
  headerString,
  isLoopbackHost,
  readBody,
  send,
  sendError,
  upstreamPathFor,
} from './upstream';
import { EMPTY_USAGE, UsageTotals } from './usage';
import { decodeBody } from './wire';

export type {
  MeterEvent,
  MeterHandle,
  MeterOptions,
  MeterRun,
  MeterRunSummary,
  OpenRunOptions,
} from './meter-types';

/**
 * The loopback meter proxy: everything between the agent hosts and the model gateway.
 *
 * Hosts are configured with `http://127.0.0.1:<port>/r/<runToken>/a/<agentKey><upstream base
 * path>` as their base URL (see `MeterHandle.agentBaseUrl`). The meter strips the
 * `/r/<runToken>/a/<agentKey>` prefix, so the upstream sees exactly the path production would
 * send, and forwards request bytes untouched. Responses stream back with all their headers
 * (`x-litellm-*` included) while the meter reads the usage out of a copy. Per request it:
 *
 * 1. refuses everything when the kill-switch file exists;
 * 2. looks the canonical request hash up in the record/replay cache (modes `off|record|replay|auto`);
 * 3. reserves the worst-case cost before sending (parallel agents cannot overshoot the caps) and
 *    refuses with a non-retryable 402 "out of budget" when a cap would be crossed;
 * 4. forwards, then settles the real cost (gateway header, usage chunk, or price table), appends a
 *    line to the ledger, stores the response when recording, and emits events.
 *
 * One proxy serves many runs and agents; a run token is a capability (only registered tokens are
 * served), the proxy binds 127.0.0.1 and rejects non-loopback `Host` headers.
 */

const ROUTE = /^\/r\/([0-9a-f]{32})\/a\/([A-Za-z0-9._~-]{1,80})(\/.*)?$/;
const MODEL_PATH = /\/(?:chat\/completions|responses)$/;
/**
 * The plan's rate-limit headers, kept verbatim in the ledger. `x-codex-turn-state` is not one: it
 * is an opaque server-side blob of about 1.5 KB per response.
 */
const LIMIT_HEADER = /^(?:x-codex-(?!turn-state$)|x-ratelimit-|retry-after$)/i;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
/**
 * How long a reservation without a settle line can still be a request in flight: a reasoning model
 * may stay silent for minutes. Older ones belong to a process that died; they keep counting
 * against the day and the lifetime ceiling (their cost may be billed), but no longer against the
 * key's balance, which the key server reports with whatever they cost.
 */
const IN_FLIGHT_MS = 30 * 60_000;
/**
 * The base path the agents of a replay run get when the meter has no upstream for the provider (a
 * replay needs no gateway and no credential): the one of the real gateway, so the paths in the
 * ledger look as in a live run.
 */
const REPLAY_BASE_PATH: Record<EvalProvider, string> = {
  voucher: '/v1',
  mock: '/v1',
  codex: '/backend-api',
};

interface Agent {
  totals: UsageTotals;
  inflightCount: number;
  inflightUsd: number;
}

interface Occurrence {
  served: number;
  inflight: number;
}

interface Run {
  readonly options: OpenRunOptions;
  readonly token: string;
  readonly provider: EvalProvider;
  readonly cache: CacheMode;
  readonly limits: MeterLimits;
  readonly basePath: string;
  /** Undefined for a replay run of a provider the meter has no upstream for: nothing is forwarded. */
  readonly upstream: URL | undefined;
  readonly totals: UsageTotals;
  readonly agents: Map<string, Agent>;
  readonly occurrences: Map<string, Occurrence>;
  readonly listeners: Set<(event: MeterEvent) => void>;
  /** The run's own secrets, looked for in every model request body. */
  readonly requestSecrets: RequestSecrets;
  inflightCount: number;
  inflightUsd: number;
}

interface Refusal {
  reason: CapReason;
  answer: MeterErrorAnswer;
  message: string;
}

export async function createMeter(options: MeterOptions): Promise<MeterHandle> {
  const paths = homePaths(options.home);
  const clock = options.now ?? (() => new Date());
  const ledger = new Ledger(paths.ledgerDir, clock);
  const cache = new ResponseCache(options.cacheDir ?? paths.cacheDir);
  const prices: PriceTable = { ...DEFAULT_PRICES, ...options.prices };
  const secrets = new SecretRegistry();
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024 * 1024;
  const runs = new Map<string, Run>();
  const activeUpstream = new Set<http.ClientRequest>();
  const agents = {
    http: new http.Agent({ keepAlive: true }),
    https: new https.Agent({
      keepAlive: true,
      ...(options.upstreamCa ? { ca: options.upstreamCa } : {}),
    }),
  };

  // The meter's own view of the key balance: a snapshot minus what the meter spent since.
  let ownSpentUsd = 0;
  let keySnapshot: { remainingUsd: number; ownSpentAtSnapshot: number } | undefined =
    options.keyRemainingUsd !== undefined
      ? { remainingUsd: options.keyRemainingUsd, ownSpentAtSnapshot: 0 }
      : undefined;
  const keyRemaining = (): number | undefined =>
    keySnapshot
      ? keySnapshot.remainingUsd - (ownSpentUsd - keySnapshot.ownSpentAtSnapshot)
      : undefined;
  /** Headers are one call behind: only ever lower the estimate. */
  const learnKeyBalance = (spendUsd: number, maxBudgetUsd: number): void => {
    const candidate = { remainingUsd: maxBudgetUsd - spendUsd, ownSpentAtSnapshot: ownSpentUsd };
    const current = keyRemaining();
    if (current === undefined || candidate.remainingUsd < current) keySnapshot = candidate;
  };

  // -------------------------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------------------------

  const agentOf = (run: Run, key: string): Agent => {
    let agent = run.agents.get(key);
    if (!agent) {
      agent = { totals: new UsageTotals(), inflightCount: 0, inflightUsd: 0 };
      run.agents.set(key, agent);
    }
    return agent;
  };

  const emit = (run: Run, event: MeterEvent): void => {
    for (const listener of [...run.listeners]) {
      try {
        listener(event);
      } catch {
        // A faulty subscriber must not break request handling.
      }
    }
  };

  const summaryOf = (run: Run): MeterRunSummary => ({
    runId: run.options.runId,
    provider: run.provider,
    cache: run.cache,
    usage: run.totals.snapshot(),
    replayedCostUsd: run.totals.replayedCostUsd,
    apiEquivalentUsd: run.totals.apiEquivalentUsd,
    rejects: { ...run.totals.rejects },
    agents: Object.fromEntries(
      [...run.agents].map(([key, agent]) => [
        key,
        { usage: agent.totals.snapshot(), rejects: { ...agent.totals.rejects } },
      ]),
    ),
    inflight: run.inflightCount,
  });

  let server: http.Server;
  let serverUrl = '';

  const agentUrl = (run: Run, agentKey: string): string => {
    if (!/^[A-Za-z0-9._~-]{1,80}$/.test(agentKey)) {
      throw new Error(`Invalid agent key "${agentKey}": use letters, digits and . _ ~ - only`);
    }
    return `${serverUrl}/r/${run.token}/a/${agentKey}${run.basePath}`;
  };

  const handle: MeterHandle = {
    get url() {
      return serverUrl;
    },
    home: paths.home,
    ledger,
    openRun(runOptions) {
      const provider = runOptions.provider;
      const upstreamUrl = options.upstreams[provider];
      const cacheMode = runOptions.cache ?? 'off';
      if (!upstreamUrl && cacheMode !== 'replay') {
        throw new Error(`The meter has no upstream for the ${provider} provider`);
      }
      if (provider === 'codex' && cacheMode !== 'replay') {
        requireCodexConsent({
          ...(options.codexConsent !== undefined ? { consent: options.codexConsent } : {}),
          ...(options.env ? { env: options.env } : {}),
        });
      }
      const run: Run = {
        options: runOptions,
        token: randomBytes(16).toString('hex'),
        provider,
        cache: cacheMode,
        limits: resolveLimits(provider, options.limits, runOptions.limits),
        basePath: upstreamUrl ? basePathOf(upstreamUrl) : REPLAY_BASE_PATH[provider],
        upstream: upstreamUrl ? new URL(upstreamUrl) : undefined,
        totals: new UsageTotals(runOptions.baseline),
        agents: new Map(),
        occurrences: new Map(),
        listeners: new Set(),
        requestSecrets: new RequestSecrets(),
        inflightCount: 0,
        inflightUsd: 0,
      };
      runs.set(run.token, run);
      return {
        runId: runOptions.runId,
        token: run.token,
        provider,
        cache: cacheMode,
        agentBaseUrl: (agentKey) => agentUrl(run, agentKey),
        usage: () => run.totals.snapshot(),
        agentUsage: (agentKey) => run.agents.get(agentKey)?.totals.snapshot() ?? { ...EMPTY_USAGE },
        agentKeys: () => [...run.agents.keys()],
        addSecret: (value) => run.requestSecrets.add(value),
        summary: () => summaryOf(run),
        on(listener) {
          run.listeners.add(listener);
          return () => run.listeners.delete(listener);
        },
        close() {
          runs.delete(run.token);
          return summaryOf(run);
        },
      };
    },
    agentBaseUrl(runToken, agentKey) {
      const run = runs.get(runToken);
      if (!run) throw new Error('Unknown run token');
      return agentUrl(run, agentKey);
    },
    keyRemainingUsd: keyRemaining,
    async close() {
      runs.clear();
      for (const request of activeUpstream) request.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      agents.http.destroy();
      agents.https.destroy();
    },
  };

  // -------------------------------------------------------------------------------------------
  // Refusals
  // -------------------------------------------------------------------------------------------

  const sendRefusal = (
    res: ServerResponse,
    run: Run,
    agent: string,
    path: string,
    model: string | undefined,
    refusal: Refusal,
    extra: Partial<LedgerRecord> = {},
  ): void => {
    run.totals.reject(refusal.reason);
    agentOf(run, agent).totals.reject(refusal.reason);
    ledger.append({
      runId: run.options.runId,
      agent,
      provider: run.provider,
      ...(model ? { model } : {}),
      kind: 'reject',
      reason: refusal.reason,
      path,
      status: refusal.answer.status,
      error: secrets.redact(refusal.message),
      ...extra,
    });
    send(res, refusal.answer);
    emit(run, {
      type: 'cap',
      runId: run.options.runId,
      agent,
      reason: refusal.reason,
      message: secrets.redact(refusal.message),
    });
  };

  /** 403 for a path that is not a model call: ledger line and count, no event (it is not a cap). */
  const refusePath = (
    res: ServerResponse,
    run: Run,
    agent: string,
    method: string,
    path: string,
  ): void => {
    const message = `Only POST .../chat/completions and .../responses go through the eval meter, not ${method} ${path}`;
    run.totals.reject('path_not_allowed');
    agentOf(run, agent).totals.reject('path_not_allowed');
    ledger.append({
      runId: run.options.runId,
      agent,
      provider: run.provider,
      kind: 'reject',
      reason: 'path_not_allowed',
      path,
      status: 403,
      error: secrets.redact(message),
    });
    sendError(res, 403, 'path_not_allowed', message);
  };

  const stopRefusal = (): Refusal => {
    const message = `kill switch: ${paths.stopFile} exists, remove it to continue`;
    return { reason: 'stopped', answer: capAnswer('stopped', message), message };
  };

  /**
   * Caps checked before a request goes upstream; undefined = admitted. What the ledger says about
   * other requests includes every reservation in it, those of other processes and of this one.
   * `reserved` is the second look, once this request's own reservation has been written: the
   * ledger's figures then include it, so it is taken out before the comparison. A request is only
   * admitted if both looks agree, so two processes that race for the last headroom cannot both
   * get it (they may both be refused: a refusal is safe, a double spend is not).
   */
  const checkCaps = (
    run: Run,
    agentKey: string,
    estimatedInputTokens: number,
    reserveUsd: number,
    reserved = false,
  ): Refusal | undefined => {
    const limits = run.limits;
    const agent = agentOf(run, agentKey);
    const refuse = (reason: CapReason, detail: string, codex = false): Refusal => ({
      reason,
      message: detail,
      answer: codex ? codexCapAnswer(reason, detail) : capAnswer(reason, detail),
    });
    ledger.refresh();
    const nowMs = clock().getTime();
    const codex = run.provider === 'codex';
    // The ledger counts the voucher's dollars and Codex's requests only.
    const ownUsd = reserved && run.provider === 'voucher' ? reserveUsd : 0;
    const ownRequests = reserved ? 1 : 0;

    if (codex) {
      const cooldown = readCooldown(paths.codexCooldown, nowMs);
      if (cooldown) {
        return {
          reason: 'codex_cooldown',
          message: `Codex usage limit active until ${new Date(cooldown.untilMs).toISOString()}`,
          answer: codexCooldownAnswer(cooldown),
        };
      }
    }
    if (run.totals.forwarded + run.inflightCount >= limits.perRunRequests) {
      return refuse(
        'requests_cap',
        `this run used ${run.totals.forwarded} of ${limits.perRunRequests} allowed ${codex ? 'Codex ' : ''}requests`,
        codex,
      );
    }
    if (agent.totals.forwarded + agent.inflightCount >= limits.perAgentRequests) {
      return refuse(
        'agent_requests_cap',
        `agent ${agentKey} used ${agent.totals.forwarded} of ${limits.perAgentRequests} allowed requests`,
        codex,
      );
    }
    if (estimatedInputTokens > limits.maxInputTokensPerRequest) {
      return refuse(
        'input_too_large',
        `request of about ${estimatedInputTokens} input tokens is above the ${limits.maxInputTokensPerRequest} limit`,
        codex,
      );
    }
    if (codex) {
      const used5h = ledger.codexRequestsWithin(WINDOW_5H_MS) - ownRequests;
      if (used5h >= limits.codex.requestsPer5h) {
        return refuse(
          'codex_window',
          `${used5h} of ${limits.codex.requestsPer5h} Codex requests used in the last 5 hours`,
          true,
        );
      }
      const usedDay = ledger.codexRequestsWithin(WINDOW_DAY_MS) - ownRequests;
      if (usedDay >= limits.codex.requestsPerDay) {
        return refuse(
          'codex_window',
          `${usedDay} of ${limits.codex.requestsPerDay} Codex requests used in the last 24 hours`,
          true,
        );
      }
      const tokenCap = limits.codex.inputTokensPerRun;
      if (tokenCap !== undefined && run.totals.promptTokens() >= tokenCap) {
        return refuse(
          'codex_tokens',
          `this run sent ${run.totals.promptTokens()} of ${tokenCap} allowed input tokens`,
          true,
        );
      }
      return undefined;
    }

    if (run.provider === 'voucher') {
      if (limits.lifetimeUsd !== undefined) {
        const spent = ledger.spentSinceEpochUsd() + ledger.pendingSinceEpochUsd() - ownUsd;
        if (spent + reserveUsd > limits.lifetimeUsd) {
          return refuse(
            'lifetime',
            `spent ${formatUsd(spent)} of the ${formatUsd(limits.lifetimeUsd)} lifetime ceiling`,
          );
        }
      }
      const day = clock().toISOString().slice(0, 10);
      const today = ledger.spentTodayUsd() + ledger.pendingUsd({ day }) - ownUsd;
      if (today + reserveUsd > limits.dailyUsd) {
        return refuse('daily', `spent ${formatUsd(today)} of ${formatUsd(limits.dailyUsd)} today`);
      }
    }
    const remaining = keyRemaining();
    if (remaining !== undefined) {
      const inFlight = ledger.pendingUsd({ sinceMs: nowMs - IN_FLIGHT_MS }) - ownUsd;
      if (remaining - inFlight - reserveUsd < limits.reserveUsd) {
        return refuse(
          'key_reserve',
          `the key has about ${formatUsd(Math.max(0, remaining - inFlight))} left and ${formatUsd(limits.reserveUsd)} is kept in reserve`,
        );
      }
    }
    const runSpent = run.totals.costUsd() + run.inflightUsd;
    if (runSpent + reserveUsd > limits.perRunUsd) {
      return refuse(
        'run_budget',
        `this run spent ${formatUsd(runSpent)} of ${formatUsd(limits.perRunUsd)}`,
      );
    }
    const agentCap = limits.perAgentUsdByRole[agentRole(agentKey)] ?? limits.perAgentUsd;
    const agentSpent = agent.totals.costUsd() + agent.inflightUsd;
    if (agentSpent + reserveUsd > agentCap) {
      return refuse(
        'agent_budget',
        `agent ${agentKey} spent ${formatUsd(agentSpent)} of ${formatUsd(agentCap)}`,
      );
    }
    return undefined;
  };

  // -------------------------------------------------------------------------------------------
  // Serving
  // -------------------------------------------------------------------------------------------

  const recordServed = (
    run: Run,
    agentKey: string,
    outcome: Parameters<UsageTotals['add']>[0],
    info: Omit<MeterRequestInfo, 'agent' | 'kind' | 'usage' | 'costUsd'>,
  ): void => {
    const agent = agentOf(run, agentKey);
    run.totals.add(outcome, run.provider);
    agent.totals.add(outcome, run.provider);
    emit(run, {
      type: 'usage',
      runId: run.options.runId,
      agent: agentKey,
      request: {
        agent: agentKey,
        kind: outcome.kind,
        usage: outcome.counts,
        costUsd: outcome.costUsd,
        ...info,
      },
      agentUsage: agent.totals.snapshot(),
      runUsage: run.totals.snapshot(),
    });
  };

  const serveTake = (
    res: ServerResponse,
    run: Run,
    agentKey: string,
    path: string,
    model: string | undefined,
    canon: CanonicalRequest,
    occurrence: number,
    hit: CacheHit,
    startedAt: number,
  ): void => {
    const { take } = hit;
    // The recording names the ids of its own run: this run's take their place. An exact hit has
    // the same ids in the same places; a looser one pairs them by what surrounds them.
    const body = hit.ids
      ? alignIds(take.body, hit.ids.recorded, hit.ids.live)
      : alignIds(take.body, take.ids ?? [], canon.ids);
    res.writeHead(take.status, {
      ...keptHeaders(take.headers),
      'content-length': String(Buffer.byteLength(body)),
      'x-sa-eval-cache': 'hit',
    });
    res.end(body);
    const counts = take.usage ?? NO_TOKENS;
    const ms = Date.now() - startedAt;
    const loose = hit.loose.length > 0;
    ledger.append({
      runId: run.options.runId,
      agent: agentKey,
      provider: run.provider,
      ...(model ? { model } : {}),
      kind: 'replay',
      path,
      status: take.status,
      ms,
      reqHash: canon.key.slice(0, 16),
      occurrence,
      cache: 'hit',
      ...(loose ? { loose: true, looseWhy: hit.loose } : {}),
      ...(canon.variant ? { variant: canon.variant } : {}),
      usage: counts,
      cost: { usd: take.costUsd, source: take.costSource, virtual: true },
    });
    recordServed(
      run,
      agentKey,
      { kind: 'replay', counts, costUsd: 0, virtualCostUsd: take.costUsd, loose },
      {
        ...(model ? { model } : {}),
        status: take.status,
        aborted: false,
        ms,
        ...(loose ? { loose: true } : {}),
      },
    );
  };

  /** Sends the request upstream (same path and query, body untouched) and streams the answer back. */
  const forward = (
    req: IncomingMessage,
    res: ServerResponse,
    run: Run,
    path: string,
    search: string,
    raw: Buffer,
  ): Promise<ForwardResult> => {
    const { upstream } = run;
    // Replay answers from the cache or with a miss before it gets here.
    if (!upstream) throw new Error('A replay run has no upstream: nothing is forwarded');
    return forwardToUpstream({
      req,
      res,
      target: new URL(`${path}${search}`, upstream.origin),
      raw,
      agent: upstream.protocol === 'https:' ? agents.https : agents.http,
      active: activeUpstream,
    });
  };

  interface ModelCall {
    run: Run;
    agent: string;
    path: string;
    search: string;
    raw: Buffer;
    decodedText: string;
    json: Record<string, unknown> | undefined;
    api: WireApi;
    model: string | undefined;
    canon: CanonicalRequest | undefined;
  }

  /** Settles a forwarded model request: cost, ledger, cache, totals, events. */
  const settleForward = (
    call: ModelCall,
    result: ForwardResult,
    occurrence: number,
    startedAt: number,
    release: (settledInLedger: boolean) => void,
    rid: string,
    price: PriceEntry,
    estimatedInputTokens: number,
  ): { served: boolean } => {
    const { run, agent: agentKey, canon } = call;
    const codex = run.provider === 'codex';
    const ms = Date.now() - startedAt;
    let text = '';
    try {
      text = decodeBody(result.body, headerString(result.headers, 'content-encoding')).toString(
        'utf8',
      );
    } catch {
      text = result.body.toString('utf8');
    }
    const contentType = headerString(result.headers, 'content-type');
    const ok = result.status >= 200 && result.status < 300;
    const summary = ok ? summarizeBody(call.api, text, contentType) : undefined;
    const usage: NormalizedUsage | undefined = summary?.usage;
    const errorBody: UpstreamError | undefined = ok ? summary?.error : parseErrorBody(text);
    // pi stops reading at `response.completed` and cancels the body, often before the upstream's
    // last chunk arrives (the ChatGPT backend does exactly that): a response that finished whose
    // client then left is complete, not aborted.
    const aborted =
      result.aborted && !(ok && summary?.complete === true && summary.error === undefined);

    // Cost.
    const headerCost = codex
      ? undefined
      : parseResponseCostHeader(headerString(result.headers, 'x-litellm-response-cost'));
    const unfinished = ok && (aborted || !summary?.complete || summary.error !== undefined);
    // The client hung up before the upstream answered: the upstream may still have billed the
    // input, so charge the estimate rather than nothing.
    const hungUpEarly = result.aborted && result.status === 0;
    const billable = ok || hungUpEarly;
    const resolved = billable
      ? resolveCost({
          headerCostUsd: headerCost,
          usage,
          price,
          ...(!usage || aborted
            ? { partial: { estimatedInputTokens, outputChars: summary?.outputText.length ?? 0 } }
            : {}),
        })
      : { usd: 0, source: 'none' as const };
    const chargedUsd = codex ? 0 : resolved.usd;
    const apiEquivalentUsd = codex ? resolved.usd : undefined;
    const counts = usage?.counts ?? NO_TOKENS;

    // The key's own spend headers (one call behind).
    const keySpend = parseResponseCostHeader(headerString(result.headers, 'x-litellm-key-spend'));
    const keyMax = parseResponseCostHeader(
      headerString(result.headers, 'x-litellm-key-max-budget'),
    );
    if (keySpend !== undefined && keyMax !== undefined) learnKeyBalance(keySpend, keyMax);
    ownSpentUsd += chargedUsd;

    // Limit signals from the gateway or the plan.
    let gatewayLimit:
      | { kind: 'budget' | 'usage_limit'; message: string; resetsAt?: string }
      | undefined;
    if (codex && isUsageLimit(errorBody)) {
      const cooldown = cooldownFromError(errorBody!, clock().getTime());
      writeCooldown(paths.codexCooldown, cooldown);
      gatewayLimit = {
        kind: 'usage_limit',
        message: errorBody?.message ?? 'usage limit reached',
        resetsAt: new Date(cooldown.untilMs).toISOString(),
      };
    } else if (
      !ok &&
      (/budget_exceeded|exceeded_budget/i.test(
        `${errorBody?.type ?? ''} ${errorBody?.code ?? ''}`,
      ) ||
        /budget has been exceeded|exceeded.*budget/i.test(errorBody?.message ?? ''))
    ) {
      gatewayLimit = { kind: 'budget', message: errorBody?.message ?? 'gateway budget exceeded' };
    }

    const limitHeaders: Record<string, string> = {};
    if (codex) {
      for (const [name, value] of Object.entries(result.headers)) {
        if (LIMIT_HEADER.test(name) && value !== undefined) {
          limitHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
        }
      }
    }
    const errorText =
      result.transportError ??
      (errorBody
        ? [errorBody.type, errorBody.code, errorBody.message].filter(Boolean).join(': ')
        : undefined) ??
      (ok ? undefined : text.slice(0, 200));

    ledger.append({
      runId: run.options.runId,
      agent: agentKey,
      provider: run.provider,
      ...(call.model ? { model: call.model } : {}),
      kind: 'forward',
      rid,
      path: call.path,
      status: result.status,
      ms,
      ...(result.ttfbMs !== undefined ? { ttfbMs: result.ttfbMs } : {}),
      stream: isSseBody(text, contentType),
      ...(aborted ? { aborted: true } : {}),
      ...(canon ? { reqHash: canon.key.slice(0, 16), occurrence } : {}),
      cache: run.cache === 'off' ? 'off' : 'miss',
      ...(canon?.variant ? { variant: canon.variant } : {}),
      ...(usage ? { usage: counts } : {}),
      ...(billable
        ? {
            cost: {
              usd: chargedUsd,
              // A plan has no price per call: the table figure is `apiEquivalentUsd`, not a cost.
              source: codex ? ('none' as const) : resolved.source,
              ...(!codex && resolved.estimateUsd !== undefined
                ? { estimateUsd: resolved.estimateUsd }
                : {}),
            },
          }
        : {}),
      ...(apiEquivalentUsd !== undefined ? { apiEquivalentUsd } : {}),
      ...(keySpend !== undefined || keyMax !== undefined || headerCost !== undefined
        ? {
            litellm: {
              ...(keySpend !== undefined ? { keySpendUsd: keySpend } : {}),
              ...(keyMax !== undefined ? { keyMaxBudgetUsd: keyMax } : {}),
              ...(headerCost !== undefined ? { responseCostUsd: headerCost } : {}),
            },
          }
        : {}),
      ...(Object.keys(limitHeaders).length > 0 ? { limitHeaders } : {}),
      ...(summary?.finishReason ? { finish: summary.finishReason } : {}),
      ...(errorText ? { error: secrets.redact(errorText) } : {}),
      ...(gatewayLimit ? { gatewayLimit: true } : {}),
    });

    // The line settled the reservation in the ledger; release the counters of this process in the
    // same tick.
    release(true);

    recordServed(
      run,
      agentKey,
      {
        kind: 'forward',
        counts,
        costUsd: chargedUsd,
        virtualCostUsd: apiEquivalentUsd ?? 0,
      },
      {
        ...(call.model ? { model: call.model } : {}),
        status: result.status,
        aborted,
        ms,
      },
    );
    if (gatewayLimit) {
      emit(run, {
        type: 'gateway_limit',
        runId: run.options.runId,
        agent: agentKey,
        kind: gatewayLimit.kind,
        status: result.status,
        message: secrets.redact(gatewayLimit.message),
        ...(gatewayLimit.resetsAt ? { resetsAt: gatewayLimit.resetsAt } : {}),
      });
    }
    // Record mode stores complete, successful responses only.
    let stored = false;
    if (
      canon &&
      (run.cache === 'record' || run.cache === 'auto') &&
      ok &&
      !unfinished &&
      !result.truncated &&
      summary?.complete &&
      !secrets.has(text) &&
      !secrets.has(summary.outputText)
    ) {
      cache.record(
        { upstream: run.provider, model: call.model ?? 'unknown' },
        canon,
        occurrence,
        {
          status: result.status,
          // What a recording may keep (and a developer may commit): no account identifiers.
          headers: secrets.scrubRecordedHeaders(keptHeaders(result.headers)),
          body: secrets.scrubRecordedBody(text),
          ...(usage ? { usage: counts } : {}),
          costUsd: codex ? (apiEquivalentUsd ?? 0) : chargedUsd,
          costSource: codex ? 'none' : resolved.source,
          recordedAt: clock().toISOString(),
          runId: run.options.runId,
          agent: agentKey,
          ids: canon.ids,
        },
        clock(),
      );
      stored = true;
    }
    return { served: stored || (ok && !unfinished) };
  };

  const handleModelCall = async (
    req: IncomingMessage,
    res: ServerResponse,
    call: ModelCall,
  ): Promise<void> => {
    const { run, agent: agentKey, canon, path, model } = call;
    const startedAt = Date.now();
    const scope = { upstream: run.provider, model: model ?? 'unknown' };

    // Occurrence: how many complete responses of this hash this run already got (and has in flight).
    let slot: Occurrence | undefined;
    let occurrence = 0;
    if (canon) {
      slot = run.occurrences.get(canon.key) ?? { served: 0, inflight: 0 };
      run.occurrences.set(canon.key, slot);
      occurrence = slot.served + slot.inflight;
      slot.inflight++;
    }
    const settleOccurrence = (served: boolean): void => {
      if (!slot) return;
      slot.inflight--;
      if (served) slot.served++;
    };

    try {
      if (run.cache === 'replay' || run.cache === 'auto') {
        const exact = canon ? cache.take(scope, canon, occurrence) : undefined;
        // A replay never goes upstream: an answer recorded for the same conversation but another
        // look of the pages (a redirect caught at another hop) is better than a miss, and says so.
        const similar =
          !exact && canon && run.cache === 'replay'
            ? cache.takeLoose(scope, canon, occurrence)
            : undefined;
        const hit = exact ?? similar?.hit;
        if (hit && canon) {
          serveTake(res, run, agentKey, path, model, canon, occurrence, hit, startedAt);
          settleOccurrence(true);
          return;
        }
        if (run.cache === 'replay') {
          const diagnostic: MissDiagnostic = canon
            ? cache.explainMiss(scope, canon, occurrence, agentKey, similar?.rejected)
            : {
                key: 'unhashed',
                occurrence,
                reason: 'no-recordings',
                description: `Replay cache miss: the request to ${path} is not JSON, so it cannot be replayed (agent ${agentKey}).`,
              };
          const description = secrets.redact(diagnostic.description);
          run.totals.reject('replay_miss');
          agentOf(run, agentKey).totals.reject('replay_miss');
          ledger.append({
            runId: run.options.runId,
            agent: agentKey,
            provider: run.provider,
            ...(model ? { model } : {}),
            kind: 'reject',
            reason: 'replay_miss',
            path,
            status: 424,
            ...(canon ? { reqHash: canon.key.slice(0, 16), occurrence } : {}),
            cache: 'miss',
            error: description,
          });
          send(res, replayMissAnswer(description));
          emit(run, {
            type: 'replay_miss',
            runId: run.options.runId,
            agent: agentKey,
            diagnostic: { ...diagnostic, description },
          });
          settleOccurrence(false);
          return;
        }
      }

      // Going upstream: reserve the worst case first.
      const { price } = priceFor(prices, model);
      const estimatedInputTokens = estimateInputTokens(call.decodedText);
      const maxOutput = Math.max(
        1,
        Number(
          call.json?.max_tokens ??
            call.json?.max_completion_tokens ??
            call.json?.max_output_tokens ??
            DEFAULT_MAX_OUTPUT_TOKENS,
        ) || DEFAULT_MAX_OUTPUT_TOKENS,
      );
      const reserveUsd =
        run.provider === 'codex' ? 0 : reserveCost(price, estimatedInputTokens, maxOutput);
      const refusal = checkCaps(run, agentKey, estimatedInputTokens, reserveUsd);
      if (refusal) {
        sendRefusal(res, run, agentKey, path, model, refusal, {
          ...(canon ? { reqHash: canon.key.slice(0, 16), occurrence } : {}),
        });
        settleOccurrence(false);
        return;
      }
      // On the books before it is sent: other processes (and a crash) see it from here on.
      const rid = randomBytes(8).toString('hex');
      ledger.reserve({
        rid,
        run: run.options.runId,
        agent: agentKey,
        provider: run.provider,
        ...(model ? { model } : {}),
        path,
        usd: run.provider === 'voucher' ? reserveUsd : 0,
      });
      const raced = checkCaps(run, agentKey, estimatedInputTokens, reserveUsd, true);
      if (raced) {
        ledger.release(rid);
        sendRefusal(res, run, agentKey, path, model, raced, {
          ...(canon ? { reqHash: canon.key.slice(0, 16), occurrence } : {}),
        });
        settleOccurrence(false);
        return;
      }
      const agent = agentOf(run, agentKey);
      run.inflightCount++;
      run.inflightUsd += reserveUsd;
      agent.inflightCount++;
      agent.inflightUsd += reserveUsd;
      let released = false;
      const release = (settledInLedger: boolean): void => {
        if (released) return;
        released = true;
        run.inflightCount--;
        run.inflightUsd -= reserveUsd;
        agent.inflightCount--;
        agent.inflightUsd -= reserveUsd;
        // A request that ended with no line of its own (the settling failed) is taken off the books.
        if (!settledInLedger) ledger.release(rid);
      };

      try {
        const result = await forward(req, res, run, path, call.search, call.raw);
        const settled = settleForward(
          call,
          result,
          occurrence,
          startedAt,
          release,
          rid,
          price,
          estimatedInputTokens,
        );
        settleOccurrence(settled.served);
      } finally {
        release(false);
      }
    } catch (error) {
      settleOccurrence(false);
      throw error;
    }
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://meter.invalid');
    if (!isLoopbackHost(req.headers.host)) {
      return sendError(res, 403, 'forbidden_host', 'This proxy only serves loopback requests');
    }
    const route = ROUTE.exec(url.pathname);
    const run = route ? runs.get(route[1]!) : undefined;
    if (!route || !run) return sendError(res, 404, 'unknown_run', 'Unknown run or agent route');
    const agentKey = route[2]!;
    const path = upstreamPathFor(run.basePath, route[3] ?? '/');
    secrets.addAuthorization(headerString(req.headers, 'authorization'));
    secrets.add(headerString(req.headers, 'chatgpt-account-id'));
    secrets.add(headerString(req.headers, 'x-api-key'));

    const raw = await readBody(req, maxBodyBytes);
    if (raw === 'too_large') {
      return sendError(res, 413, 'request_too_large', 'Request body is too large for the meter');
    }
    const isModelCall = req.method === 'POST' && MODEL_PATH.test(path);

    if (existsSync(paths.stopFile)) {
      sendRefusal(res, run, agentKey, path, undefined, stopRefusal());
      return;
    }

    if (!isModelCall) {
      // The meter forwards model calls only: its budgets cover nothing else (embeddings, another
      // wire API, image or audio endpoints would spend with no cap). pi calls no other path for
      // these providers: every ledger of the real runs holds only chat completions.
      refusePath(res, run, agentKey, req.method ?? 'GET', path);
      return;
    }

    let decoded: Buffer;
    try {
      decoded = decodeBody(raw, headerString(req.headers, 'content-encoding'));
    } catch {
      return sendError(res, 400, 'bad_encoding', 'The request body could not be decoded');
    }
    const decodedText = decoded.toString('utf8');
    const forms = run.requestSecrets.scan(decodedText);
    let json: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(decodedText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      json = undefined;
    }
    const api: WireApi = path.endsWith('/responses') ? 'responses' : 'chat-completions';
    const model = typeof json?.model === 'string' ? json.model : undefined;
    if (forms.length > 0) {
      emit(run, {
        type: 'secret_in_request',
        runId: run.options.runId,
        agent: agentKey,
        path,
        ...(model ? { model } : {}),
        forms,
      });
    }
    const canon = json
      ? canonicalizeRequest(
          json,
          {
            api,
            ...(run.options.variant ? { variant: run.options.variant } : {}),
            ...(run.options.strictImages ? { strictImages: true } : {}),
            ...(run.options.volatile ? { volatile: run.options.volatile } : {}),
          },
          decoded.length,
        )
      : undefined;
    await handleModelCall(req, res, {
      run,
      agent: agentKey,
      path,
      search: url.search,
      raw,
      decodedText,
      json,
      api,
      model,
      canon,
    });
  };

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      const message = secrets.redact(error instanceof Error ? error.message : String(error));
      options.onError?.(new Error(message));
      if (!res.headersSent) sendError(res, 502, 'meter_error', `Meter error: ${message}`);
      else res.destroy();
    });
  });
  // Reasoning models can stay silent for minutes: no idle timeouts.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 65_000;
  server.on('upgrade', (_req, socket) => {
    // Codex tries a WebSocket first; refusing makes pi fall back to SSE (hashable, meterable).
    socket.on('error', () => {});
    socket.end(
      'HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-length: 0\r\nx-sa-eval: websocket-refused\r\n\r\n',
    );
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return handle;
}
