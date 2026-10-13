import { CustomApi, Language, ThinkingLevel } from '@sa/shared';
import { z } from 'zod';

/**
 * Non-secret configuration of one agent host process, passed as JSON in `SA_AGENT_CONFIG`.
 * Secrets (API keys, OAuth tokens) never go here: the host asks the app for them over the bridge
 * (`agent.credential`).
 */
export const AgentHostConfigSchema = z.object({
  /**
   * "assistant": the orchestrator behind the single chat (delegates everything);
   * "procedure": the agent of one procedure (does the work).
   */
  role: z.enum(['assistant', 'procedure']).default('procedure'),
  /** The procedure this agent works on, or ASSISTANT_AGENT_ID for the assistant. */
  procedureId: z.string().min(1),
  /** pi session file of this agent (JSONL). Created if missing, resumed otherwise. */
  sessionFile: z.string().min(1),
  language: Language,
  model: z.object({
    /**
     * pi provider id: "openai" (Sign in with ChatGPT), "litellm" (vouchers: our LiteLLM gateway),
     * any pi built-in provider (BYOK), or "custom" (any OpenAI-compatible endpoint).
     */
    provider: z.string().min(1),
    id: z.string().min(1),
    /**
     * Required for "custom" and "litellm". For built-in providers it overrides the endpoint
     * (dev/e2e: point a provider at the mock LLM).
     */
    baseUrl: z.string().url().optional(),
    /** Only for "custom" (default "openai-completions"). */
    api: CustomApi.optional(),
    /**
     * Cap output tokens (important for credit-capped voucher keys). For "custom", the model's
     * output limit (default CUSTOM_MODEL_DEFAULTS).
     */
    maxTokens: z.number().int().positive().optional(),
    /** "custom" only: whether the model accepts images (screenshots). Default false. */
    supportsImages: z.boolean().optional(),
    /** "custom" only: context window in tokens. Default CUSTOM_MODEL_DEFAULTS. */
    contextWindow: z.number().int().positive().optional(),
    /** "custom" only: whether the model reasons (thinking). Default false. */
    reasoning: z.boolean().optional(),
    /** Reasoning effort; clamped to the model. Default DEFAULT_THINKING_LEVEL ("medium"). */
    thinkingLevel: ThinkingLevel.optional(),
  }),
  research: z
    .object({
      /**
       * Our key server. With the "litellm" (voucher) provider, web research goes to
       * POST {keyServerUrl}/v1/research with the voucher key (Parallel, charged to the voucher).
       */
      keyServerUrl: z.string().url().optional(),
      /**
       * BYOK and custom endpoints: web research on Exa's keyless tier (exa_search, exa_fetch,
       * D23) instead of `web_research`. The user's optional key comes from the app at call time
       * (bridge `agent.exaKey`), never through this config.
       */
      exa: z.boolean().optional(),
      /** Exa API base URL override (tests). Default https://api.exa.ai. */
      exaBaseUrl: z.string().url().optional(),
      /** BOE open-data API base URL override (tests). */
      boeBaseUrl: z.string().url().optional(),
      /** Dev/e2e only: let fetch_url reach localhost / private networks (mock sede). */
      allowPrivateHosts: z.boolean().optional(),
    })
    .default({}),
  /**
   * Community learnings, set when the app has a feedback server. The agent then has
   * feedback_search, plus feedback_submit when `submit` is on (feature flag) and feedback_vote
   * when `vote` is on. Calls go through the app (bridge `feedback.*`).
   */
  feedback: z.object({ submit: z.boolean(), vote: z.boolean() }).optional(),
  /**
   * The DNIe through the phone app (`dnie-phone` feature flag): the system prompt and
   * browser_use_certificate offer it. Off by default.
   */
  dniePhone: z.boolean().default(false),
  /** Dev/e2e only: extra hosts allowed for credentials (same as the app's SA_EXTRA_TRUSTED_HOSTS). */
  extraTrustedHosts: z.array(z.string()).optional(),
  /**
   * Compaction while the agent is idle, just before the prompt cache expires, for contexts of at
   * least `minTokens` (default IDLE_COMPACTION_MIN_TOKENS). `cacheTtlMs` overrides the cache
   * lifetime (tests).
   */
  idleCompaction: z
    .object({
      minTokens: z.number().int().nonnegative().optional(),
      cacheTtlMs: z.number().int().positive().optional(),
    })
    .optional(),
  /** IANA time zone used for "today" in the system prompt. Default Europe/Madrid. */
  timeZone: z.string().optional(),
});

export type AgentHostConfig = z.input<typeof AgentHostConfigSchema>;
export type ResolvedHostConfig = z.output<typeof AgentHostConfigSchema>;

export function parseHostConfig(input: unknown): ResolvedHostConfig {
  const value = typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
  const result = AgentHostConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid agent host config: ${z.prettifyError(result.error)}`);
  }
  const config = result.data;
  const { provider, baseUrl } = config.model;
  if ((provider === 'custom' || provider === 'litellm') && !baseUrl) {
    throw new Error(
      `Invalid agent host config: model.baseUrl is required for provider "${provider}"`,
    );
  }
  return config;
}
