import { generateKeyPairSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createLocalJWKSet, type JSONWebKeySet, SignJWT } from 'jose';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { sha256Hex } from '../src/crypto';
import { migrate } from '../src/db/migrate';
import { wrapPglite } from '../src/db/pglite';
import type { Db } from '../src/db/types';
import { createChatGPTVerifier, type IdentityVerifier } from '../src/identity';
import { createLogger } from '../src/logger';
import {
  type FetchLike,
  type KeyProvisioner,
  LiteLLMProvisioner,
  type LiteLLMProvisionerOptions,
  MockProvisioner,
} from '../src/providers/key-provisioner';
import type { ResearchUpstream } from '../src/research/parallel';
import {
  DEFAULT_RESEARCH_SETTINGS,
  ResearchService,
  type ResearchSettings,
} from '../src/research/service';

export const TEST_PEPPER = 'test-pepper-0123456789abcdef';
export const ADMIN_TOKEN = 'admin-token-0123456789abcdef';
const DEFAULT_IP = '203.0.113.10';
export const DECIDER_MODEL = '~perplexity/pplx-decider-flash-latest';
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7);

// A promise, so a test that times out while the template boots can't leave the next test an
// unmigrated template.
let template: Promise<PGlite> | undefined;

async function createTemplate(): Promise<PGlite> {
  const db = await PGlite.create();
  await migrate(wrapPglite(db));
  return db;
}

/** Fresh, migrated in-memory database (a clone of a per-file template: ~150 ms). */
export async function freshDb(): Promise<Db> {
  template ??= createTemplate();
  return wrapPglite(await (await template).clone());
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    voucherPepper: TEST_PEPPER,
    adminToken: ADMIN_TOKEN,
    trustProxyHops: 0,
    rateLimit: false,
    devSeed: false,
    keyTtlDays: 180,
    searchTools: [],
    deciderModel: DECIDER_MODEL,
    chatgptKeys: {
      enabled: true,
      dailyBudgetUsd: 0.1,
      monthlyBudgetUsd: 0.5,
      globalMonthlyBudgetUsd: null,
      encryptionKey: TEST_ENCRYPTION_KEY,
    },
    ...overrides,
  };
}

interface RequestOptions {
  body?: unknown;
  /** Bearer token. */
  token?: string;
  /** Simulated socket address of the client. */
  ip?: string;
  headers?: Record<string, string>;
}

export interface Harness {
  db: Db;
  config: AppConfig;
  provisioner: KeyProvisioner;
  research?: ResearchService;
  /** Every log line written by the app. */
  logs: string[];
  request(method: string, path: string, options?: RequestOptions): Promise<Response>;
  /** Creates vouchers through the admin API and returns their codes. */
  createVouchers(input?: Record<string, unknown>): Promise<string[]>;
  redeem(code: string, options?: RequestOptions): Promise<Response>;
  close(): Promise<void>;
}

export async function setup(
  options: {
    config?: Partial<AppConfig>;
    provisioner?: KeyProvisioner;
    /** Default: a verifier trusting the fake OpenAI keys of this file; null = none. */
    identity?: IdentityVerifier | null;
    db?: Db;
    now?: () => number;
    /** Enables web research with this upstream (no real sleeping between polls). */
    research?: {
      upstream: ResearchUpstream;
      settings?: Partial<ResearchSettings>;
      now?: () => number;
    };
  } = {},
): Promise<Harness> {
  const db = options.db ?? (await freshDb());
  const config = testConfig(options.config);
  const provisioner = options.provisioner ?? new MockProvisioner();
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', write: (line) => logs.push(line) });
  const research = options.research
    ? new ResearchService({
        db,
        provisioner,
        upstream: options.research.upstream,
        // Fixed processors and prices, so the tests' budget arithmetic doesn't follow the default.
        settings: {
          ...DEFAULT_RESEARCH_SETTINGS,
          modes: {
            fast: { processor: 'base', priceUsd: 0.01 },
            balanced: { processor: 'core2x', priceUsd: 0.05 },
            deep: { processor: 'pro', priceUsd: 0.1 },
          },
          ...options.research.settings,
        },
        logger,
        now: options.research.now,
        sleep: async () => {},
      })
    : undefined;
  const app = createApp({
    db,
    config,
    provisioner,
    ...(options.identity === null ? {} : { identity: options.identity ?? testIdentity() }),
    logger,
    now: options.now,
    research,
  });

  const request = (method: string, path: string, opts: RequestOptions = {}) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const body =
      opts.body === undefined
        ? undefined
        : typeof opts.body === 'string'
          ? opts.body
          : JSON.stringify(opts.body);
    // Same shape @hono/node-server passes as c.env.
    const env = { incoming: { socket: { remoteAddress: opts.ip ?? DEFAULT_IP } } };
    return Promise.resolve(app.request(path, { method, headers, body }, env));
  };

  return {
    db,
    config,
    provisioner,
    research,
    logs,
    request,
    async createVouchers(input = {}) {
      const res = await request('POST', '/admin/vouchers', {
        token: ADMIN_TOKEN,
        body: { count: 1, amountUsd: 5, ...input },
      });
      if (res.status !== 201) throw new Error(`createVouchers: ${res.status} ${await res.text()}`);
      return ((await res.json()) as { codes: string[] }).codes;
    },
    redeem(code, opts = {}) {
      return request('POST', '/v1/vouchers/redeem', { ...opts, body: { code } });
    },
    close: () => db.close(),
  };
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** Records outgoing requests and answers them with `handler` (no network access). */
export function fakeFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const MASTER_KEY = 'sk-master-test-0123456789';

/** A LiteLLM token id: the SHA-256 of the key, as LiteLLM computes it. */
export const tokenId = (n: number) => n.toString(16).padStart(64, 'a');

/** State of a key in the fake LiteLLM. */
export interface FakeKey {
  max_budget: number;
  spend: number;
  blocked: boolean;
  /** ISO 8601; null = never expires. */
  expires: string | null;
  /** The `models` of `/key/generate`, replaced by `/key/update {key, models}`. */
  models: string[];
}

/** LiteLLM's `duration` ("15552000s"; the key server always sends seconds) → ISO expiry. */
const expiryOf = (duration: string | null | undefined) =>
  duration ? new Date(Date.now() + Number.parseInt(duration, 10) * 1000).toISOString() : null;

/**
 * Fake LiteLLM admin API: `/key/generate` answers like v1.104 (plaintext key once, hashed token
 * in `token` and `token_id`), `/key/block` answers 200 (or what `block` returns), and
 * `/key/info?key=<hash>` / `/key/update {key, max_budget?, duration?, models?}` read and move the
 * budget, expiry and models in `keys`.
 */
export function fakeLiteLLM(
  options: {
    generate?: (call: FetchCall, n: number) => Response | undefined;
    block?: (call: FetchCall) => Response | undefined;
    team?: (call: FetchCall) => Response | undefined;
    update?: (call: FetchCall) => Response | undefined;
    /** Token ids are the real SHA-256 of the key (as LiteLLM does), not `tokenId(n)`. */
    realHashes?: boolean;
  } = {},
) {
  let n = 0;
  const keys = new Map<string, FakeKey>();
  const fake = fakeFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname === '/key/info' && call.method === 'GET') {
      const id = url.searchParams.get('key') ?? '';
      const key = keys.get(id);
      if (!key) return jsonResponse({ error: { message: 'Key not found in database' } }, 404);
      return jsonResponse({
        key: id,
        info: { ...key, status: key.blocked ? 'revoked' : 'active' },
      });
    }
    if (url.pathname === '/key/update') {
      const custom = options.update?.(call);
      if (custom) return custom;
      const body = call.body as {
        key: string;
        max_budget?: number;
        duration?: string | null;
        models?: string[];
      };
      const key = keys.get(body.key);
      if (!key) return jsonResponse({ error: { message: 'not found' } }, 404);
      if (body.max_budget !== undefined) key.max_budget = body.max_budget;
      if (body.duration !== undefined) key.expires = expiryOf(body.duration);
      if (body.models) key.models = body.models;
      return jsonResponse({ key: body.key, max_budget: key.max_budget });
    }
    if (call.url.endsWith('/key/generate')) {
      n++;
      const custom = options.generate?.(call, n);
      if (custom) return custom;
      const body = call.body as { duration?: string; max_budget: number; models: string[] };
      const expires = expiryOf(body.duration);
      const key = `sk-litellm-key-${n}`;
      const id = options.realHashes ? sha256Hex(key) : tokenId(n);
      keys.set(id, {
        max_budget: body.max_budget,
        spend: 0,
        blocked: false,
        expires,
        models: body.models,
      });
      return jsonResponse({
        key,
        key_name: `sk-...${n}`,
        token: id,
        token_id: id,
        max_budget: body.max_budget,
        expires,
      });
    }
    if (call.url.endsWith('/key/block')) {
      const custom = options.block?.(call);
      if (custom) return custom;
      const id = (call.body as { key: string }).key;
      const key = keys.get(id);
      if (key) key.blocked = true;
      return jsonResponse({ token: id });
    }
    if (call.url.endsWith('/team/new')) {
      return options.team?.(call) ?? jsonResponse({ team_id: 'team-1', ...(call.body as object) });
    }
    if (call.url.endsWith('/team/update')) {
      return options.team?.(call) ?? jsonResponse({ data: call.body });
    }
    return jsonResponse({ error: { message: 'not found' } }, 404);
  });
  return { ...fake, keys };
}

// --- fake OpenAI ID tokens -------------------------------------------------------------------

const OPENAI_ISSUER = 'https://auth.openai.com';
const AUDIENCE_PREFIX = 'oaiapp_';

const openaiKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const foreignKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const openaiJwks = {
  keys: [{ ...openaiKeys.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256' }],
} as JSONWebKeySet;

/** A verifier trusting only the fake OpenAI key above (no network). */
export function testIdentity(): IdentityVerifier {
  return createChatGPTVerifier({
    issuer: OPENAI_ISSUER,
    keys: createLocalJWKSet(openaiJwks),
    audiencePrefix: AUDIENCE_PREFIX,
  });
}

/** An OpenAI-like ID token from "Sign in with ChatGPT", signed by the fake OpenAI key. */
export async function idToken(
  options: {
    sub?: string;
    aud?: string | string[];
    iss?: string;
    /** Seconds from now. */
    expiresIn?: number;
    /** Seconds ago. */
    issuedAgo?: number;
    email?: string;
    /** Sign with a key OpenAI never published. */
    foreignKey?: boolean;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: options.email ?? 'ana@example.org', nonce: 'n' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(options.iss ?? OPENAI_ISSUER)
    .setSubject(options.sub ?? 'auth0|user-1')
    .setAudience(options.aud ?? 'oaiapp_install-1')
    .setIssuedAt(now - (options.issuedAgo ?? 0))
    .setExpirationTime(now + (options.expiresIn ?? 3600))
    .sign(options.foreignKey ? foreignKeys.privateKey : openaiKeys.privateKey);
}

export function litellmProvisioner(
  fetch: FetchLike,
  options: Partial<LiteLLMProvisionerOptions> = {},
): LiteLLMProvisioner {
  return new LiteLLMProvisioner({
    adminUrl: 'http://litellm:4000',
    masterKey: MASTER_KEY,
    publicUrl: 'https://llm.example.org',
    deciderModel: DECIDER_MODEL,
    fetch,
    ...options,
  });
}

export async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? `<no error code, status ${res.status}>`;
}
