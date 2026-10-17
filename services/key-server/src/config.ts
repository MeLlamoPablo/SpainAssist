import { z } from 'zod';
import { parseEncryptionKey } from './crypto';
import { DEFAULT_DATABASE_URL, isPgliteUrl } from './db/open';
import type { LogLevel } from './logger';
import { MOCK_LLM_BASE_URL } from './providers/key-provisioner';
import { DEFAULT_RATE_LIMITS, type RateLimitSettings } from './rate-limit';
import { PARALLEL_API_URL } from './research/parallel';
import { DEFAULT_RESEARCH_SETTINGS, type ResearchSettings } from './research/service';

/** Settings used by the HTTP app (createApp). */
export interface AppConfig {
  /** Secret for HMAC-ing voucher codes and client networks. Changing it invalidates all codes. */
  voucherPepper: string;
  /** Bearer token for /admin/*; admin endpoints are disabled (404) when unset. */
  adminToken?: string;
  /** Number of trusted reverse proxies in front of the server (0 = ignore X-Forwarded-For). */
  trustProxyHops: number;
  /** Per-IP token buckets, or false to disable rate limiting. */
  rateLimit: RateLimitSettings | false;
  /** Re-arm the public demo voucher after each redemption (dev / e2e with the mock provider). */
  devSeed: boolean;
  /** Lifetime of voucher keys in days (0 = no expiry). */
  keyTtlDays: number;
  /** Search tools issued keys may call (told to clients; empty = every tool on the proxy). */
  searchTools: string[];
  /** OpenRouter id of the document-scan frame decider (the only model of ChatGPT keys). */
  deciderModel: string;
  /** Scan-decider keys for "Sign in with ChatGPT" users (POST /v1/chatgpt-keys, D12). */
  chatgptKeys: {
    /** False when disabled or when no KEY_ENCRYPTION_KEY is available. */
    enabled: boolean;
    /** Per-account caps, enforced by LiteLLM before each call. */
    dailyBudgetUsd: number;
    monthlyBudgetUsd: number;
    /** Cap on all ChatGPT keys together per calendar month (null = none). */
    globalMonthlyBudgetUsd: number | null;
    /** AES-256-GCM key for the stored LiteLLM keys (32 bytes). */
    encryptionKey?: Buffer;
  };
}

/** Full server configuration (app + process-level settings). */
export interface ServerConfig extends AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: LogLevel;
  /** LiteLLM proxy; undefined = mock keys for the local mock LLM. */
  litellm?: {
    adminUrl: string;
    masterKey: string;
    publicUrl: string;
    /** Models voucher keys may call; empty = every model on the proxy. */
    keyModels: string[];
  };
  mockLlmBaseUrl: string;
  /** How OpenAI ID tokens are verified (POST /v1/chatgpt-keys). */
  openaiIdentity: {
    issuer: string;
    jwksUrl: string;
    /** Every `aud` must start with this (per-install "Sign in with ChatGPT" clients). */
    audiencePrefix: string;
  };
  /** Web research (POST /v1/research): each mode's processor and price, fixed by the server. */
  research: ResearchSettings;
  /** Parallel Task API for web research; undefined = POST /v1/research answers 503. */
  parallel?: { apiKey: string; baseUrl: string };
  /** Non-fatal configuration problems to log at startup. */
  warnings: string[];
}

const DEFAULT_DECIDER_MODEL = 'perplexity/pplx-decider-v1.1-27b';
/** Used only with PGlite when VOUCHER_PEPPER is unset; never acceptable with Postgres. */
export const DEV_PEPPER = 'sa-dev-pepper-NOT-SECRET-do-not-use-in-production';
/** Used only with PGlite when KEY_ENCRYPTION_KEY is unset (32 public bytes). */
export const DEV_ENCRYPTION_KEY = Buffer.from('sa-dev-key-NOT-SECRET-0123456789', 'utf8');

const flag = (defaultValue: boolean) =>
  z
    .enum(['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'])
    .default(defaultValue ? '1' : '0')
    .transform((v) => ['1', 'true', 'yes', 'on'].includes(v));

const list = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  DATABASE_URL: z.string().default(DEFAULT_DATABASE_URL),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  VOUCHER_PEPPER: z.string().min(16, 'VOUCHER_PEPPER must be at least 16 characters').optional(),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN must be at least 16 characters').optional(),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  RATE_LIMIT: flag(true),
  DEV_SEED: flag(false),
  KEY_TTL_DAYS: z.coerce.number().int().min(0).max(3650).default(180),
  CHATGPT_KEYS: flag(true),
  CHATGPT_DAILY_BUDGET_USD: z.coerce.number().min(0.01).max(100).default(0.1),
  CHATGPT_MONTHLY_BUDGET_USD: z.coerce.number().min(0.01).max(1000).default(0.5),
  CHATGPT_GLOBAL_MONTHLY_BUDGET_USD: z.coerce.number().min(0.01).max(1_000_000).optional(),
  KEY_ENCRYPTION_KEY: z.string().optional(),
  DECIDER_MODEL: z.string().min(1).default(DEFAULT_DECIDER_MODEL),
  OPENAI_ISSUER: z.url().default('https://auth.openai.com'),
  OPENAI_JWKS_URL: z.url().default('https://auth.openai.com/.well-known/jwks.json'),
  CHATGPT_AUDIENCE_PREFIX: z.string().min(1).default('oaiapp_'),
  LITELLM_ADMIN_URL: z.url().optional(),
  LITELLM_MASTER_KEY: z.string().optional(),
  LITELLM_PUBLIC_URL: z.url().optional(),
  LITELLM_KEY_MODELS: list,
  LITELLM_SEARCH_TOOLS: list,
  MOCK_LLM_BASE_URL: z.url().default(MOCK_LLM_BASE_URL),
  PARALLEL_API_KEY: z.string().optional(),
  PARALLEL_API_URL: z.url().default(PARALLEL_API_URL),
  RESEARCH_MAX_ACTIVE_PER_KEY: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(DEFAULT_RESEARCH_SETTINGS.maxActivePerKey),
  RESEARCH_MAX_MINUTES: z.coerce
    .number()
    .min(1)
    .max(240)
    .default(DEFAULT_RESEARCH_SETTINGS.maxMinutes),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const trimSlashes = (url: string) => url.replace(/\/+$/, '');

/** Parses environment variables. Empty strings count as unset (handy with docker compose). */
export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    // Never echo values: the issues only name the variable and the rule.
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'env'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Invalid configuration: ${details}`);
  }
  const e = parsed.data;
  const warnings: string[] = [];

  let voucherPepper = e.VOUCHER_PEPPER;
  if (!voucherPepper) {
    if (!isPgliteUrl(e.DATABASE_URL)) {
      throw new ConfigError('VOUCHER_PEPPER is required when using Postgres');
    }
    voucherPepper = DEV_PEPPER;
    warnings.push('VOUCHER_PEPPER is not set: using an insecure development pepper');
  }

  let litellm: ServerConfig['litellm'];
  if (e.LITELLM_ADMIN_URL) {
    if (!e.LITELLM_MASTER_KEY) {
      throw new ConfigError('LITELLM_MASTER_KEY is required when LITELLM_ADMIN_URL is set');
    }
    litellm = {
      adminUrl: trimSlashes(e.LITELLM_ADMIN_URL),
      masterKey: e.LITELLM_MASTER_KEY,
      publicUrl: trimSlashes(e.LITELLM_PUBLIC_URL ?? e.LITELLM_ADMIN_URL),
      keyModels: e.LITELLM_KEY_MODELS,
    };
  } else if (e.LITELLM_MASTER_KEY || e.LITELLM_PUBLIC_URL) {
    warnings.push('LITELLM_ADMIN_URL is not set: issuing mock keys, other LITELLM_* ignored');
  }

  let encryptionKey: Buffer | undefined;
  if (e.KEY_ENCRYPTION_KEY) {
    encryptionKey = parseEncryptionKey(e.KEY_ENCRYPTION_KEY);
    if (!encryptionKey) {
      throw new ConfigError('KEY_ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or base64');
    }
  } else if (isPgliteUrl(e.DATABASE_URL)) {
    encryptionKey = DEV_ENCRYPTION_KEY;
    if (e.CHATGPT_KEYS) {
      warnings.push('KEY_ENCRYPTION_KEY is not set: using an insecure development key');
    }
  } else if (e.CHATGPT_KEYS) {
    warnings.push('KEY_ENCRYPTION_KEY is not set: POST /v1/chatgpt-keys is disabled');
  }
  const round = (usd: number) => Math.round(usd * 100) / 100;
  const daily = round(e.CHATGPT_DAILY_BUDGET_USD);
  const monthly = round(e.CHATGPT_MONTHLY_BUDGET_USD);
  if (daily > monthly) {
    warnings.push('CHATGPT_DAILY_BUDGET_USD is above CHATGPT_MONTHLY_BUDGET_USD');
  }

  if (e.PARALLEL_API_KEY && !litellm) {
    warnings.push('Web research runs on mock keys: budgets live in memory only');
  }

  return {
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL,
    voucherPepper,
    adminToken: e.ADMIN_TOKEN,
    trustProxyHops: e.TRUST_PROXY,
    rateLimit: e.RATE_LIMIT ? DEFAULT_RATE_LIMITS : false,
    devSeed: e.DEV_SEED,
    keyTtlDays: e.KEY_TTL_DAYS,
    searchTools: e.LITELLM_SEARCH_TOOLS,
    deciderModel: e.DECIDER_MODEL,
    chatgptKeys: {
      enabled: e.CHATGPT_KEYS && encryptionKey !== undefined,
      dailyBudgetUsd: daily,
      monthlyBudgetUsd: monthly,
      globalMonthlyBudgetUsd:
        e.CHATGPT_GLOBAL_MONTHLY_BUDGET_USD === undefined
          ? null
          : round(e.CHATGPT_GLOBAL_MONTHLY_BUDGET_USD),
      ...(encryptionKey ? { encryptionKey } : {}),
    },
    research: {
      modes: DEFAULT_RESEARCH_SETTINGS.modes,
      maxActivePerKey: e.RESEARCH_MAX_ACTIVE_PER_KEY,
      maxMinutes: e.RESEARCH_MAX_MINUTES,
      pollSeconds: DEFAULT_RESEARCH_SETTINGS.pollSeconds,
    },
    litellm,
    mockLlmBaseUrl: e.MOCK_LLM_BASE_URL,
    openaiIdentity: {
      issuer: trimSlashes(e.OPENAI_ISSUER),
      jwksUrl: e.OPENAI_JWKS_URL,
      audiencePrefix: e.CHATGPT_AUDIENCE_PREFIX,
    },
    ...(e.PARALLEL_API_KEY
      ? { parallel: { apiKey: e.PARALLEL_API_KEY, baseUrl: trimSlashes(e.PARALLEL_API_URL) } }
      : {}),
    warnings,
  };
}
