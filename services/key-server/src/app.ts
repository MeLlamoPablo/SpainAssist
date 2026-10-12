import { randomUUID } from 'node:crypto';
import {
  ChatGPTKeyRequest,
  type ChatGPTKeyResponse,
  RedeemVoucherRequest,
  type RedeemVoucherResponse,
  ResearchRequest,
  type VoucherCreditResponse,
} from '@sa/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ADMIN_PAGE_HEADERS, ADMIN_PAGE_HTML } from './admin-page';
import { clientIp, networkKey } from './client-ip';
import { DEMO_VOUCHER_BODY, normalizeVoucherCode } from './codes';
import type { AppConfig } from './config';
import {
  hashChatGPTAccount,
  hashVoucherCode,
  openSecret,
  safeEqual,
  sealSecret,
  sha256Hex,
} from './crypto';
import type { Db, Queryable } from './db/types';
import { errorBody, errorSummary, HttpError } from './errors';
import { type ChatGPTIdentity, type IdentityVerifier, InvalidIdentityError } from './identity';
import { createLogger, type Logger } from './logger';
import {
  type KeyProvisioner,
  type ProvisionedKey,
  type ProvisionKeyRequest,
  roundUsd,
} from './providers/key-provisioner';
import { type RateLimitSettings, TokenBucketLimiter } from './rate-limit';
import type { ResearchService } from './research/service';
import * as store from './store';
import { SubsidyTeam } from './subsidy-team';
import { createVouchers, ensureDemoVoucher } from './vouchers';

export interface AppDeps {
  db: Db;
  config: AppConfig;
  provisioner: KeyProvisioner;
  /** Checks OpenAI ID tokens (POST /v1/chatgpt-keys); without it that endpoint is disabled. */
  identity?: IdentityVerifier;
  logger?: Logger;
  /** Clock (ms) used by the rate limiters; injectable for tests. */
  now?: () => number;
  /** Web research (POST /v1/research); undefined = 503 research_unavailable. */
  research?: ResearchService;
}

/** Postgres (and PGlite) unique_violation. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === '23505';
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function bearerToken(c: Context): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '');
  return match ? match[1]! : null;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
    .slice(0, 300);
}

const CreateVouchersBody = z.strictObject({
  count: z.number().int().min(1).max(1000),
  amountUsd: z
    .number()
    .min(0.01)
    .max(10_000)
    .transform((v) => Math.round(v * 100) / 100),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  note: z.string().trim().max(500).optional(),
  batch: z.string().trim().min(1).max(100).optional(),
});

const ListVouchersQuery = z.object({
  status: z.enum(store.VOUCHER_STATUS_FILTERS).optional(),
  batch: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Provision = (request: ProvisionKeyRequest) => Promise<ProvisionedKey>;

/** A change of a key's cap upstream, to undo if the transaction that records it fails. */
interface BudgetMove {
  keyId: string;
  keyHash: string;
  /** How much the cap moved (USD; negative = lowered). */
  deltaUsd: number;
  /** Set when the change also moved the key's expiry: the one to restore (null = never). */
  oldExpiry?: Date | null;
}

/**
 * Builds the key-server HTTP app. No I/O happens here besides the injected dependencies, so
 * tests drive it with `app.request()` without opening a port.
 */
export function createApp(deps: AppDeps): Hono {
  const { db, config, provisioner } = deps;
  const log = deps.logger ?? createLogger();
  const app = new Hono();

  const networkOf = (c: Context) => networkKey(clientIp(c, config.trustProxyHops));
  const rateLimited = (name: keyof RateLimitSettings): MiddlewareHandler => {
    if (!config.rateLimit) return async (_c, next) => next();
    const bucket = new TokenBucketLimiter(config.rateLimit[name], deps.now);
    return async (c, next) => {
      const result = bucket.take(networkOf(c));
      if (!result.ok) {
        throw new HttpError(
          429,
          'rate_limited',
          'Too many requests. Wait a moment and try again.',
          {
            'Retry-After': String(result.retryAfterSeconds),
          },
        );
      }
      await next();
    };
  };

  // Request log: method, path, status and timing only. Never bodies, headers or client IPs.
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    if (c.req.path === '/health') return;
    log.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => c.json(errorBody('bad_request', 'Request body too large'), 413),
    }),
  );
  // Responses may carry secrets (keys, codes): never cache them anywhere.
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      for (const [name, value] of Object.entries(err.headers)) c.header(name, value);
      return c.json(errorBody(err.code, err.message), err.status);
    }
    log.error('unhandled error', {
      method: c.req.method,
      path: c.req.path,
      error: errorSummary(err),
    });
    return c.json(errorBody('internal', 'Internal server error'), 500);
  });
  app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));

  app.get('/health', async (c) => {
    try {
      await db.query('SELECT 1');
    } catch {
      return c.json({ ok: false, error: 'database unavailable' }, 503);
    }
    return c.json({ ok: true, service: 'key-server', keys: provisioner.kind });
  });

  /**
   * Runs `work` in one transaction with a `provision` function that creates upstream keys. If
   * anything fails after a key exists (recording it, or the transaction itself), the
   * transaction rolls back and the key is disabled right away: nobody will ever receive it.
   */
  async function withNewKeys<T>(work: (tx: Queryable, provision: Provision) => Promise<T>) {
    const created: ProvisionedKey[] = [];
    const provision: Provision = async (request) => {
      let key: ProvisionedKey;
      try {
        key = await provisioner.create(request);
      } catch (err) {
        log.error('key provisioning failed', { scope: request.scope, error: errorSummary(err) });
        throw new HttpError(
          502,
          'provider_error',
          'Could not create your API key. Try again later.',
        );
      }
      created.push(key);
      return key;
    };
    try {
      return await db.transaction((tx) => work(tx, provision));
    } catch (err) {
      for (const key of created) {
        await provisioner.disable(key.id).catch((disableErr) => {
          log.error('could not disable orphaned key', { error: errorSummary(disableErr) });
        });
      }
      throw err;
    }
  }

  // --- voucher key budgets -----------------------------------------------------------------

  async function readBudget(keyHash: string) {
    try {
      return await provisioner.budget(keyHash);
    } catch (err) {
      log.error('key budget read failed', { error: errorSummary(err) });
      throw new HttpError(502, 'provider_error', 'Could not check your credit. Try again later.');
    }
  }

  async function updateBudget(keyHash: string, maxBudgetUsd: number, expiresAt?: Date | null) {
    try {
      await provisioner.setMaxBudget(keyHash, roundUsd(Math.max(0, maxBudgetUsd)), expiresAt);
    } catch (err) {
      log.error('key budget update failed', { error: errorSummary(err) });
      throw new HttpError(502, 'provider_error', 'Could not update your credit. Try again later.');
    }
  }

  /** Moves the cap back by `deltaUsd` (relative: research may have moved it since). */
  async function undoBudgetMove(t: BudgetMove): Promise<void> {
    await db
      .transaction(async (tx) => {
        await store.lockIssuedKey(tx, t.keyId);
        const budget = await provisioner.budget(t.keyHash);
        if (budget?.maxBudgetUsd == null) return;
        await provisioner.setMaxBudget(
          t.keyHash,
          roundUsd(Math.max(0, budget.maxBudgetUsd - t.deltaUsd)),
          t.oldExpiry,
        );
      })
      .catch((err) => log.error('could not undo a budget change', { error: errorSummary(err) }));
  }

  // --- vouchers ----------------------------------------------------------------------------

  async function redeemFailure(codeHash: string): Promise<HttpError> {
    const state = await store.voucherState(db, codeHash);
    if (!state) return new HttpError(400, 'invalid_code', 'This voucher code is not valid.');
    if (state.status === 'revoked') {
      return new HttpError(410, 'revoked', 'This voucher has been cancelled.');
    }
    if (state.status === 'redeemed') {
      return new HttpError(409, 'already_redeemed', 'This voucher has already been used.');
    }
    if (state.expired) return new HttpError(410, 'expired', 'This voucher has expired.');
    return new HttpError(409, 'already_redeemed', 'This voucher has already been used.');
  }

  app.post('/v1/vouchers/redeem', rateLimited('redeem'), async (c) => {
    const body = RedeemVoucherRequest.safeParse(await readJson(c));
    const normalized = body.success ? normalizeVoucherCode(body.data.code) : null;
    if (!normalized) throw new HttpError(400, 'invalid_code', 'This voucher code is not valid.');
    const codeHash = hashVoucherCode(normalized, config.voucherPepper);
    // The client's current voucher key, if it sent one that is still active: the voucher tops
    // it up. Otherwise (none, unknown, expired, revoked) the voucher gets a new key.
    const token = bearerToken(c);
    const found = token?.startsWith('sk-')
      ? await store.findVoucherKeyByHash(db, sha256Hex(token))
      : null;
    const current = token && found?.provider === provisioner.kind ? { ...found, token } : null;

    let voucherId = '';
    let topUp: BudgetMove | undefined;
    // Claim, provision and record in ONE transaction: if provisioning (or anything after it)
    // fails, the claim rolls back and the voucher stays active.
    const response = await withNewKeys(async (tx, provision) => {
      const voucher = await store.claimVoucher(tx, codeHash);
      if (!voucher) return null;
      voucherId = voucher.id;
      // The voucher's credit lasts until its own deadline; without one, for KEY_TTL_DAYS.
      const expiresAt =
        voucher.expiresAt ??
        (config.keyTtlDays > 0 ? new Date(Date.now() + config.keyTtlDays * 86_400_000) : undefined);

      if (current) {
        // The expiry read under the lock: a concurrent top-up may have moved it since `current`.
        const locked = await store.lockIssuedKey(tx, current.id);
        const budget = await readBudget(current.keyHash);
        if (locked && budget?.active && budget.maxBudgetUsd !== null) {
          const maxBudgetUsd = roundUsd(budget.maxBudgetUsd + voucher.amountUsd);
          // One key, one deadline: the later one, so neither voucher's credit expires early.
          const oldExpiry = locked.expiresAt ? new Date(locked.expiresAt) : null;
          const newExpiry =
            oldExpiry && expiresAt
              ? new Date(Math.max(oldExpiry.getTime(), expiresAt.getTime()))
              : null;
          const extended = newExpiry?.getTime() !== oldExpiry?.getTime();
          await updateBudget(current.keyHash, maxBudgetUsd, extended ? newExpiry : undefined);
          topUp = {
            keyId: current.id,
            keyHash: current.keyHash,
            deltaUsd: voucher.amountUsd,
            ...(extended ? { oldExpiry } : {}),
          };
          await store.topUpIssuedKey(tx, {
            issuedKeyId: current.id,
            voucherId: voucher.id,
            amountUsd: voucher.amountUsd,
            expiresAt: newExpiry?.toISOString() ?? null,
          });
          // Research lowered the cap instead of adding spend: it counts as used.
          const remainingUsd = Math.max(0, budget.maxBudgetUsd - budget.spendUsd);
          return {
            provider: 'litellm',
            baseUrl: provisioner.baseUrl,
            apiKey: current.token,
            limitUsd: roundUsd(locked.limitUsd + voucher.amountUsd),
            usageUsd: roundUsd(Math.max(0, locked.limitUsd - remainingUsd)),
            addedUsd: voucher.amountUsd,
            searchTools: config.searchTools,
            ...(newExpiry ? { expiresAt: newExpiry.toISOString() } : {}),
          } satisfies RedeemVoucherResponse;
        }
      }

      // The voucher id (never the code): LiteLLM requires unique aliases.
      const label = `sa-voucher-${voucher.id}`;
      const key = await provision({
        alias: label,
        scope: 'inference',
        limitUsd: voucher.amountUsd,
        ...(expiresAt ? { expiresAt } : {}),
        metadata: { sa_kind: 'voucher', sa_voucher_id: voucher.id },
      });
      await store.insertIssuedKey(tx, {
        kind: 'voucher',
        voucherId: voucher.id,
        provider: provisioner.kind,
        keyHash: key.id,
        label,
        limitUsd: voucher.amountUsd,
        expiresAt: key.expiresAt,
      });
      return {
        provider: 'litellm',
        baseUrl: key.baseUrl,
        apiKey: key.key,
        limitUsd: voucher.amountUsd,
        usageUsd: 0,
        addedUsd: voucher.amountUsd,
        searchTools: config.searchTools,
        ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
      } satisfies RedeemVoucherResponse;
    }).catch(async (err) => {
      // The key's budget moved upstream but the redemption was not recorded: move it back.
      if (topUp) await undoBudgetMove(topUp);
      throw err;
    });
    if (!response) throw await redeemFailure(codeHash);

    log.info('voucher redeemed', { voucherId, keys: provisioner.kind, topUp: !!topUp });
    if (config.devSeed && normalized === DEMO_VOUCHER_BODY) {
      await ensureDemoVoucher(db, { pepper: config.voucherPepper }).catch((err) =>
        log.warn('could not re-arm demo voucher', { error: errorSummary(err) }),
      );
    }
    return c.json(response);
  });

  app.get('/v1/vouchers/credit', async (c) => {
    const token = bearerToken(c);
    const keyHash = token?.startsWith('sk-') ? sha256Hex(token) : null;
    const key = keyHash ? await store.findVoucherKeyLimit(db, keyHash) : null;
    if (!keyHash || !key || key.provider !== provisioner.kind) {
      throw new HttpError(401, 'unauthorized', 'This is not a voucher key.', {
        'WWW-Authenticate': 'Bearer',
      });
    }
    // A key deleted upstream has nothing left.
    const budget = await readBudget(keyHash);
    return c.json({
      limitUsd: key.limitUsd,
      spendUsd: budget?.spendUsd ?? 0,
      maxBudgetUsd: budget?.maxBudgetUsd ?? 0,
      expiresAt: key.expiresAt,
    } satisfies VoucherCreditResponse);
  });

  // --- ChatGPT scan-decider keys (D12) -----------------------------------------------------

  const { chatgptKeys } = config;
  const subsidyTeam = new SubsidyTeam(db, provisioner, {
    deciderModel: config.deciderModel,
    monthlyBudgetUsd: chatgptKeys.globalMonthlyBudgetUsd,
  });

  /** Decrypts a stored key and builds the response. */
  function storedKeyResponse(row: store.ChatGPTKeyRow, accountHash: string) {
    if (row.disabled) {
      throw new HttpError(403, 'chatgpt_keys_disabled', 'Your document scanning key is blocked.');
    }
    if (row.provider !== provisioner.kind) {
      throw new HttpError(
        503,
        'provider_error',
        'Your document scanning key is not available right now. Try again later.',
      );
    }
    let apiKey: string;
    try {
      apiKey = openSecret(row.keyCiphertext, chatgptKeys.encryptionKey!, accountHash);
    } catch (err) {
      log.error('stored ChatGPT key cannot be decrypted', { error: errorSummary(err) });
      throw new HttpError(500, 'internal', 'Internal server error');
    }
    return chatgptKeyResponse(apiKey);
  }

  const chatgptKeyResponse = (apiKey: string): ChatGPTKeyResponse => ({
    provider: 'litellm',
    baseUrl: provisioner.baseUrl,
    apiKey,
    deciderModel: config.deciderModel,
    dailyLimitUsd: chatgptKeys.dailyBudgetUsd,
    monthlyLimitUsd: chatgptKeys.monthlyBudgetUsd,
  });

  app.post('/v1/chatgpt-keys', rateLimited('chatgptKeys'), async (c) => {
    if (!chatgptKeys.enabled || !chatgptKeys.encryptionKey || !deps.identity) {
      throw new HttpError(
        403,
        'chatgpt_keys_disabled',
        'Document scanning for ChatGPT accounts is not available on this server.',
      );
    }
    const body = ChatGPTKeyRequest.safeParse(await readJson(c));
    if (!body.success) throw new HttpError(400, 'bad_request', 'Expected { idToken }');
    let identity: ChatGPTIdentity;
    try {
      identity = await deps.identity.verify(body.data.idToken);
    } catch (err) {
      if (err instanceof InvalidIdentityError) {
        log.info('ChatGPT ID token rejected', { reason: err.message });
        throw new HttpError(401, 'invalid_identity', 'Sign in with ChatGPT again.');
      }
      log.error('ChatGPT ID token check failed', { error: errorSummary(err) });
      throw new HttpError(503, 'provider_error', 'Could not check your sign-in. Try again later.');
    }
    const accountHash = hashChatGPTAccount(identity.issuer, identity.subject, config.voucherPepper);

    const existing = await store.touchChatGPTKey(db, accountHash);
    if (existing) return c.json(storedKeyResponse(existing, accountHash));

    const teamId = await subsidyTeam.id().catch((err) => {
      log.error('could not prepare the ChatGPT key team', { error: errorSummary(err) });
      throw new HttpError(502, 'provider_error', 'Could not create your key. Try again later.');
    });
    // A random alias: the LiteLLM UI must not reveal (or link) the account.
    const label = `sa-chatgpt-${randomUUID()}`;
    try {
      const apiKey = await withNewKeys(async (tx, provision) => {
        const key = await provision({
          alias: label,
          scope: 'decider',
          budgetWindows: [
            { duration: '1d', maxBudgetUsd: chatgptKeys.dailyBudgetUsd },
            { duration: '1mo', maxBudgetUsd: chatgptKeys.monthlyBudgetUsd },
          ],
          ...(teamId ? { teamId } : {}),
          metadata: { sa_kind: 'chatgpt' },
        });
        await store.insertIssuedKey(tx, {
          kind: 'chatgpt',
          chatgpt: {
            accountHash,
            keyCiphertext: sealSecret(key.key, chatgptKeys.encryptionKey!, accountHash),
          },
          provider: provisioner.kind,
          keyHash: key.id,
          label,
          limitUsd: chatgptKeys.monthlyBudgetUsd,
        });
        return key.key;
      });
      log.info('ChatGPT key issued', { keys: provisioner.kind });
      return c.json(chatgptKeyResponse(apiKey));
    } catch (err) {
      // Another device of the same account won the race: hand out its key (ours is disabled).
      if (isUniqueViolation(err)) {
        const winner = await store.touchChatGPTKey(db, accountHash);
        if (winner) return c.json(storedKeyResponse(winner, accountHash));
      }
      throw err;
    }
  });

  // --- web research -----------------------------------------------------------------------

  const researchService = (): ResearchService => {
    if (!deps.research) {
      throw new HttpError(
        503,
        'research_unavailable',
        'Web research is not available on this server.',
      );
    }
    return deps.research;
  };

  /** Streams a run's events as SSE; the run goes on if the client leaves. */
  const streamRun = (c: Context, research: ResearchService, run: store.ResearchRun) => {
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const left = new AbortController();
      stream.onAbort(() => left.abort());
      for await (const event of research.events(run, left.signal)) {
        if (left.signal.aborted) break;
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }
    });
  };

  app.post('/v1/research', async (c) => {
    const research = researchService();
    const key = await research.authenticate(bearerToken(c));
    const body = ResearchRequest.safeParse(await readJson(c));
    if (!body.success) throw new HttpError(400, 'bad_request', describeIssues(body.error));
    const run = await research.start(key, body.data);
    return streamRun(c, research, run);
  });

  app.get('/v1/research/:id', async (c) => {
    const research = researchService();
    const key = await research.authenticate(bearerToken(c));
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) throw new HttpError(404, 'not_found', 'Research run not found.');
    return c.json(await research.info(await research.find(key, id)));
  });

  app.get('/v1/research/:id/events', async (c) => {
    const research = researchService();
    const key = await research.authenticate(bearerToken(c));
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) throw new HttpError(404, 'not_found', 'Research run not found.');
    return streamRun(c, research, await research.find(key, id));
  });

  // --- admin -------------------------------------------------------------------------------

  // The admin page itself is public (it holds no data and asks for the token), but like the API
  // it only exists when ADMIN_TOKEN is set. Registered before the auth middleware below, which
  // also matches `/admin`.
  app.get('/admin', (c) => {
    if (!config.adminToken) throw new HttpError(404, 'not_found', 'Not found');
    return c.body(ADMIN_PAGE_HTML, 200, ADMIN_PAGE_HEADERS);
  });

  app.use('/admin/*', async (c, next) => {
    if (!config.adminToken) throw new HttpError(404, 'not_found', 'Not found');
    const token = bearerToken(c);
    if (!token || !safeEqual(token, config.adminToken)) {
      throw new HttpError(401, 'unauthorized', 'Invalid admin token.', {
        'WWW-Authenticate': 'Bearer',
      });
    }
    await next();
  });

  app.post('/admin/vouchers', async (c) => {
    const parsed = CreateVouchersBody.safeParse(await readJson(c));
    if (!parsed.success) throw new HttpError(400, 'bad_request', describeIssues(parsed.error));
    const input = parsed.data;
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new HttpError(400, 'bad_request', 'expiresAt must be in the future');
    }
    const { codes, batch } = await createVouchers(db, config.voucherPepper, {
      count: input.count,
      amountUsd: input.amountUsd,
      expiresAt,
      note: input.note,
      batch: input.batch,
    });
    log.info('vouchers created', { count: codes.length, batch });
    return c.json(
      {
        codes,
        batch,
        amountUsd: input.amountUsd,
        ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
      },
      201,
    );
  });

  app.get('/admin/vouchers', async (c) => {
    const parsed = ListVouchersQuery.safeParse(c.req.query());
    if (!parsed.success) throw new HttpError(400, 'bad_request', describeIssues(parsed.error));
    return c.json({ vouchers: await store.listVouchers(db, parsed.data) });
  });

  app.post('/admin/vouchers/:id/revoke', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) throw new HttpError(404, 'not_found', 'Voucher not found');

    // A key that other valid vouchers still fund keeps working: only this voucher's amount is
    // taken off its budget, in the same transaction as the revocation (a failure leaves the
    // voucher as it was, so revoking again retries).
    let lowered: BudgetMove | undefined;
    const voucher = await db
      .transaction(async (tx) => {
        const revoked = await store.revokeVoucher(tx, id);
        if (!revoked?.issuedKeyId || revoked.previousStatus === 'revoked') return revoked;
        await store.lockIssuedKey(tx, revoked.issuedKeyId);
        const key = await store.fundedKey(tx, revoked.issuedKeyId);
        if (!key || key.disabled || !key.funded) return revoked; // blocked below
        if (key.provider === provisioner.kind) {
          const budget = await readBudget(key.keyHash);
          if (budget?.maxBudgetUsd != null) {
            await updateBudget(key.keyHash, budget.maxBudgetUsd - revoked.amountUsd);
            lowered = { keyId: key.id, keyHash: key.keyHash, deltaUsd: -revoked.amountUsd };
          }
        } else if (key.provider !== 'mock') {
          throw new HttpError(
            502,
            'provider_error',
            `Cannot change a ${key.provider} key with the ${provisioner.kind} provider.`,
          );
        }
        await store.lowerIssuedKeyLimit(tx, key.id, revoked.amountUsd);
        return revoked;
      })
      .catch(async (err) => {
        if (lowered) await undoBudgetMove(lowered);
        throw err;
      });
    if (!voucher) throw new HttpError(404, 'not_found', 'Voucher not found');

    // A key no valid voucher funds any more is blocked, outside any transaction. Revoking again
    // retries a block call that failed (disabled_at stays NULL until it succeeds).
    const key = voucher.issuedKeyId ? await store.fundedKey(db, voucher.issuedKeyId) : null;
    const block = key && !key.disabled && !key.funded ? key : null;
    if (block) {
      try {
        if (block.provider === provisioner.kind) {
          await provisioner.disable(block.keyHash);
        } else if (block.provider !== 'mock') {
          // e.g. a LiteLLM key while the server runs without LITELLM_ADMIN_URL.
          throw new Error(
            `cannot disable a ${block.provider} key with the ${provisioner.kind} provider`,
          );
        } // mock keys only work against the local mock LLM: nothing to disable upstream
        await store.markKeyDisabled(db, block.id);
      } catch (err) {
        log.error('could not disable key of revoked voucher', {
          voucherId: id,
          error: errorSummary(err),
        });
        throw new HttpError(
          502,
          'provider_error',
          'Voucher revoked, but its API key could not be disabled. Revoke again to retry.',
        );
      }
    }
    const keysDisabled = block ? 1 : 0;
    log.info('voucher revoked', { voucherId: id, keysDisabled, creditRemoved: !!lowered });
    return c.json({ id, status: 'revoked', keysDisabled });
  });

  return app;
}
