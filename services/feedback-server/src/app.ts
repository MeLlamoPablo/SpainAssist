import { createHash, timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  bearerKey,
  type KeyChecker,
  KeyCheckUnavailableError,
  KeyQuota,
  userId,
} from '@sa/gateway-keys';
import {
  type ApiError,
  type FeedbackAdminDetail,
  type FeedbackAdminList,
  FeedbackAdminListQuery,
  type FeedbackAdminSearchResponse,
  type FeedbackAdminStats,
  FeedbackEdit,
  type FeedbackEditResponse,
  FeedbackSearchQuery,
  type FeedbackSearchResponse,
  FeedbackSubmission,
  type FeedbackSubmitResponse,
  FeedbackVoteRequest,
  type FeedbackVoteResponse,
} from '@sa/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { routePath } from 'hono/route';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { ADMIN_PAGE_HEADERS, ADMIN_PAGE_HTML } from './admin-page';
import type { Db } from './db/types';
import {
  adminDetail,
  adminEntry,
  adminList,
  adminSearch,
  adminStats,
  deleteVote,
  updateFeedback,
} from './feedback/admin';
import {
  addVote,
  castVote,
  deleteFeedback,
  feedbackExists,
  insertFeedback,
  searchFeedback,
  type VoteContext,
} from './feedback/repo';
import { MAX_PII_SHARE, scrubSubmission } from './feedback/scrub';
import { DEFAULT_VOTE_POLICY, type VotePolicy } from './feedback/votes';
import { clientKey, RateLimiter } from './http/limits';
import { handleMcpRequest } from './mcp';

export interface AppDeps {
  db: Db;
  /**
   * Who may share and vote: the user's LiteLLM gateway key that submissions and votes must carry
   * is checked (as for the maps server), and `userId(key, idSecret)` identifies the user. Without
   * it, submissions and votes answer 503: only search works.
   */
  users?: { checkKey: KeyChecker; idSecret: string };
  /** Bearer token for /admin/*. Admin routes answer 404 when unset. */
  adminToken?: string;
  /** Trust X-Forwarded-For / X-Real-IP (only behind your own reverse proxy). */
  trustProxy?: boolean;
  /** Overrides how the client address is found (tests). Used only for in-memory limits. */
  clientIp?: (c: Context) => string | undefined;
  limits?: {
    /** Submissions per client address per hour, before any key check (default 60; 0 disables). */
    submitPerHour?: number;
    /** Searches per client address per minute (default 60; 0 disables). */
    searchPerMinute?: number;
    /** Votes per client address per hour, before any key check (default 300; 0 disables). */
    votePerHour?: number;
    /** Submissions per user per UTC day (default 30). */
    submitPerKeyPerDay?: number;
    /** Votes per user per UTC day (default 200). */
    votePerKeyPerDay?: number;
  };
  /** How votes change how often an entry is served (default DEFAULT_VOTE_POLICY). */
  votes?: VotePolicy;
  /** Serving draws (tests); returns a number in [0, 1). */
  random?: () => number;
  now?: () => number;
  /** Access log sink: method, route pattern, status and duration only. */
  log?: (line: string) => void;
  /** Expose the read-only MCP endpoint at /mcp (default true). */
  mcp?: boolean;
}

const MAX_BODY_BYTES = 64 * 1024;

export function createApp(deps: AppDeps): Hono {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const submitLimiter = new RateLimiter(deps.limits?.submitPerHour ?? 60, 3_600_000, now);
  const searchLimiter = new RateLimiter(deps.limits?.searchPerMinute ?? 60, 60_000, now);
  const voteLimiter = new RateLimiter(deps.limits?.votePerHour ?? 300, 3_600_000, now);
  const submitQuota = new KeyQuota({ day: deps.limits?.submitPerKeyPerDay ?? 30 }, now);
  const voteQuota = new KeyQuota({ day: deps.limits?.votePerKeyPerDay ?? 200 }, now);
  const policy = deps.votes ?? DEFAULT_VOTE_POLICY;
  const voteContext = (): VoteContext => ({ policy, now: now() });

  const clientAddress = (c: Context): string | undefined => {
    if (deps.clientIp) return deps.clientIp(c);
    if (deps.trustProxy) {
      const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (forwarded) return forwarded;
      const real = c.req.header('x-real-ip')?.trim();
      if (real) return real;
    }
    try {
      return getConnInfo(c).remote.address;
    } catch {
      return undefined; // e.g. app.request() in tests
    }
  };
  const client = (c: Context) => clientKey(clientAddress(c) ?? 'unknown');

  const app = new Hono();

  // Access log without bodies, query strings or client addresses.
  if (deps.log) {
    const log = deps.log;
    app.use(async (c, next) => {
      const start = performance.now();
      await next();
      const route = safeRoutePath(c);
      log(`${c.req.method} ${route} ${c.res.status} ${Math.round(performance.now() - start)}ms`);
    });
  }

  const limited = (limiter: RateLimiter, c: Context) => {
    const retryAfter = limiter.hit(client(c));
    return retryAfter
      ? fail(c, 429, 'rate_limited', 'Too many requests. Try again later.', {
          'Retry-After': String(retryAfter),
        })
      : undefined;
  };

  /**
   * Proves the caller is an app user with an active gateway key that has credit, and takes one
   * from that key's daily quota. Returns the key's hash, or an error response.
   */
  const authorize = async (
    c: Context,
    quota: KeyQuota,
  ): Promise<{ user: string } | { response: Response }> => {
    const { users } = deps;
    if (!users) {
      return { response: fail(c, 503, 'unavailable', 'Sharing is not available on this server.') };
    }
    const key = bearerKey(c.req.header('authorization'));
    if (!key) return { response: fail(c, 401, 'unauthorized', 'A gateway key is required.') };
    let status: Awaited<ReturnType<KeyChecker>>;
    try {
      status = await users.checkKey(key);
    } catch (err) {
      if (err instanceof KeyCheckUnavailableError)
        return { response: fail(c, 503, 'unavailable', 'Try again later.') };
      throw err;
    }
    if (status === 'invalid')
      return { response: fail(c, 401, 'unauthorized', 'The key is not valid.') };
    if (status === 'no_credit')
      return { response: fail(c, 403, 'no_credit', 'The key has no credit left.') };
    const user = userId(key, users.idSecret);
    const wait = quota.take(user);
    if (wait) {
      return {
        response: fail(c, 429, 'quota_exceeded', 'Daily limit reached. Try again tomorrow.', {
          'Retry-After': String(wait),
        }),
      };
    }
    return { user };
  };

  app.get('/health', async (c) => {
    await db.query('SELECT 1');
    return c.json({ status: 'ok' });
  });

  app.post(
    '/v1/feedback',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => fail(c, 413, 'payload_too_large', 'The submission is too large.'),
    }),
    async (c) => {
      const tooMany = limited(submitLimiter, c);
      if (tooMany) return tooMany;
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return fail(c, 400, 'bad_request', 'The body must be JSON.');
      }
      const parsed = FeedbackSubmission.safeParse(body);
      if (!parsed.success) return fail(c, 400, 'bad_request', describe(parsed.error));
      const auth = await authorize(c, submitQuota);
      if ('response' in auth) return auth.response;
      const { feedback, redactions, piiShare } = scrubSubmission(parsed.data);
      if (piiShare > MAX_PII_SHARE) {
        return fail(
          c,
          422,
          'pii_detected',
          'The text is mostly personal data. Describe what you learned about the procedure, not the person.',
        );
      }
      const id = await insertFeedback(db, feedback);
      return c.json({ id, redactions } satisfies FeedbackSubmitResponse, 201);
    },
  );

  app.get('/v1/feedback/search', async (c) => {
    const tooMany = limited(searchLimiter, c);
    if (tooMany) return tooMany;
    const parsed = FeedbackSearchQuery.safeParse(c.req.query());
    if (!parsed.success) return fail(c, 400, 'bad_request', describe(parsed.error));
    const results = await searchFeedback(db, parsed.data, voteContext(), deps.random);
    return c.json({ results } satisfies FeedbackSearchResponse);
  });

  /** Parses a vote body; returns the vote value or an error response. */
  const readVote = async (c: Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, 'bad_request', 'The body must be JSON.');
    }
    const parsed = FeedbackVoteRequest.safeParse(body);
    if (!parsed.success) return fail(c, 400, 'bad_request', describe(parsed.error));
    return parsed.data.vote === 'up' ? 1 : -1;
  };

  // Agent votes: one per user and entry. A different vote replaces the user's earlier one; the
  // same vote again is accepted but not counted.
  app.post('/v1/feedback/:id/vote', bodyLimit({ maxSize: 1024 }), async (c) => {
    const tooMany = limited(voteLimiter, c);
    if (tooMany) return tooMany;
    const value = await readVote(c);
    if (typeof value !== 'number') return value;
    const auth = await authorize(c, voteQuota);
    if ('response' in auth) return auth.response;
    const id = c.req.param('id').toLowerCase();
    if (!(await feedbackExists(db, id))) return fail(c, 404, 'not_found', 'Feedback not found.');
    const counted = await castVote(db, id, value, auth.user);
    return c.json({ id, counted } satisfies FeedbackVoteResponse);
  });

  // --- admin ------------------------------------------------------------------------------------
  // The page itself holds no data and asks for the token, but like the API it only exists when
  // ADMIN_TOKEN is set. Registered before the auth middleware, which would also match `/admin`.
  app.get('/admin', (c) => {
    if (!deps.adminToken) return fail(c, 404, 'not_found', 'Not found.');
    return c.body(ADMIN_PAGE_HTML, 200, ADMIN_PAGE_HEADERS);
  });

  const admin = new Hono();
  admin.use(async (c, next) => {
    if (!deps.adminToken) return fail(c, 404, 'not_found', 'Not found.');
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    if (!token || !sameSecret(token, deps.adminToken)) {
      return fail(c, 401, 'unauthorized', 'Invalid admin token.', { 'WWW-Authenticate': 'Bearer' });
    }
    await next();
    c.header('Cache-Control', 'no-store');
  });
  const notFound = (c: Context) => fail(c, 404, 'not_found', 'Feedback not found.');

  admin.get('/feedback', async (c) => {
    const parsed = FeedbackAdminListQuery.safeParse(c.req.query());
    if (!parsed.success) return fail(c, 400, 'bad_request', describe(parsed.error));
    return c.json((await adminList(db, parsed.data, voteContext())) satisfies FeedbackAdminList);
  });
  admin.get('/feedback/stats', async (c) =>
    c.json((await adminStats(db, voteContext())) satisfies FeedbackAdminStats),
  );
  admin.get('/feedback/search', async (c) => {
    const parsed = FeedbackSearchQuery.safeParse(c.req.query());
    if (!parsed.success) return fail(c, 400, 'bad_request', describe(parsed.error));
    const results = await adminSearch(db, parsed.data, voteContext());
    return c.json({ results } satisfies FeedbackAdminSearchResponse);
  });
  admin.get('/feedback/:id', async (c) => {
    const detail = await adminDetail(db, c.req.param('id'), voteContext());
    return detail ? c.json(detail satisfies FeedbackAdminDetail) : notFound(c);
  });
  // Edits are scrubbed like submissions: maintainers can fix wording, not add personal data.
  admin.put(
    '/feedback/:id',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => fail(c, 413, 'payload_too_large', 'The entry is too large.'),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return fail(c, 400, 'bad_request', 'The body must be JSON.');
      }
      const parsed = FeedbackEdit.safeParse(body);
      if (!parsed.success) return fail(c, 400, 'bad_request', describe(parsed.error));
      const { feedback, redactions, piiShare } = scrubSubmission(parsed.data);
      if (piiShare > MAX_PII_SHARE) {
        return fail(c, 422, 'pii_detected', 'The title or body is mostly personal data.');
      }
      const id = c.req.param('id').toLowerCase();
      if (!(await updateFeedback(db, id, feedback))) return notFound(c);
      const entry = await adminEntry(db, id, voteContext());
      if (!entry) return notFound(c); // deleted meanwhile
      return c.json({ entry, redactions } satisfies FeedbackEditResponse);
    },
  );
  // Human votes (maintainers): each weighs the vote threshold and is always counted.
  admin.post('/feedback/:id/vote', bodyLimit({ maxSize: 1024 }), async (c) => {
    const value = await readVote(c);
    if (typeof value !== 'number') return value;
    const id = c.req.param('id').toLowerCase();
    if (!(await addVote(db, id, value, 'human'))) return notFound(c);
    return c.json({ id, counted: true } satisfies FeedbackVoteResponse);
  });
  admin.delete('/feedback/:id/votes/:voteId', async (c) => {
    const id = c.req.param('id').toLowerCase();
    const voteId = c.req.param('voteId');
    if (!(await deleteVote(db, id, voteId))) return fail(c, 404, 'not_found', 'Vote not found.');
    return c.json({ id: voteId, deleted: true });
  });
  admin.delete('/feedback/:id', async (c) => {
    const id = c.req.param('id').toLowerCase();
    if (!(await deleteFeedback(db, id))) return notFound(c);
    return c.json({ id, deleted: true });
  });
  app.route('/admin', admin);

  // Read-only MCP endpoint (Streamable HTTP) for third-party agents: search_feedback.
  if (deps.mcp !== false) {
    app.all('/mcp', async (c) => {
      const tooMany = limited(searchLimiter, c);
      if (tooMany) return tooMany;
      return handleMcpRequest(c.req.raw, db, voteContext(), deps.random);
    });
  }

  app.notFound((c) => fail(c, 404, 'not_found', 'Not found.'));
  app.onError((err, c) => {
    process.stderr.write(`error ${safeRoutePath(c)}: ${err.name}: ${err.message.slice(0, 200)}\n`);
    return fail(c, 500, 'internal', 'Internal error.');
  });
  return app;
}

function fail(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  headers?: Record<string, string>,
) {
  return c.json({ error: { code, message } } satisfies ApiError, status, headers);
}

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
    .join('; ');
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function safeRoutePath(c: Context): string {
  try {
    return routePath(c, -1) || '-';
  } catch {
    return '-';
  }
}
