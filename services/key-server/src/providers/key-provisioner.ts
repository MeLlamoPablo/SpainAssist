import { randomBytes } from 'node:crypto';
import { LITELLM_DECIDER_PATH, TRANSCRIPTION_MODEL } from '@sa/shared';
import { z } from 'zod';
import { sha256Hex } from '../crypto';

/**
 * What a key may do:
 * - "inference": a voucher key: the allowed models, the search tools, the scan decider and call
 *   transcription;
 * - "decider": a ChatGPT subsidy key: only the document-scan frame decider (D12) and call
 *   transcription (chat completions, TRANSCRIPTION_MODEL only).
 */
export type KeyScope = 'inference' | 'decider';

/** One LiteLLM budget window: spend in each `duration` (e.g. "1d", "1mo") is capped. */
export interface BudgetWindow {
  maxBudgetUsd: number;
  /** LiteLLM `budget_duration` ("1d", "1mo"…); windows reset at the start of each period. */
  duration: string;
}

export interface ProvisionKeyRequest {
  /** Unique alias shown in the LiteLLM admin UI. Never contains a voucher code or an account. */
  alias: string;
  scope: KeyScope;
  /** Lifetime spending cap in USD (LLM calls, searches and decisions together). */
  limitUsd?: number;
  /** Periodic caps (LiteLLM `budget_limits`), checked before every call. */
  budgetWindows?: BudgetWindow[];
  /** When the key stops working; omitted = never. */
  expiresAt?: Date;
  /** LiteLLM team whose own budget also applies (the optional global cap). */
  teamId?: string;
  /** Non-secret labels stored with the key (e.g. the voucher id). */
  metadata?: Record<string, string>;
}

/** A LiteLLM team: one budget shared by all its keys. */
export interface TeamRequest {
  alias: string;
  /** Budget of the whole team per `duration`; null = no cap. */
  maxBudgetUsd: number | null;
  duration: string;
  models: string[];
}

export interface ProvisionedKey {
  /** The secret API key: returned to the client, never logged. */
  key: string;
  /** Provider-side id used to manage the key later (LiteLLM's hashed token). */
  id: string;
  /** OpenAI-compatible base URL the client must call. */
  baseUrl: string;
  /** ISO 8601 expiry, if the key expires. */
  expiresAt?: string;
}

/** Spend and cap of a key, as the provider enforces them. */
export interface KeyBudget {
  spendUsd: number;
  /** Spending cap in USD; null = unlimited. */
  maxBudgetUsd: number | null;
  /** False when the key is blocked, expired or deleted. */
  active: boolean;
}

/** Creates and disables capped API keys, and reads and moves their budget. */
export interface KeyProvisioner {
  readonly kind: 'litellm' | 'mock';
  /** OpenAI-compatible base URL clients call with the keys (`…/v1`). */
  readonly baseUrl: string;
  create(request: ProvisionKeyRequest): Promise<ProvisionedKey>;
  /** Disables a key so it stops working (idempotent; unknown keys count as disabled). */
  disable(id: string): Promise<void>;
  /** Creates a team (a budget shared by many keys) and returns its id. */
  createTeam(request: TeamRequest): Promise<string>;
  /** Sets a team's budget and models. */
  updateTeam(id: string, request: TeamRequest): Promise<void>;
  /** The key's current spend and cap; null if the provider does not know the key. */
  budget(id: string): Promise<KeyBudget | null>;
  /**
   * Sets the key's spending cap (USD), and its expiry when `expiresAt` is given (null = never).
   * Only the key server changes them after creation.
   */
  setMaxBudget(id: string, maxBudgetUsd: number, expiresAt?: Date | null): Promise<void>;
}

/** USD amounts sent to LiteLLM: rounded to 1e-6 so repeated reservations do not drift. */
export const roundUsd = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** LiteLLM only takes an expiry as a duration from now: whole seconds, at least one. */
function durationUntil(expiresAt: Date): string {
  return `${Math.max(Math.ceil((expiresAt.getTime() - Date.now()) / 1000), 1)}s`;
}

/** Upstream provider failure. Messages never include keys or response bodies with keys. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The scan decider: OpenRouter's Decisions API through LiteLLM's OpenRouter pass-through
 * (`/openrouter/{path}` → `https://openrouter.ai/api/{path}`). LiteLLM v1.104 prices exactly this
 * path from the token usage of each answer (`is_openrouter_decisions_route`), so it is charged to
 * the key and its budgets are checked before the call. `/api/v1/systemone` is the same API but is
 * not priced, so keys never get it.
 */
export const DECIDER_ROUTE = LITELLM_DECIDER_PATH;

/**
 * Routes a key may call, matched by LiteLLM as exact paths or path prefixes. Deliberately not
 * LiteLLM's `llm_api_routes` group: that group includes the provider pass-through routes
 * (`/openrouter/*`, `/openai/*`, …), which forward to the provider with the proxy's own
 * credentials and, for OpenRouter chat, record no spend, so a key could bypass both its model
 * allowlist and its budget. It also includes MCP, agents, files, batches and vector stores.
 * The one pass-through path keys get is DECIDER_ROUTE. LiteLLM also accepts sub-paths of it,
 * including `..` segments that the pass-through then resolves (`…/decisions/../../v1/chat/…`):
 * the public reverse proxy must forward only the exact path (see the key-server README).
 * `/key/info` lets the client read its own spend and budget (it cannot read other keys).
 */
export const KEY_ROUTES: Readonly<Record<KeyScope, readonly string[]>> = {
  inference: ['/v1/chat/completions', '/v1/models', '/v1/search', DECIDER_ROUTE, '/key/info'],
  // Chat completions only for TRANSCRIPTION_MODEL: the key's `models` allow nothing else.
  decider: [DECIDER_ROUTE, '/v1/chat/completions', '/key/info'],
};

/** LiteLLM's id for a key: the SHA-256 of the key, as 64 hex characters. */
const LITELLM_KEY_ID = /^[0-9a-f]{64}$/i;

const GenerateKeyResponse = z.object({
  key: z.string().startsWith('sk-'),
  /** v1.104: `token` and `token_id` both hold the hashed token (`/key/block` accepts it). */
  token_id: z.string().regex(LITELLM_KEY_ID).nullish(),
  token: z.string().regex(LITELLM_KEY_ID).nullish(),
  expires: z.string().nullish(),
});

const TeamResponse = z.object({ team_id: z.string().min(1) });

const KeyInfoResponse = z.object({
  info: z.object({
    spend: z.number().nullish(),
    max_budget: z.number().nullish(),
    blocked: z.boolean().nullish(),
    /** v1.104: "active" | "expired" | "revoked" | "deleted". */
    status: z.string().nullish(),
    expires: z.string().nullish(),
  }),
});

const SECRET_LIKE = /\bsk-[A-Za-z0-9_-]+|\b[0-9a-f]{32,}\b|Bearer\s+\S+/gi;

/**
 * Short, secret-free description of an upstream error body. LiteLLM sometimes echoes parts of
 * the caller's key ("sk-...abcd") or its hash in auth errors: redact anything key-like.
 */
async function upstreamMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { message?: unknown; type?: unknown };
      detail?: unknown;
    };
    const raw = body?.error?.message ?? body?.detail;
    const message =
      typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? JSON.stringify(raw) : '';
    const clean = message.replace(SECRET_LIKE, '[redacted]').replace(/\s+/g, ' ').trim();
    return clean ? `: ${clean.slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

export interface LiteLLMProvisionerOptions {
  /** Base URL of the admin API (internal), e.g. http://litellm:4000. */
  adminUrl: string;
  /** Master key. Never sent anywhere but the admin API, never logged. */
  masterKey: string;
  /** Base URL handed to clients (they get `${publicUrl}/v1`). Default: adminUrl. */
  publicUrl?: string;
  /** Models voucher keys may call (LiteLLM model names). Empty: every model on the proxy. */
  models?: readonly string[];
  /** Search tools voucher keys may call. Empty: every search tool on the proxy. */
  searchTools?: readonly string[];
  /** OpenRouter id of the scan decider: the only model of decider keys. */
  deciderModel: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const trimSlashes = (url: string) => url.replace(/\/+$/, '');

/**
 * LiteLLM proxy admin API (tested against v1.104): `POST /key/generate` creates a virtual key
 * with a USD `max_budget` and/or `budget_limits` windows; the plaintext key appears only in that
 * response. `POST /key/block` disables it (it accepts the hashed token we keep). `POST
 * /team/new` and `/team/update` manage a shared budget. See docs/research/litellm-gateway.md.
 */
export class LiteLLMProvisioner implements KeyProvisioner {
  readonly kind = 'litellm';
  private readonly adminUrl: string;
  readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: LiteLLMProvisionerOptions) {
    this.adminUrl = trimSlashes(options.adminUrl);
    this.baseUrl = `${trimSlashes(options.publicUrl ?? options.adminUrl)}/v1`;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async post(path: string, body: unknown, action: string): Promise<Response> {
    return this.call(path, action, { method: 'POST', body: JSON.stringify(body) });
  }

  private async call(path: string, action: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetch(`${this.adminUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.options.masterKey}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ProviderError(`LiteLLM unreachable during ${action} (${(err as Error).name})`);
    }
  }

  private async ensureOk(res: Response, action: string): Promise<void> {
    if (!res.ok) {
      throw new ProviderError(
        `LiteLLM ${action} failed (${res.status})${await upstreamMessage(res)}`,
      );
    }
  }

  async create(request: ProvisionKeyRequest): Promise<ProvisionedKey> {
    const { deciderModel } = this.options;
    const voucherModels = this.options.models ?? [];
    // LiteLLM checks the body's `model` on pass-through routes too, so the decider must be in
    // the list, like the call-transcription model. An empty list means every model.
    const models =
      request.scope === 'decider'
        ? [deciderModel, TRANSCRIPTION_MODEL]
        : voucherModels.length > 0
          ? [...new Set([...voucherModels, deciderModel, TRANSCRIPTION_MODEL])]
          : [];
    const body: Record<string, unknown> = {
      key_alias: request.alias,
      models,
      allowed_routes: KEY_ROUTES[request.scope],
      metadata: request.metadata ?? {},
    };
    if (request.limitUsd !== undefined) body.max_budget = request.limitUsd;
    if (request.budgetWindows?.length) {
      body.budget_limits = request.budgetWindows.map((w) => ({
        budget_duration: w.duration,
        max_budget: w.maxBudgetUsd,
      }));
    }
    if (request.expiresAt) body.duration = durationUntil(request.expiresAt);
    if (request.teamId) body.team_id = request.teamId;
    const searchTools = this.options.searchTools ?? [];
    if (request.scope === 'inference' && searchTools.length > 0) {
      body.object_permission = { search_tools: [...searchTools] };
    }

    const res = await this.post('/key/generate', body, 'key creation');
    await this.ensureOk(res, 'key creation');
    const parsed = GenerateKeyResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ProviderError('LiteLLM returned an unexpected response');
    const { key, token_id, token, expires } = parsed.data;
    const id = token_id ?? token;
    if (!id) throw new ProviderError('LiteLLM returned no key id');
    const expiresAt = expires ? new Date(expires).toISOString() : undefined;
    return { key, id, baseUrl: this.baseUrl, ...(expiresAt ? { expiresAt } : {}) };
  }

  async disable(id: string): Promise<void> {
    const res = await this.post('/key/block', { key: id }, 'key block');
    if (res.status === 404) return; // unknown or deleted: nothing left to disable
    await this.ensureOk(res, 'key block');
  }

  private teamBody(request: TeamRequest): Record<string, unknown> {
    return {
      team_alias: request.alias,
      max_budget: request.maxBudgetUsd,
      budget_duration: request.duration,
      models: request.models,
    };
  }

  async createTeam(request: TeamRequest): Promise<string> {
    const res = await this.post('/team/new', this.teamBody(request), 'team creation');
    await this.ensureOk(res, 'team creation');
    const parsed = TeamResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ProviderError('LiteLLM returned an unexpected team response');
    return parsed.data.team_id;
  }

  async updateTeam(id: string, request: TeamRequest): Promise<void> {
    const res = await this.post(
      '/team/update',
      { team_id: id, ...this.teamBody(request) },
      'team update',
    );
    await this.ensureOk(res, 'team update');
  }

  /** `GET /key/info?key=<hashed token>` with the master key (the hash keeps the key out of URLs). */
  async budget(id: string): Promise<KeyBudget | null> {
    const res = await this.call(`/key/info?key=${encodeURIComponent(id)}`, 'key info');
    if (res.status === 404) return null;
    await this.ensureOk(res, 'key info');
    const parsed = KeyInfoResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ProviderError('LiteLLM returned an unexpected key info');
    const { spend, max_budget, blocked, status, expires } = parsed.data.info;
    const expired = expires ? Date.parse(expires) <= Date.now() : false;
    return {
      spendUsd: spend ?? 0,
      maxBudgetUsd: max_budget ?? null,
      active: !blocked && !expired && (status ?? 'active') === 'active',
    };
  }

  /**
   * `POST /key/update {key, max_budget, duration?}` (v1.104 accepts the hashed token; a
   * `duration` sets the expiry from now, null removes it). LiteLLM keeps writing `spend` itself
   * (batched), so we never touch `spend`: we move the cap instead.
   */
  async setMaxBudget(id: string, maxBudgetUsd: number, expiresAt?: Date | null): Promise<void> {
    const body: Record<string, unknown> = { key: id, max_budget: roundUsd(maxBudgetUsd) };
    if (expiresAt !== undefined) body.duration = expiresAt ? durationUntil(expiresAt) : null;
    const res = await this.post('/key/update', body, 'key update');
    await this.ensureOk(res, 'key update');
  }
}

export const MOCK_LLM_BASE_URL = 'http://127.0.0.1:8789/v1';

/**
 * Local stand-in used when no LiteLLM proxy is configured: hands out `sk-mock-…` keys for the
 * mock LLM (tools/mock-llm), so onboarding works offline in dev and e2e tests.
 */
export class MockProvisioner implements KeyProvisioner {
  readonly kind = 'mock';
  /** Keys handed out, by id (for tests and debugging; holds no real secrets). */
  readonly keys = new Map<
    string,
    {
      alias: string;
      scope: KeyScope;
      limitUsd?: number;
      budgetWindows?: BudgetWindow[];
      teamId?: string;
      /** Null = never expires. */
      expiresAt: Date | null;
      spendUsd: number;
      disabled: boolean;
    }
  >();
  /** Teams created, by id. */
  readonly teams = new Map<string, TeamRequest>();

  constructor(private readonly options: { baseUrl?: string; delayMs?: number } = {}) {}

  get baseUrl(): string {
    return this.options.baseUrl ?? MOCK_LLM_BASE_URL;
  }

  async create(request: ProvisionKeyRequest): Promise<ProvisionedKey> {
    if (this.options.delayMs) await new Promise((r) => setTimeout(r, this.options.delayMs));
    const key = `sk-mock-${randomBytes(24).toString('hex')}`;
    const id = sha256Hex(key);
    this.keys.set(id, {
      alias: request.alias,
      scope: request.scope,
      ...(request.limitUsd !== undefined ? { limitUsd: request.limitUsd } : {}),
      ...(request.budgetWindows ? { budgetWindows: request.budgetWindows } : {}),
      ...(request.teamId ? { teamId: request.teamId } : {}),
      expiresAt: request.expiresAt ?? null,
      spendUsd: 0,
      disabled: false,
    });
    const expiresAt = request.expiresAt?.toISOString();
    return {
      key,
      id,
      baseUrl: this.baseUrl,
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  async disable(id: string): Promise<void> {
    const entry = this.keys.get(id);
    if (entry) entry.disabled = true;
  }

  async createTeam(request: TeamRequest): Promise<string> {
    const id = `mock-team-${randomBytes(6).toString('hex')}`;
    this.teams.set(id, request);
    return id;
  }

  async updateTeam(id: string, request: TeamRequest): Promise<void> {
    this.teams.set(id, request);
  }

  /** Mock keys live in memory only: after a restart they are unknown (null). */
  async budget(id: string): Promise<KeyBudget | null> {
    const entry = this.keys.get(id);
    if (!entry) return null;
    return {
      spendUsd: entry.spendUsd,
      maxBudgetUsd: entry.limitUsd ?? null,
      active: !entry.disabled && (!entry.expiresAt || entry.expiresAt.getTime() > Date.now()),
    };
  }

  async setMaxBudget(id: string, maxBudgetUsd: number, expiresAt?: Date | null): Promise<void> {
    const entry = this.keys.get(id);
    if (!entry) throw new ProviderError('Unknown mock key');
    entry.limitUsd = roundUsd(maxBudgetUsd);
    if (expiresAt !== undefined) entry.expiresAt = expiresAt;
  }
}
