import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VOTE_POLICY, type VotePolicy } from './feedback/votes';

/** Absolute path of services/feedback-server (relative dev paths resolve against it). */
export const SERVICE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Dev default: embedded Postgres (PGlite) in services/feedback-server/.data (gitignored). */
export const DEFAULT_DATABASE_URL = 'pglite://.data/feedback-server';

/**
 * Normalizes a database URL: `postgres://…` is returned as is; `pglite://memory` stays
 * in-memory; `pglite://<dir>` gets an absolute directory (relative dirs resolve against the
 * service directory, so `pnpm --filter` and `cd services/feedback-server` agree).
 */
export function resolveDatabaseUrl(url: string | undefined = process.env.DATABASE_URL): string {
  const value = url?.trim() || DEFAULT_DATABASE_URL;
  if (!value.startsWith('pglite://')) return value;
  const target = value.slice('pglite://'.length);
  if (target === '' || target === 'memory') return 'pglite://memory';
  return `pglite://${isAbsolute(target) ? target : resolve(SERVICE_DIR, target)}`;
}

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  /** Bearer token for /admin/*; admin routes are disabled when unset. */
  adminToken?: string;
  /** Insert example learnings (tagged "seed") when the feedback table is empty. */
  devSeed: boolean;
  /** Take the client IP from X-Forwarded-For (only behind a trusted reverse proxy). */
  trustProxy: boolean;
  /**
   * Who may share and vote. `litellmUrl` checks the gateway keys that submissions and votes carry
   * (`GET /key/info` with the user's own key); `idSecret` turns a key into the user's id (votes).
   * Unset (no LITELLM_URL): only search works.
   */
  users?: { litellmUrl: string; idSecret: string };
  /** Feedback submissions per IP per hour, before any key check. */
  submitPerHour: number;
  /** Search requests per IP per minute. */
  searchPerMinute: number;
  /** Votes per IP per hour, before any key check. */
  votePerHour: number;
  /** Feedback submissions per user per UTC day. */
  submitPerKeyPerDay: number;
  /** Votes per user per UTC day. */
  votePerKeyPerDay: number;
  /** Expose the read-only MCP endpoint at /mcp. */
  mcp: boolean;
  /** How votes change how often an entry is served. */
  votes: VotePolicy;
}

const flag = (v: string | undefined, dflt: boolean) =>
  v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const int = (v: string | undefined, dflt: number) => {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

/** Used only with PGlite when USER_ID_SECRET is unset (public: development data only). */
export const DEV_USER_ID_SECRET = 'sa-dev-user-id-secret-NOT-SECRET-0123';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = resolveDatabaseUrl(env.DATABASE_URL);
  const litellmUrl = env.LITELLM_URL?.trim().replace(/\/+$/, '') || undefined;
  if (litellmUrl && !/^https?:\/\//.test(litellmUrl))
    throw new Error('LITELLM_URL must be an http(s) URL');
  let idSecret = env.USER_ID_SECRET?.trim() || undefined;
  if (litellmUrl && !idSecret) {
    // Never change it once votes exist: every user would get one more vote per entry.
    if (!databaseUrl.startsWith('pglite://'))
      throw new Error('USER_ID_SECRET is required with LITELLM_URL.');
    idSecret = DEV_USER_ID_SECRET;
  }
  if (idSecret && idSecret.length < 32)
    throw new Error('USER_ID_SECRET must be at least 32 characters.');
  return {
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 8788),
    databaseUrl,
    adminToken: env.ADMIN_TOKEN || undefined,
    devSeed: flag(env.DEV_SEED, false),
    trustProxy: flag(env.TRUST_PROXY, false),
    ...(litellmUrl && idSecret ? { users: { litellmUrl, idSecret } } : {}),
    submitPerHour: int(env.RATE_LIMIT_SUBMIT_PER_HOUR, 60),
    searchPerMinute: int(env.RATE_LIMIT_SEARCH_PER_MINUTE, 60),
    votePerHour: int(env.RATE_LIMIT_VOTE_PER_HOUR, 300),
    submitPerKeyPerDay: int(env.SUBMIT_DAILY_LIMIT, 30),
    votePerKeyPerDay: int(env.VOTE_DAILY_LIMIT, 200),
    mcp: flag(env.MCP_ENABLED, true),
    votes: votePolicy(env),
  };
}

function votePolicy(env: NodeJS.ProcessEnv): VotePolicy {
  const policy: VotePolicy = {
    threshold: int(env.VOTE_THRESHOLD, DEFAULT_VOTE_POLICY.threshold),
    decayStartDays: int(env.VOTE_DECAY_START_DAYS, DEFAULT_VOTE_POLICY.decayStartDays),
    decayEndDays: int(env.VOTE_DECAY_END_DAYS, DEFAULT_VOTE_POLICY.decayEndDays),
  };
  if (policy.threshold < 1) throw new Error('VOTE_THRESHOLD must be at least 1.');
  if (policy.decayEndDays <= policy.decayStartDays)
    throw new Error('VOTE_DECAY_END_DAYS must be greater than VOTE_DECAY_START_DAYS.');
  return policy;
}
