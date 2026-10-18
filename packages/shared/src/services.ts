import { z } from 'zod';
import { ThinkingLevel } from './settings';
import { VOUCHER_BODY_LENGTH } from './voucher-code';

/**
 * HTTP contracts of the two backend services. Both are isolated from each other and never
 * receive conversations or personal data.
 */

// ---------------------------------------------------------------------------------------------
// Key server: vouchers -> capped LiteLLM virtual keys. The key server never sees conversations;
// the client calls our LiteLLM gateway at `baseUrl` with the key.
// Base path: /v1
// ---------------------------------------------------------------------------------------------

/**
 * POST /v1/vouchers/redeem. A client that already holds a voucher key sends it as
 * `Authorization: Bearer <key>`: while that key is active the voucher tops it up (its amount is
 * added to the key's budget, and the key expires at the later of the two deadlines) instead of
 * creating a new key. Otherwise the server creates a new key.
 */
export const RedeemVoucherRequest = z.object({
  /** `SA-` + 6 characters; normalized by the server (see voucher-code.ts). */
  code: z.string().trim().min(VOUCHER_BODY_LENGTH).max(64),
});
export type RedeemVoucherRequest = z.infer<typeof RedeemVoucherRequest>;

export const RedeemVoucherResponse = z.object({
  /** The key is a LiteLLM virtual key for our gateway (OpenAI-compatible). */
  provider: z.literal('litellm'),
  /**
   * OpenAI-compatible base URL of our LiteLLM gateway, e.g. https://llm.example.org/v1. Chat:
   * POST {baseUrl}/chat/completions. Web search (same key and budget): POST
   * {baseUrl}/search/{tool}. Balance: GET /v1/vouchers/credit on the key server.
   */
  baseUrl: z.string().url(),
  /** The key the client sent (topped up), or a new one. */
  apiKey: z.string().min(1),
  /** What the key's vouchers add up to in USD, this voucher included. */
  limitUsd: z.number().nonnegative(),
  /** What the key had used before this voucher, web research included (0 for a new key). */
  usageUsd: z.number().nonnegative(),
  /** This voucher's amount. */
  addedUsd: z.number().positive(),
  /** Search tools the key may call at {baseUrl}/search/{tool}. Empty: every tool on the gateway. */
  searchTools: z.array(z.string()),
  /** ISO 8601, if the key expires. */
  expiresAt: z.string().optional(),
});
export type RedeemVoucherResponse = z.infer<typeof RedeemVoucherResponse>;

/**
 * GET /v1/vouchers/credit with `Authorization: Bearer <voucher key>`: the key's balance (also of
 * expired or blocked keys). Web research is charged by lowering the gateway's cap, not by adding
 * spend, so the cap is not what the vouchers add up to: remaining = `maxBudgetUsd - spendUsd`,
 * used = `limitUsd - remaining`. LiteLLM's response headers on each LLM call carry the same
 * spend and cap (`x-litellm-key-spend`, `x-litellm-key-max-budget`).
 */
export const VoucherCreditResponse = z.object({
  /** What the key's vouchers add up to in USD (revoked ones excluded). */
  limitUsd: z.number().nonnegative(),
  /** The gateway's spend of the key: LLM calls and searches. */
  spendUsd: z.number().nonnegative(),
  /** The gateway's cap of the key: `limitUsd` minus web research charges. */
  maxBudgetUsd: z.number().nonnegative(),
  /** ISO 8601, or null when the key never expires. */
  expiresAt: z.string().nullable(),
});
export type VoucherCreditResponse = z.infer<typeof VoucherCreditResponse>;

/**
 * Document-scan frame decider on our LiteLLM gateway: OpenRouter's Decisions API
 * (`POST https://openrouter.ai/api/alpha/decisions`) through LiteLLM's OpenRouter pass-through,
 * charged to the calling key. Voucher keys and ChatGPT keys may call it; nothing else under
 * `/openrouter`.
 */
export const LITELLM_DECIDER_PATH = '/openrouter/alpha/decisions';

/** `{gateway}/openrouter/alpha/decisions` for a key's `…/v1` base URL. */
export function litellmDeciderUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}${LITELLM_DECIDER_PATH}`;
}

/**
 * Transcribes phone-call recordings (`phone_call` prompts) through our gateway's
 * `/v1/chat/completions` with an `input_audio` part. Voucher keys and ChatGPT keys may call it.
 * Gemini 3.5 Flash-Lite on OpenRouter: $0.30 per million audio tokens (32 tokens per second,
 * about $0.006 per 10 minutes of audio) plus $2.50 per million output tokens; served by Google
 * Vertex, which has zero-data-retention endpoints.
 */
export const TRANSCRIPTION_MODEL = 'google/gemini-3.5-flash-lite';

/**
 * POST /v1/chatgpt-keys — the scan-decider key of a "Sign in with ChatGPT" user. The app
 * sends the OpenAI ID token it received (and verified) at sign-in; never the access token.
 */
export const ChatGPTKeyRequest = z.object({
  idToken: z
    .string()
    .min(20)
    .max(8192)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
});
export type ChatGPTKeyRequest = z.infer<typeof ChatGPTKeyRequest>;

/**
 * One permanent LiteLLM key per OpenAI account (the same on every device). It may only call the
 * scan decider (`litellmDeciderUrl(baseUrl)`, model `deciderModel`), transcribe phone calls
 * (`{baseUrl}/chat/completions`, model TRANSCRIPTION_MODEL) and read its own `/key/info`. Out of allowance, LiteLLM answers 422 `budget_exceeded`.
 */
export const ChatGPTKeyResponse = z.object({
  provider: z.literal('litellm'),
  /** `…/v1` base URL of our LiteLLM gateway. */
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  /** OpenRouter id of the decider model the key may call. */
  deciderModel: z.string().min(1),
  /** Spending caps of the account, in USD per calendar day / month (UTC). */
  dailyLimitUsd: z.number().nonnegative(),
  monthlyLimitUsd: z.number().nonnegative(),
});
export type ChatGPTKeyResponse = z.infer<typeof ChatGPTKeyResponse>;

/** Research depth. The key server maps each mode to a Parallel processor and its price. */
export const ResearchMode = z.enum(['fast', 'balanced', 'deep']);
export type ResearchMode = z.infer<typeof ResearchMode>;

/**
 * POST /v1/research — web research (Parallel Task API) paid from a voucher key's budget.
 * `Authorization: Bearer <voucher apiKey>`. The client picks a mode; the server maps it to the
 * processor and the price. Answers `text/event-stream` with `ResearchEvent`s
 * (`event: <type>`, `data: <json>`), ending with `completed` or `failed`.
 */
export const ResearchRequest = z.strictObject({
  /** What to research, with anonymized context. Never identifying personal data. */
  input: z.string().trim().min(1).max(12_000),
  mode: ResearchMode,
  /**
   * Shape of the answer: a plain-language description (text answer) or a JSON Schema object
   * (structured answer). Omitted: the provider decides.
   */
  outputSchema: z
    .union([z.string().trim().min(1).max(4_000), z.record(z.string(), z.json())])
    .optional(),
  /** Makes retries safe: the same id from the same key re-attaches to the same run. */
  requestId: z.uuid().optional(),
});
export type ResearchRequest = z.infer<typeof ResearchRequest>;

export const ResearchOutput = z.object({
  /** "json" when an output schema object was given, else "text". */
  type: z.enum(['text', 'json']),
  content: z.json(),
  /** Citations, reasoning and confidence per output field, as the provider returns them. */
  basis: z.array(z.json()).default([]),
});
export type ResearchOutput = z.infer<typeof ResearchOutput>;

export const ResearchEvent = z.discriminatedUnion('type', [
  /** The run exists and its price is reserved from the key's budget. */
  z.object({ type: z.literal('created'), id: z.uuid(), priceUsd: z.number().nonnegative() }),
  /** Still working (sent at least every ~30 s). */
  z.object({
    type: z.literal('progress'),
    id: z.uuid(),
    status: z.enum(['queued', 'running']),
    elapsedSeconds: z.number().nonnegative(),
  }),
  z.object({ type: z.literal('completed'), id: z.uuid(), output: ResearchOutput }),
  z.object({
    type: z.literal('failed'),
    id: z.uuid(),
    /** `failed` (the run failed), `timeout` (no result in time), `unavailable` (lost track). */
    code: z.enum(['failed', 'timeout', 'unavailable']),
    message: z.string(),
    /** False when the price went back to the key (failed runs are not billed). */
    charged: z.boolean(),
  }),
]);
export type ResearchEvent = z.infer<typeof ResearchEvent>;

/** GET /v1/research/:id — a run of the calling key (404 for runs of other keys). */
export const ResearchRunInfo = z.object({
  id: z.uuid(),
  status: z.enum(['running', 'completed', 'failed', 'expired']),
  priceUsd: z.number().nonnegative(),
  charged: z.boolean(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  /** Only for completed runs (fetched again from the provider; never stored). */
  output: ResearchOutput.optional(),
});
export type ResearchRunInfo = z.infer<typeof ResearchRunInfo>;

/** Error body used by both services: { error: { code, message } } */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const VoucherErrorCode = z.enum([
  'invalid_code', // unknown code
  'already_redeemed',
  'expired',
  'revoked',
  'rate_limited',
  'provider_error', // upstream key provisioning failed
  'unauthorized', // invalid admin token
  'invalid_identity', // POST /v1/chatgpt-keys: the ID token was rejected
  'chatgpt_keys_disabled', // ChatGPT keys are turned off on this server
  'bad_request',
  'not_found',
  'internal',
  'insufficient_budget', // research: the key's remaining budget is below the price of a run
  'research_unavailable', // research is not configured on this server
]);
export type VoucherErrorCode = z.infer<typeof VoucherErrorCode>;

// ---------------------------------------------------------------------------------------------
// Feedback server: anonymous learnings shared between agents
// Base path: /v1
// ---------------------------------------------------------------------------------------------

export const FeedbackKind = z.enum([
  'tip', // something useful to know ("el formulario acepta PDF de hasta 5 MB")
  'friction', // something that went wrong / was hard ("la sede caduca la sesión a los 10 min")
  'gotcha', // non-obvious trap ("hay que marcar 'renovación' y no 'expedición'")
]);
export type FeedbackKind = z.infer<typeof FeedbackKind>;

/**
 * Who wrote a learning. Agents: "<model id> · <reasoning level>", e.g. "gpt-6-luna · high" or
 * "anthropic/claude-haiku-5.5 · medium" (the app sets it, never the model). Maintainers who
 * write or edit an entry on the admin page: "human".
 */
export const HUMAN_AUTHOR = 'human';

const MODEL_ID_MAX = 100;
const AGENT_AUTHOR_RE = new RegExp(
  `^[A-Za-z0-9][\\w.:/@+-]{0,${MODEL_ID_MAX - 1}} · (${ThinkingLevel.options.join('|')})$`,
);

/** An agent author as submissions carry it ("human" never matches). */
export const AgentAuthor = z
  .string()
  .max(MODEL_ID_MAX + 10)
  .regex(AGENT_AUTHOR_RE);

/** Any author a maintainer can set on the admin page: "human" or an agent author. */
export const FeedbackAuthor = z.union([z.literal(HUMAN_AUTHOR), AgentAuthor]);
export type FeedbackAuthor = z.infer<typeof FeedbackAuthor>;

/**
 * The author string of an agent running `modelId` at `level`. Characters outside the allowed
 * set (letters, digits, `_ . : / @ + -`) become "-", so any model id gives a valid author.
 */
export function agentAuthor(modelId: string, level: ThinkingLevel): string {
  const id = modelId
    .trim()
    .replace(/[^\w.:/@+-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, MODEL_ID_MAX);
  return `${id || 'unknown'} · ${level}`;
}

/** POST /v1/feedback. Must be free of personal data (scrubbed client- and server-side). */
export const FeedbackSubmission = z.object({
  /** Procedure name, e.g. "Renovación del DNI". */
  procedure: z.string().trim().min(3).max(200),
  /** e.g. "Policía Nacional". */
  administration: z.string().trim().max(200).optional(),
  /** Region / municipality if relevant (never addresses), e.g. "Comunidad de Madrid". */
  region: z.string().trim().max(100).optional(),
  kind: FeedbackKind,
  title: z.string().trim().min(5).max(200),
  body: z.string().trim().min(10).max(4000),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  /** Official URLs involved (query strings and fragments are stripped). */
  urls: z.array(z.string().url()).max(5).default([]),
  appVersion: z.string().max(40).optional(),
  /** The submitting agent (see AgentAuthor); the server only stores "human" from the admin API. */
  author: AgentAuthor,
});
export type FeedbackSubmission = z.infer<typeof FeedbackSubmission>;

export const FeedbackSubmitResponse = z.object({
  id: z.string(),
  /** Number of redactions the server applied on top of the client's scrubbing. */
  redactions: z.number().int().nonnegative(),
});
export type FeedbackSubmitResponse = z.infer<typeof FeedbackSubmitResponse>;

export const FeedbackEntry = z.object({
  id: z.string(),
  procedure: z.string(),
  administration: z.string().optional(),
  region: z.string().optional(),
  kind: FeedbackKind,
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  urls: z.array(z.string()),
  /** An agent ("<model id> · <reasoning level>") or "human"; missing when unknown (old entries). */
  author: z.string().optional(),
  createdAt: z.string(),
  /** Relevance score for search results. */
  score: z.number().optional(),
  /**
   * Net vote weight after decay: an agent vote counts 1, a human vote counts the server's
   * threshold. At +threshold an entry is always served, at -threshold never.
   */
  votes: z.number(),
});
export type FeedbackEntry = z.infer<typeof FeedbackEntry>;

/** GET /v1/feedback/search?q=...&procedure=...&kind=...&limit=... */
export const FeedbackSearchQuery = z.object({
  q: z.string().trim().min(2).max(300),
  procedure: z.string().trim().max(200).optional(),
  kind: FeedbackKind.optional(),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});
export type FeedbackSearchQuery = z.infer<typeof FeedbackSearchQuery>;

export const FeedbackSearchResponse = z.object({
  results: z.array(FeedbackEntry),
});
export type FeedbackSearchResponse = z.infer<typeof FeedbackSearchResponse>;

export const FeedbackVote = z.enum(['up', 'down']);
export type FeedbackVote = z.infer<typeof FeedbackVote>;

/** POST /v1/feedback/:id/vote (agents) and POST /admin/feedback/:id/vote (humans). */
export const FeedbackVoteRequest = z.object({ vote: FeedbackVote });
export type FeedbackVoteRequest = z.infer<typeof FeedbackVoteRequest>;

export const FeedbackVoteResponse = z.object({
  id: z.string(),
  /** False when this client already voted on this entry (only the first vote counts). */
  counted: z.boolean(),
});
export type FeedbackVoteResponse = z.infer<typeof FeedbackVoteResponse>;

// ---------------------------------------------------------------------------------------------
// Feedback server admin API (Bearer ADMIN_TOKEN; 404 when the server has none)
// Base path: /admin. The admin page (GET /admin) is its client.
// ---------------------------------------------------------------------------------------------

export const FeedbackVoter = z.enum(['agent', 'human']);
export type FeedbackVoter = z.infer<typeof FeedbackVoter>;

/** GET /admin/feedback?q=&kind=&procedure=&tag=&author=&votes=&reviewed=&sort=&limit=&offset= */
export const FeedbackAdminListQuery = z.object({
  /** Words in any text field (stemmed, accent-insensitive), a substring, or an id prefix. */
  q: z.string().trim().max(300).optional(),
  kind: FeedbackKind.optional(),
  /** Exact procedure name (case-insensitive). */
  procedure: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(40).optional(),
  /** Exact author, e.g. "human" or "gpt-6-luna · high". */
  author: z.string().trim().max(120).optional(),
  /** Net vote weight now: above 0, below 0, or exactly 0 (including no votes). */
  votes: z.enum(['up', 'down', 'neutral']).optional(),
  /** Whether a human (admin) has voted on it. */
  reviewed: z.enum(['yes', 'no']).optional(),
  sort: z.enum(['newest', 'oldest', 'votes', 'edited']).default('newest'),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type FeedbackAdminListQuery = z.infer<typeof FeedbackAdminListQuery>;

export const FeedbackAdminEntry = FeedbackEntry.extend({
  appVersion: z.string().optional(),
  /** Last admin edit. */
  updatedAt: z.string().optional(),
  /** Chance (0-1) that a search returning it serves it, from `votes`. */
  chance: z.number(),
  /** Raw vote counts (before weights and decay). */
  upVotes: z.number().int().nonnegative(),
  downVotes: z.number().int().nonnegative(),
  humanVotes: z.number().int().nonnegative(),
});
export type FeedbackAdminEntry = z.infer<typeof FeedbackAdminEntry>;

export const FeedbackAdminList = z.object({
  results: z.array(FeedbackAdminEntry),
  /** Entries matching the filters (all pages). */
  total: z.number().int().nonnegative(),
});
export type FeedbackAdminList = z.infer<typeof FeedbackAdminList>;

export const FeedbackAdminVote = z.object({
  id: z.string(),
  vote: FeedbackVote,
  voter: FeedbackVoter,
  createdAt: z.string(),
  /** What it adds to the entry's net weight now (signed, after decay). */
  weight: z.number(),
});
export type FeedbackAdminVote = z.infer<typeof FeedbackAdminVote>;

/** GET /admin/feedback/:id */
export const FeedbackAdminDetail = z.object({
  entry: FeedbackAdminEntry,
  /** Newest first. */
  votes: z.array(FeedbackAdminVote),
});
export type FeedbackAdminDetail = z.infer<typeof FeedbackAdminDetail>;

/**
 * PUT /admin/feedback/:id: the whole editable entry, scrubbed like a submission. `author` is
 * "human" or an agent author; leaving it out makes the author unknown.
 */
export const FeedbackEdit = FeedbackSubmission.omit({ appVersion: true, author: true }).extend({
  author: FeedbackAuthor.optional(),
});
export type FeedbackEdit = z.infer<typeof FeedbackEdit>;

/**
 * POST /admin/feedback: a new entry written by a maintainer, scrubbed like a submission. Same
 * fields as an edit; `author` defaults to "human".
 */
export const FeedbackCreate = FeedbackEdit.extend({
  author: FeedbackAuthor.default(HUMAN_AUTHOR),
});
export type FeedbackCreate = z.infer<typeof FeedbackCreate>;

/** Answer to PUT /admin/feedback/:id (200) and POST /admin/feedback (201). */
export const FeedbackEditResponse = z.object({
  entry: FeedbackAdminEntry,
  /** Redactions the server applied to the edit or the new entry. */
  redactions: z.number().int().nonnegative(),
});
export type FeedbackEditResponse = z.infer<typeof FeedbackEditResponse>;

const FacetCount = z.object({ value: z.string(), count: z.number().int().positive() });

/** GET /admin/feedback/stats */
export const FeedbackAdminStats = z.object({
  total: z.number().int().nonnegative(),
  kinds: z.record(FeedbackKind, z.number().int().nonnegative()),
  votes: z.object({
    up: z.number().int().nonnegative(),
    down: z.number().int().nonnegative(),
    neutral: z.number().int().nonnegative(),
  }),
  /** Entries with at least one human vote. */
  reviewed: z.number().int().nonnegative(),
  /** Most common procedures, tags and authors, most frequent first. */
  procedures: z.array(FacetCount),
  tags: z.array(FacetCount),
  authors: z.array(FacetCount),
  policy: z.object({
    threshold: z.number(),
    decayStartDays: z.number(),
    decayEndDays: z.number(),
  }),
});
export type FeedbackAdminStats = z.infer<typeof FeedbackAdminStats>;

/**
 * GET /admin/feedback/search?q=&procedure=&kind=&limit=: the agents' search without the serving
 * draw, so admins see every candidate in relevance order with its score and chance.
 */
export const FeedbackAdminSearchResponse = z.object({
  results: z.array(FeedbackAdminEntry),
});
export type FeedbackAdminSearchResponse = z.infer<typeof FeedbackAdminSearchResponse>;
