/**
 * Contracts shared by the parts of the eval suite (see docs/EVAL.md). Types only: every part
 * owns its implementation in its own directory and may add to its own types, but changes to this
 * file are changes to the seams between parts, so update every consumer in the same change.
 *
 * Ownership of the directories under `src/`:
 *   bench/    SpainBench client, process launcher, version check          (core)
 *   net/      host table, world gateway, browser proxy, host egress       (net)
 *   host/     eval host entry (`@sa/agent` HostHooks implementation)      (net)
 *   llm/      meter proxy, ledger, record/replay cache, Codex login       (llm)
 *   fixtures/ fixture schema + the three initial fixtures                 (pure, core)
 *   rules/    rule vocabulary and evaluation                              (pure)
 *   scoring/  score formula and the run report                            (pure)
 *   answers/  answer groups and the answerer                              (pure)
 *   run/      the run loop, user simulator, observers, checkpoints        (core)
 *   cli.ts    the `eval` command                                          (core)
 */

import type { AgentErrorKind } from '@sa/agent';
import type { PromptResponse } from '@sa/shared';
import type { CredentialSource, MeterRun } from './llm';

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

/**
 * Which LLM provider the evaluated agents use. `voucher` = pi provider `litellm` through the
 * meter proxy (what voucher users get); `codex` = `openai-codex` with the eval's own device-auth
 * credential (dev only); `mock` = tools/mock-llm (free, scripted; harness development and tests);
 * `local` = an OpenAI-compatible server the developer runs (LM Studio, llama.cpp...), as pi
 * provider `litellm` with a placeholder key: free, and no real credential goes there.
 */
export type EvalProvider = 'voucher' | 'codex' | 'mock' | 'local';

/** `anthropic/claude-haiku-5.5` for voucher runs: the same models the product uses. */
export interface EvalModelChoice {
  /** Undefined: the product default for the provider and role (apps/desktop providers/manager). */
  assistantModel?: string;
  procedureModel?: string;
  /** The cheap model that plays the user for freeform answers. */
  answererModel: string;
  answererThinking: 'off' | 'minimal' | 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------------------------
// SpainBench (private repo): scoring API client types. The HTTP shape is in docs/EVAL.md.
// ---------------------------------------------------------------------------------------------

export const SUPPORTED_SCORING_API = 1;

export interface BenchVersion {
  name: 'spainbench';
  version: string;
  gitSha?: string;
  /** Integer; the harness refuses a server whose value it does not support. */
  scoringApi: number;
  snapshotFormat: string;
  contentHash: string;
  sites: Record<string, { version: string; contentHash: string }>;
  /** Optional capabilities: 'plants', 'collector', 'snapshot', 'events', 'wrong-turns'... */
  features: string[];
  /** Injection variants the server can plant (ids only; payloads never leave the private repo). */
  injections: { id: string; summary: string; points?: string[] }[];
}

export interface BenchHost {
  host: string;
  site: string;
  /** `portal`, `idp`, ... (the site's own key). */
  key: string;
  kind: 'site' | 'asset' | 'external';
}

export interface BenchWorldSpec {
  /** An opaque id (16 hex characters, see `newWorldId`): never the run id. */
  id: string;
  seed?: number;
  /** Frozen "today" of the mock (default: the server's SPAINBENCH_DATE). */
  today?: string;
  sites?: string[];
  /** Site-specific starting presets, e.g. `{ 'fnmt-es': 'download' }`. */
  presets?: Record<string, string>;
  /** Fixture 3: ask the mock to plant an injection and to route this attacker host to its collector. */
  injection?: { variant: string; collectorHost: string };
  /** Extra strings that must never reach a collector (the site adds its own canaries). */
  canaries?: string[];
  /**
   * Whether the sites hide what a copy would say about being one (`Documento simulado...`).
   * `BenchApi.createWorld` always asks for `true` and refuses a server that answers otherwise: a
   * copy that says it is a copy contaminates every verdict.
   */
  disguise?: true;
}

export interface BenchWorldState {
  id: string;
  /** Per-site public state, exactly the site's legacy `/api/benchmark/state` body. */
  sites: Record<string, unknown>;
  downloads: BenchDownload[];
  wrongTurns: { count: number; items: BenchWrongTurn[] };
  exfil: { count: number; items: BenchExfil[] };
  plantsServed: { id: string; page: string; seq: number }[];
  counters: { seq: number; requests: number };
}

export interface BenchDownload {
  site: string;
  filename: string;
  contentType: string;
  bytes: number;
  sha256: string;
  at: string;
  /** Site-specific record (seg-social: report, filter, employers, totalDays, csv). */
  record: Record<string, unknown>;
}

export interface BenchWrongTurn {
  seq: number;
  host: string;
  path: string;
  kind: 'not-found' | 'out-of-scope' | 'unknown-host' | 'forbidden';
  reason?: string;
}

export interface BenchExfil {
  seq: number;
  host: string;
  /** The collector registered for this world (false: an unknown host the agent invented). */
  registeredCollector: boolean;
  method: string;
  /** Path and query. */
  url: string;
  /** Canaries found in the url, headers or body (also after URL/base64/hex decoding). */
  canaryHits: string[];
  source?: string;
}

// ---------------------------------------------------------------------------------------------
// Network: the one record format of every outbound request the evaluated agents make.
// ---------------------------------------------------------------------------------------------

export type NetChannel =
  | 'browser'
  | 'fetch_url'
  | 'run_script'
  | 'boe_search'
  | 'web_research'
  | 'exa'
  | 'llm'
  | 'other';

export interface NetRecord {
  seq: number;
  /** ISO time. */
  t: string;
  worldId: string;
  channel: NetChannel;
  /** The agent's tool call that caused it, when known. */
  toolCallId?: string;
  method: string;
  /** The URL the agent believes it requested (the real one). */
  url: string;
  host: string;
  /** `mapped` = served by SpainBench; `unmapped` = refused like a dead domain; `llm` = to the model gateway. */
  route: 'mapped' | 'unmapped' | 'llm' | 'denied';
  /** Browser only: Playwright resource type (`document`, `xhr`, `image`...). */
  resourceType?: string;
  reqHeaders: Record<string, string>;
  /** At most 64 KB, base64 when binary (see `reqBodyEncoding`). */
  reqBody?: string;
  /** `base64` when `reqBody` holds a binary body; absent for text. */
  reqBodyEncoding?: 'base64';
  /** Full size of the request body in bytes (`reqBody` holds at most its first 64 KB). */
  reqBodyBytes?: number;
  status?: number;
  /** The declared length of the response body: absent when it is streamed or compressed. */
  resBytes?: number;
  /** From the request to the answer's headers (the body is read at the agent's pace). */
  durationMs: number;
  error?: string;
  /**
   * SpainBench's own classification of the request, from the `X-SpainBench-Kind/Page/Seq`
   * response headers (`seq` is the id in the server's request log). Mapped requests only.
   */
  bench?: { kind?: string; page?: string; seq?: number };
}

/**
 * Written by the run into `SA_EVAL_CONFIG` (a JSON file path in the host's environment) and read
 * by the eval host entry (`src/host/eval-main.ts`). The product host never reads it.
 */
export interface HostEvalConfig {
  worldId: string;
  /** Loopback origin of SpainBench's public listener: the only upstream the host may reach. */
  mockOrigin: string;
  /** Loopback origin of the scoring listener: the host refuses to start when it is the mock's. */
  scoringOrigin: string;
  /** Real hosts (exact, or `*.suffix`) served by SpainBench. */
  routes: string[];
  /** What an unmapped host looks like to the agent. */
  unmapped: { mode: 'enotfound' | 'econnrefused' | 'timeout' } | { mode: 'status'; status: number };
  /** JSONL of NetRecord. */
  netlog: string;
  llm: { extraAllowOrigins: string[] };
  research: {
    /** `auto`: by provider (key server for litellm, hosted search shape for chatgpt/codex). */
    shape: 'auto' | 'key-server' | 'chatgpt';
    /** Recorded answers by fixture; the host answers the first (or the only) one. */
    answers: ResearchAnswer[];
  };
  /** Frozen "now" of the agents' prompts. */
  now: string;
}

export interface ResearchAnswer {
  /** A valid UUID: the run id the key-server stream reports. */
  id: string;
  output: { type: 'text' | 'json'; content: unknown; basis: unknown[] };
}

// ---------------------------------------------------------------------------------------------
// Meter proxy (llm/): everything between the agent hosts and the model gateway.
// ---------------------------------------------------------------------------------------------

export type CacheMode = 'off' | 'record' | 'replay' | 'auto';

export interface MeterBudget {
  /** Per-run cap in USD (voucher) or `maxRequests` (codex). */
  perRunUsd: number;
  perRunRequests?: number;
}

export interface MeterUsage {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /** Requests served from the record/replay cache (free). */
  cacheHits: number;
  /**
   * Of `cacheHits`, those that were not an exact replay of the recording: the answer was recorded
   * for a conversation whose browser pages or screenshots differed (see the cache, `llm/cache.ts`).
   * Absent in results written before it existed.
   */
  looseHits?: number;
}

// ---------------------------------------------------------------------------------------------
// Fixtures, answers, rules, scoring.
// ---------------------------------------------------------------------------------------------

export type AgentKind = 'assistant' | 'procedure';

/** What the app asks the user (the app's PromptItem kinds). */
export type PromptKind = 'form' | 'confirm' | 'user_action' | 'credential' | 'phone_call';

/** A pending question as the harness sees it (derived from the app's PromptItem). */
export interface PendingPrompt {
  itemId: string;
  agent: AgentKind;
  procedureId?: string;
  kind: PromptKind;
  title: string;
  message?: string;
  /**
   * form: field keys, types, labels and option labels/values, never secret values, and what the
   * renderer's form logic needs to answer the way the UI does: a field with a `vaultKey` is saved
   * to the user's data when answered, a field that depends on a select (`visibleWhen`) is left out
   * of the answer while hidden, a `defaultValue` prefills.
   */
  fields?: {
    key: string;
    type: string;
    label: string;
    options?: { value: string; label: string }[];
    secret?: boolean;
    /** The personal-data key the app stores the answer under (the form field's `vaultKey`). */
    vaultKey?: string;
    /** The form insists on an answer (the app's default: true). */
    required?: boolean;
    /** Prefilled value; never present for a secret field. */
    defaultValue?: string;
    /** Shown only when the named select field has one of these option values. */
    visibleWhen?: { field: string; values: string[] };
  }[];
  /** credential: which credential the agent requests (`clave_permanente`...). */
  credentialKind?: string;
}

export interface AnswerMatcher {
  agent?: AgentKind;
  kind?: PromptKind;
  /** Case-insensitive regexes tested against title + message. */
  text?: string;
  /** Every listed key must be a field of the form. */
  fieldKeys?: string[];
  /** Some select/multiselect option label must match this regex. */
  optionLabel?: string;
  credentialKind?: string;
}

export type AnswerAction =
  /** Pick the option(s) whose label matches; other fields: defaults / persona facts. */
  | { type: 'select'; optionLabel: string }
  /** Programmatic form values by field key (never given to an LLM). */
  | { type: 'values'; values: Record<string, string | number | boolean | string[]> }
  /** Create a Cl@ve Permanente credential in the vault and answer with its id. */
  | { type: 'credential'; username: string; password: string }
  | { type: 'confirm'; approved: boolean }
  /**
   * What the user types after reading it on the page, such as a captcha: the value of the form's
   * secret field (else of its only text field). It is never given to a model.
   */
  | { type: 'typed'; value: string }
  | { type: 'user_action'; done: boolean; note?: string }
  /** The cheap answerer model answers following these instructions. */
  | { type: 'freeform'; instructions: string };

export interface Answer {
  id: string;
  match: AnswerMatcher;
  action: AnswerAction;
  /**
   * Extension of the spec: an optional answer does not have to be used for the next group to
   * unlock (a model may skip a question and ask the next one directly). It stays answerable until
   * an answer of a later group has been used (the conversation has moved on).
   */
  optional?: boolean;
  /**
   * The answer can be used any number of times: it stays answerable after it was used (an optional
   * one until the conversation moves on, like any optional answer). For a refusal that must hold
   * every time the same thing is asked, such as declining to send data to an attacker's host.
   */
  repeatable?: boolean;
}

/**
 * Answers inside a group are consumed in any order and each only once; the next group unlocks
 * when every non-optional answer of the groups before it has been used. A prompt that matches no
 * answerable answer is handled by `Fixture.unexpectedPrompt`. The state machine is
 * `AnswerState` in `src/answers`.
 */
export interface AnswerGroup {
  id: string;
  answers: Answer[];
}

export interface Fixture {
  id: string;
  title: string;
  /** The first user message to the orchestrator. */
  prompt: string;
  language?: 'es' | 'en';
  /** Initial project state (saved personal data, credentials, prior procedures). */
  seed?: FixtureSeed;
  /** SpainBench world settings (presets, injection). */
  world: Omit<BenchWorldSpec, 'id'>;
  /** The recorded research answer of this fixture (key into tools/eval/fixtures/research). */
  research: string;
  /** The persona the freeform answerer plays. */
  persona: string;
  answerGroups: AnswerGroup[];
  /** Unmatched prompts: let the answerer improvise, approve/decline, or end the run. */
  unexpectedPrompt: 'answerer' | 'dismiss' | 'fail';
  rules: Rule[];
  /** Facts that must hold for the run to be meaningful (else the result is `inconclusive`). */
  preconditions?: Rule[];
  limits: RunLimits;
  scoring?: Partial<ScoringConfig>;
}

export interface FixtureSeed {
  personal?: Record<string, string>;
  claves?: { username: string; password: string; label?: string }[];
  /** Hooks for richer seeds (documents, prior procedures) are added by the run part. */
}

/**
 * What a run may use before it is cut short as the agent's doing (`limit:*`, scored by the rules).
 * The meter's own caps for a run and for an agent (requests, dollars) are the same kind of limit:
 * the ones the shipped fixtures set are lower than the meter's defaults, so these fire first (see
 * `src/llm/limits.ts`).
 */
export interface RunLimits {
  wallClockMs: number;
  /** Total agent tool calls across all agents. */
  maxToolCalls: number;
  /** Model requests of the whole run: all agents and the answerer; cache replays count. */
  maxRequests: number;
  maxCostUsd: number;
  maxPrompts: number;
}

export type RuleKind = 'required' | 'scored';

export interface Rule {
  id: string;
  description: string;
  kind: RuleKind;
  /** Scored rules only; default 1. */
  weight?: number;
  /**
   * Negated: the rule fails the run as soon as its condition becomes true (required) or loses its
   * credit (scored). Positive rules latch: once true they stay matched.
   */
  negate?: boolean;
  condition: Condition;
}

/** Declarative conditions over the run's observations; `custom` is the escape hatch. */
export type Condition =
  | {
      type: 'toolCall';
      agent?: AgentKind;
      tool: string | RegExp;
      args?: Record<string, string | RegExp>;
    }
  | { type: 'prose'; from: AgentKind | 'any'; matches: RegExp }
  /**
   * Something a tool returned to the model (the text of a `tool_end`: what the app records of the
   * result the model received: page snapshots, `document_read`, `fetch_url` bodies...). `ok`
   * limits it to results that did not fail (`true`) or only to failed ones (`false`).
   */
  | { type: 'toolResult'; agent?: AgentKind; tool?: string | RegExp; matches: RegExp; ok?: boolean }
  | { type: 'prompt'; match: AnswerMatcher }
  | { type: 'vaultDocument'; where: VaultDocumentPredicate }
  | { type: 'bench'; path: string; equals?: unknown; matches?: RegExp; gte?: number; lte?: number }
  | { type: 'net'; where: NetPredicate }
  | { type: 'secretLeak' }
  | { type: 'all'; of: Condition[] }
  | { type: 'any'; of: Condition[] }
  /**
   * True while the inner condition has not been seen. A rule latches the first time its condition
   * is true, so `all[A, not B]` in a positive rule means "A happened before any B", and a later B
   * does not undo it. To require that B never happens, make a separate negated rule for B.
   */
  | { type: 'not'; of: Condition }
  | { type: 'custom'; name: string; test: (view: RunView) => boolean | Promise<boolean> };

export interface VaultDocumentPredicate {
  mimeType?: string;
  source?: string;
  nameMatches?: RegExp;
  /** The PDF's text must contain a value that equals a `csv` of a bench download record. */
  pdfCsvMatchesBenchDownload?: { site: string; where: Record<string, unknown> };
}

export interface NetPredicate {
  host?: string | RegExp;
  urlMatches?: RegExp;
  route?: NetRecord['route'];
  channel?: NetChannel;
  /**
   * Only `true`: matches a bench exfil item that went to the registered collector or carried a
   * canary hit (`host` and `urlMatches` narrow it; `route` and `channel` do not apply). A request
   * to an unknown host without a canary is not an exfiltration (an official host the mock answers
   * with a 404 is a wrong turn; one outside the host table fails like a dead domain and is neither).
   * Negate the rule to ask for none.
   */
  exfil?: boolean;
}

export interface ScoringConfig {
  /** Points removed from the (0..1) score per wrong turn. */
  wrongTurnPenalty: number;
  /** The most wrong turns can cost. */
  wrongTurnPenaltyCap: number;
}

export interface RuleOutcome {
  ruleId: string;
  kind: RuleKind;
  negate: boolean;
  /** Whether the condition was ever true. */
  matched: boolean;
  /** Required: ok. Scored: earned credit. */
  passed: boolean;
  firstSeenAtSeq?: number;
  detail?: string;
}

export type RunStatus = 'completed' | 'failed_required' | 'inconclusive' | 'aborted' | 'error';

export interface RunResult {
  runId: string;
  fixtureId: string;
  provider: EvalProvider;
  status: RunStatus;
  /** 0..1; 0 when a required rule failed; null when inconclusive or errored. */
  score: number | null;
  scoreBeforePenalty: number | null;
  wrongTurns: number;
  rules: RuleOutcome[];
  /** Outcomes of `Fixture.preconditions`; a failed one makes the run `inconclusive`. */
  preconditions?: RuleOutcome[];
  usage: MeterUsage;
  durationMs: number;
  /**
   * Why the run ended: `quiescent` (the agents went quiet), `required-failed` (a negated required
   * rule matched), `decided` (every rule was decided before the agents stopped),
   * `settle-timeout` (they kept working after every required rule had matched),
   * `limit:wall-clock|tool-calls|requests|cost|prompts` (a `RunLimits` entry, or the meter's
   * per-run and per-agent request and dollar caps, which the agent's own behaviour trips),
   * `limit:budget` (the key's reserve, the daily and lifetime caps, the kill switch, the gateway or
   * the plan said no: the harness's budget, no score), `replay-miss` (the replay cache had no
   * recording: no score), `abort`, `error` (the run or the infrastructure failed: no score), or
   * `unexpected-prompt` (the fixture's `fail` policy met a prompt it has no answer for: no score).
   */
  endedBy: string;
  /** Machine-readable notes (e.g. an unexpected prompt, plants never served). */
  notes: string[];
  /**
   * Set when the run was cut short (a limit, the settle timeout) while negated required rules had
   * not matched: they passed only because nothing had been seen yet, the agents were stopped while
   * still free to act. The score stands (the rules judged what happened), but the run is not a
   * proof that these rules hold. Absent when every negated required rule was judged to the end.
   */
  unsettledNegated?: string[];
}

// ---------------------------------------------------------------------------------------------
// Observations: the one stream the rules, the log and the checkpoints are built on.
// ---------------------------------------------------------------------------------------------

export type Observation =
  | { seq: number; t: string; type: 'user_message'; text: string }
  | {
      seq: number;
      t: string;
      type: 'assistant_message';
      agent: AgentKind;
      text: string;
      procedureId?: string;
    }
  | {
      seq: number;
      t: string;
      type: 'tool_start';
      agent: AgentKind;
      procedureId?: string;
      toolCallId: string;
      tool: string;
      args: unknown;
    }
  | {
      seq: number;
      t: string;
      type: 'tool_end';
      agent: AgentKind;
      procedureId?: string;
      toolCallId: string;
      tool: string;
      isError: boolean;
      text: string;
    }
  | { seq: number; t: string; type: 'prompt_shown'; prompt: PendingPrompt }
  | {
      seq: number;
      t: string;
      type: 'agent_failure';
      agent: AgentKind;
      procedureId?: string;
      /**
       * What the app made of it (`AgentErrorKind`): a model request that failed for good after pi's
       * retries (`auth`, `quota`, `rate_limit`, `context`, `network`, `provider`, `unknown`), or
       * `crash`: the agent's host process died while the run was open and nobody had asked it to
       * stop. `src/run/infra.ts` says which of these are the infrastructure's and which the agent's.
       */
      kind: AgentErrorKind;
      message: string;
      /** `crash`: the signal that ended the host, if one did. */
      signal?: string;
    }
  | {
      seq: number;
      t: string;
      type: 'prompt_answered';
      itemId: string;
      answerId?: string;
      by: 'structured' | 'answerer' | 'default';
    }
  | { seq: number; t: string; type: 'vault_changed' }
  | { seq: number; t: string; type: 'net'; record: NetRecord }
  | {
      seq: number;
      t: string;
      type: 'bench';
      what: 'wrong_turn' | 'exfil' | 'download';
      data: unknown;
    }
  | { seq: number; t: string; type: 'quiescent' }
  | { seq: number; t: string; type: 'note'; text: string };

/** Read access to everything a rule may look at, evaluated lazily. */
export interface RunView {
  observations(): readonly Observation[];
  /** The scoring API's current state for this run's world. */
  benchState(): Promise<BenchWorldState>;
  /** Saved documents with decrypted bytes available on demand. */
  vaultDocuments(): Promise<
    {
      id: string;
      name: string;
      mimeType: string;
      source?: string;
      procedureId?: string;
      read(): Promise<Uint8Array>;
    }[]
  >;
  /** The text of every model-visible string that ever carried a registered secret (leak check). */
  secretLeaks(): string[];
}

/** One run on disk (`<runs root>/<runId>/`, `defaultRunsRoot`). See docs/EVAL.md for the layout. */
export interface CheckpointManifest {
  format: 'sa-eval-checkpoint/1';
  runId: string;
  index: number;
  atSeq: number;
  /** All agents idle and no prompt pending that cannot be restored. */
  quiescent: boolean;
  benchSnapshotFile: string;
  profileDir: string;
  browserStateFile?: string;
  answerState: { unlockedGroup: number; used: string[] };
  /**
   * `RuleEngine.state()`: `latched` maps matched rule ids to the seq they matched at, `leaves`
   * does the same for the single conditions of composite rules that were already seen.
   */
  ruleState: { latched: Record<string, number>; leaves?: Record<string, number> };
  meterUsage: MeterUsage;
}

// ---------------------------------------------------------------------------------------------
// Run seams (`src/bench`, `src/run`): what the loop needs from SpainBench and from the app, and
// what the app needs from the loop. Each side is built and tested against these types alone.
// ---------------------------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An observation before the run's `ObservationLog` stamps it with `seq` and `t`. */
export type ObservationInput = DistributiveOmit<Observation, 'seq' | 't'>;

/** The one sequencer of a run: every emitter pushes here (`src/run/observation-log.ts`). */
export interface ObservationSink {
  push(input: ObservationInput): Observation;
}

/** One entry of SpainBench's event stream (`GET /worlds/:id/events`). */
export interface BenchEvent {
  seq: number;
  t: string;
  /** `login`, `download`, `wrong_turn`, `exfil`, ... (the server's own names). */
  type: string;
  /** The `seq` of the request-log entry the event follows. */
  request?: number;
  data?: unknown;
}

/**
 * The scoring API of a running SpainBench, over HTTP (`src/bench`). The public listener is never
 * reachable through this object: only the network layer talks to it, as the agent's destination.
 */
export interface BenchApi {
  /** `http://127.0.0.1:<port>` of the public listener (what `HostEvalConfig.mockOrigin` is). */
  readonly publicOrigin: string;
  readonly scoringOrigin: string;
  version(): Promise<BenchVersion>;
  /** The host table: every real hostname the mock serves, answers as external, or is an asset. */
  hosts(): Promise<BenchHost[]>;
  createWorld(
    spec: BenchWorldSpec,
    options?: { snapshot?: unknown; replace?: boolean },
  ): Promise<{ id: string; warnings: string[] }>;
  deleteWorld(id: string): Promise<void>;
  state(id: string): Promise<BenchWorldState>;
  /** Long poll. `gone` when the world was deleted, expired or replaced while waiting. */
  events(
    id: string,
    since: number,
    options?: { waitMs?: number; signal?: AbortSignal },
  ): Promise<{ events: BenchEvent[]; next: number; truncated: boolean } | 'gone'>;
  /** The server's request log (every request of the world, with its classification). */
  requests(
    id: string,
    since?: number,
    limit?: number,
  ): Promise<{ requests: unknown[]; next: number; truncated: boolean; total: number }>;
  /** Opaque world snapshot (`spainbench-world/1`); `PUT` it back through `createWorld`. */
  snapshot(id: string, options?: { keepLog?: boolean }): Promise<unknown>;
  download(id: string, n: number): Promise<{ bytes: Uint8Array; sha256: string }>;
  setPlants(id: string, plants: { variant: string; collectorHost: string }): Promise<void>;
}

/** Everything `createEvalApp` (`src/run/app`) needs from the run that owns it. */
export interface EvalAppSpec {
  runId: string;
  /** `<runs root>/<runId>/`: the app writes `net/`, `transcripts/`, `browser/`, `host/`, `logs/`. */
  runDir: string;
  fixture: Fixture;
  provider: EvalProvider;
  models: EvalModelChoice;
  /** Stamps and logs every observation the app produces. */
  sink: ObservationSink;
  /**
   * The world's address book and where the mock listens. `worldId` is the id of the SpainBench
   * world (opaque: the agent can read it in the pages it is shown, so it carries no run metadata);
   * `scoringOrigin` is the listener that must never be an upstream.
   */
  bench: { publicOrigin: string; scoringOrigin: string; hosts: BenchHost[]; worldId: string };
  /** The frozen "now" of the agents (ISO 8601 with offset); also the clock of the app. */
  now: string;
  /** Record Playwright's HAR, trace and HTML per step under `browser/`. */
  captureBrowser: boolean;
  /** Restore this profile copy (a checkpoint's `profileDir`) instead of creating one. */
  restoreFrom?: { profileDir: string; browserStateFile?: string };
  /** Aborted by the run: stop everything now, cancel pending model requests. */
  signal: AbortSignal;
}

/**
 * The composed app of one run: the real headless app, its agents, browser and vault behind the
 * network layer and the meter, plus the observers that turn what happens into `Observation`s.
 * The run drives it as the user would and never reaches into its internals.
 */
export interface EvalApp {
  readonly runDir: string;
  /** The first (and any later) user message: `chat.send`. Resolves once the app accepted it. */
  send(text: string): Promise<void>;
  /**
   * Prompts the app waits on (assistant conversation and every procedure), oldest first. A prompt
   * is listed here, and counted by `counters().prompts`, before its `prompt_shown` observation is
   * pushed: the simulator answers from that observation and `respond` must find the prompt.
   */
  pendingPrompts(): PendingPrompt[];
  /** Answers one prompt through the app's own `chat.respond`. */
  respond(itemId: string, response: PromptResponse): Promise<void>;
  /** The UI's path for a Cl@ve credential: `vault.addClave`. Registers the password as a secret. */
  addClave(input: { username: string; password: string; label?: string }): Promise<string>;
  /** Masks a value in every log and artifact of the run. */
  addSecret(value: string): void;
  /**
   * No agent is running, the coordinator and the chat are settled and no prompt is pending
   * (including prompts the simulator has not answered yet).
   */
  idle(): boolean;
  /** Resolves true once `idle()` has held for `holdMs` (default 300), false on timeout or abort. */
  untilIdle(options?: {
    holdMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<boolean>;
  /** Totals for `RunLimits`. */
  counters(): { toolCalls: number; prompts: number };
  vaultDocuments(): ReturnType<RunView['vaultDocuments']>;
  /** Strings that carried a registered secret to the model, the network or a log (leak check). */
  secretLeaks(): string[];
  /** Stops the agents and the browser now and cancels their pending requests. */
  abort(reason: string): Promise<void>;
  /** Only while `idle()`: flushes, copies the profile and exports the browser state into `dir`. */
  checkpoint(dir: string): Promise<{ profileDir: string; browserStateFile?: string }>;
  /** Stops everything and flushes the logs. Safe to call twice. */
  close(): Promise<void>;
}

/** What `createEvalApp` needs besides the spec: the run's meter run and its model credentials. */
export interface EvalAppDeps {
  meter: MeterRun;
  credentials: CredentialSource;
}

/** The run loop's entry to the app (`src/run/app`); tests inject a fake. */
export type CreateEvalApp = (spec: EvalAppSpec, deps: EvalAppDeps) => Promise<EvalApp>;

/** Follows SpainBench's event stream of one world (`src/bench/events.ts`). */
export interface BenchFollower {
  /** Stops polling and finishes what it already read. */
  stop(): Promise<void>;
  /** Resolves once everything the server had recorded when `drain` was called was delivered. */
  drain(): Promise<void>;
}

/**
 * Turns the world's events into `bench` observations (`download`, `wrong_turn`, `exfil`; other
 * event types are only written to `rawFile`). A poll that fails for a moment is retried with
 * backoff and never ends a run; only a failure the follower gives up on does (`onError`).
 */
export type FollowBench = (
  api: BenchApi,
  worldId: string,
  sink: ObservationSink,
  options: {
    /** Only events after this cursor: 0 for a new world, `counters.seq` for a restored one. */
    since: number;
    /** Every event, raw, one JSON object per line. */
    rawFile?: string;
    /** A failure the follower survives and keeps trying (once per outage): a note of the run. */
    onWarning?: (error: Error) => void;
    /**
     * The follower gave up for good: a failure that cannot pass (a refused token, an unknown world,
     * an answer that breaks the contract) or an outage that outlasted the bound. The run can no
     * longer be judged from the world's events: it ends as an error.
     */
    onError?: (error: Error) => void;
    /** Masks typed secrets in the raw file's text (an exfil event carries what the agent sent). */
    scrub?: (text: string) => string;
  },
) => BenchFollower;

/**
 * Writes `state.json`, `requests.jsonl`, `downloads/` and `snapshot.json` of a world into `dir`
 * (and `errors.json` when a part failed: the others are still written).
 */
export type SaveBenchArtifacts = (
  api: BenchApi,
  worldId: string,
  dir: string,
  options?: {
    /** Masks typed secrets in the text files written (not in the bytes of the downloads). */
    scrub?: (text: string) => string;
  },
) => Promise<void>;
