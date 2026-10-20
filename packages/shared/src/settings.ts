import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Inference providers
// ---------------------------------------------------------------------------------------------

export const ProviderKind = z.enum([
  'chatgpt', // "Sign in with ChatGPT" (Plus/Pro subscription, via pi's openai-codex OAuth)
  'voucher', // capped LiteLLM key (our gateway) issued by our key server for a voucher code
  'byok', // bring your own key, any provider supported by pi (advanced)
  'custom', // any OpenAI-compatible endpoint, e.g. a local model (advanced; also used by e2e tests)
  'codex', // DEVELOPMENT BUILDS ONLY: legacy Codex device-code login (pi's openai-codex provider)
]);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const CustomApi = z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']);
export type CustomApi = z.infer<typeof CustomApi>;

/** Thinking (reasoning effort) levels understood by pi; clamped to what the model supports. */
export const ThinkingLevel = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
export type ThinkingLevel = z.infer<typeof ThinkingLevel>;

/** The level an agent runs at when its config sets none. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

/**
 * What a custom endpoint's model can do. pi has no catalog entry for these models, so the user
 * says (the app prefills what the server reports). Each field is optional: missing means the
 * safe default in CUSTOM_MODEL_DEFAULTS.
 */
export const CustomModelCapabilities = z.object({
  /** Accepts images: screenshots of web pages and photos of documents. */
  supportsImages: z.boolean().optional(),
  /** Reasons before answering (thinking): the agent then runs at its normal thinking level. */
  reasoning: z.boolean().optional(),
  /** Context window in tokens (what the server serves, e.g. Ollama's num_ctx). */
  contextWindow: z.number().int().min(1024).max(100_000_000).optional(),
  /** Most output tokens per answer. */
  maxTokens: z.number().int().min(256).max(10_000_000).optional(),
});
export type CustomModelCapabilities = z.infer<typeof CustomModelCapabilities>;

/** Capabilities assumed when neither the user nor the server says. */
export const CUSTOM_MODEL_DEFAULTS: Required<CustomModelCapabilities> = {
  supportsImages: false,
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 16_384,
};

/**
 * Non-secret provider configuration persisted in settings. Secrets live in the vault.
 * Only `byok` and `custom` store a model: ChatGPT, voucher and Codex use the model this app
 * version ships with (resolved when an agent starts), so an update changes it for every install.
 */
export const ProviderConfig = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chatgpt') }),
  z.object({
    kind: z.literal('voucher'),
    /** Vault secret id holding the LiteLLM key. */
    secretId: z.string(),
    limitUsd: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal('byok'),
    /** pi provider id, e.g. "anthropic", "openai", "google", "openrouter". */
    provider: z.string(),
    model: z.string(),
    secretId: z.string(),
  }),
  z.object({
    kind: z.literal('custom'),
    baseUrl: z.string().url(),
    api: CustomApi,
    model: z.string(),
    secretId: z.string().optional(),
    ...CustomModelCapabilities.shape,
  }),
  /** Development builds only; the credential lives in the vault. */
  z.object({ kind: z.literal('codex') }),
]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const ProviderStatus = z.object({
  configured: z.boolean(),
  kind: ProviderKind.optional(),
  /** Human label, e.g. "ChatGPT", "Bono Spain Assist", "Anthropic (clave propia)". */
  label: z.string().optional(),
  model: z.string().optional(),
  /** Account hint, e.g. ChatGPT email or plan, when known. */
  account: z.string().optional(),
  credit: z
    .object({
      usageUsd: z.number(),
      limitUsd: z.number().nullable(),
      remainingUsd: z.number().nullable(),
    })
    .optional(),
  /** ISO 8601, when the voucher key expires (voucher only, when known). */
  expiresAt: z.string().optional(),
  /**
   * BYOK and custom endpoints only: whether the user's optional Exa API key, which raises their
   * web research's limits, is saved. The key itself never leaves the main process except to Exa.
   */
  exaKey: z.boolean().optional(),
  error: z.string().optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export const ByokInput = z.object({
  provider: z.string().min(1),
  apiKey: z.string().min(1),
  model: z.string().min(1),
});
export type ByokInput = z.infer<typeof ByokInput>;

export const CustomProviderInput = z.object({
  baseUrl: z.string().url(),
  api: CustomApi,
  model: z.string().min(1),
  apiKey: z.string().optional(),
  ...CustomModelCapabilities.shape,
});
export type CustomProviderInput = z.infer<typeof CustomProviderInput>;

/** The user's own Exa API key (web research for BYOK and custom endpoints). */
export const ExaApiKey = z.string().trim().min(1).max(200);

/** What to ask a custom endpoint about, before it is saved. `model` may still be empty. */
export const CustomProbeInput = z.object({
  baseUrl: z.string().url(),
  api: CustomApi,
  model: z.string().max(200),
  apiKey: z.string().optional(),
});
export type CustomProbeInput = z.infer<typeof CustomProbeInput>;

/** Server software a probe recognized from its native API. */
export const CustomServer = z.enum(['ollama', 'lmstudio', 'llamacpp', 'openai']);
export type CustomServer = z.infer<typeof CustomServer>;

/** What a custom endpoint said about itself (best effort: everything may be missing). */
export const CustomProbeResult = z.object({
  /** Whether any probe got a valid answer. */
  reachable: z.boolean(),
  /** Which server answered, when its native API did ("openai": only `GET /models`). */
  server: CustomServer.optional(),
  /** Model ids the server lists. */
  models: z.array(z.string()),
  /** What the server reported about the model; missing fields were not detected. */
  detected: CustomModelCapabilities,
});
export type CustomProbeResult = z.infer<typeof CustomProbeResult>;

/** For BYOK pickers. Built from pi-ai's model registry. */
export const ModelOption = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().optional(),
  supportsImages: z.boolean().optional(),
  reasoning: z.boolean().optional(),
});
export type ModelOption = z.infer<typeof ModelOption>;

export const ProviderOption = z.object({
  id: z.string(),
  name: z.string(),
  /** Env var pi reads the key from, e.g. "ANTHROPIC_API_KEY". */
  envVar: z.string().optional(),
  models: z.array(ModelOption),
});
export type ProviderOption = z.infer<typeof ProviderOption>;

// ---------------------------------------------------------------------------------------------
// App settings
// ---------------------------------------------------------------------------------------------

export const Language = z.enum(['es', 'en']);
export type Language = z.infer<typeof Language>;

export const Settings = z.object({
  language: Language,
  onboardingCompleted: z.boolean(),
  /** Give and receive anonymous community learnings; allow scrubbed error reports when flagged on. */
  shareLearnings: z.boolean(),
  provider: ProviderConfig.optional(),
});
export type Settings = z.infer<typeof Settings>;

export const SettingsPatch = z.object({
  language: Language.optional(),
  onboardingCompleted: z.boolean().optional(),
  shareLearnings: z.boolean().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/**
 * Backend URLs, built into the app: they are not settings. Packaged builds always use these;
 * development builds accept SA_KEY_SERVER_URL / SA_FEEDBACK_SERVER_URL / SA_MAPS_SERVER_URL /
 * SA_RELAY_SERVER_URL / SA_ERROR_REPORTS_DSN (e2e tests, `corepack pnpm dev:local`). Released versions before the move to spainassist.es call
 * `<name>.2-31-6-160.sslip.io`, which the server keeps serving (infra/terraform/hetzner.tf).
 */
export const PRODUCTION_SERVICES = {
  keyServerUrl: 'https://keys.spainassist.es',
  feedbackServerUrl: 'https://feedback.spainassist.es',
  /** Address lookups for maps (services/maps-server; Mapbox behind it). */
  mapsServerUrl: 'https://maps.spainassist.es',
  /** Desktop ↔ phone relay for DNIe signatures (services/relay-server). */
  relayServerUrl: 'https://relay.spainassist.es',
  /** Unleash, for feature flags (infra/terraform/unleash.tf). */
  flagsUrl: 'https://flags.spainassist.es',
  /**
   * Where packaged builds send error reports: the `desktop` project of our GlitchTip, which
   * speaks Sentry's protocol (infra/terraform/glitchtip.tf). Public by design: a DSN can
   * only send events.
   */
  errorReportsDsn: 'https://55d88ac9618e485a917b33ddb359ec0b@errors.spainassist.es/1',
  /**
   * Unleash frontend tokens (`./tf.sh output -json unleash_frontend_tokens`), one per Unleash
   * environment: packaged builds read `production`, development builds `development`. Public by
   * design: they only read which flags are on in their environment.
   */
  flagsTokens: {
    production: 'default:production.7324e5cb7e9faf722d7d9243dba61ce2163acb4112f772704678278f',
    development: 'default:development.c4917d0064ebc24a3c9bd2181d39bb49847defb099a4546fd348833a',
  },
} as const;

/** Feature flags, read from Unleash when the app starts. Off when Unleash can't be reached. */
export interface FeatureFlags {
  /**
   * The DNIe through the phone app: signatures and logins, the "DNIe con el móvil"
   * card and pairing in Mis datos, the relay connection. Off, the app behaves as if it didn't
   * exist; a saved `dnie` credential stays in the vault, hidden.
   */
  dniePhone: boolean;
  /**
   * This version may no longer be used: the app shows only the must-update screen. Unleash
   * targets it with a constraint on the `appVersion` context field (e.g. SEMVER_LT 0.3.0), which
   * the app sends; without a constraint the flag would block every version, the newest included.
   */
  mustUpdate: boolean;
  /**
   * Error reports to GlitchTip, a kill switch: off, nothing is sent even when anonymous
   * data sharing is on.
   */
  errorReports: boolean;
}

/** Unleash flag name of each feature flag. */
export const FEATURE_FLAG_NAMES: Record<keyof FeatureFlags, string> = {
  dniePhone: 'dnie-phone',
  mustUpdate: 'must-update',
  errorReports: 'error-reports',
};

export const FEATURES_OFF: FeatureFlags = {
  dniePhone: false,
  mustUpdate: false,
  errorReports: false,
};

export const DEFAULT_SETTINGS: Settings = {
  language: 'es',
  onboardingCompleted: false,
  shareLearnings: true,
};
