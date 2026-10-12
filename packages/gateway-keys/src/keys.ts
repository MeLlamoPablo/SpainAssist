import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';

/** A gateway key's standing: usable, unknown or revoked, or out of budget. */
export type KeyStatus = 'ok' | 'invalid' | 'no_credit';

export class KeyCheckUnavailableError extends Error {
  constructor() {
    super('Key check unavailable.');
    this.name = 'KeyCheckUnavailableError';
  }
}

/** LiteLLM's id for a key: SHA-256 of the key (also our cache and quota key: no raw keys kept). */
export const keyId = (key: string) => createHash('sha256').update(key).digest('hex');

/**
 * The user behind a gateway key, as our services store it: HMAC-SHA256 of the key id with a
 * server secret. One key stands for one user (a voucher app, one ChatGPT account, or a developer's
 * key in development builds); without the secret the id can't be matched with LiteLLM's key
 * hashes.
 */
export const userId = (key: string, secret: string) =>
  createHmac('sha256', secret).update(keyId(key)).digest('base64url');

const BEARER = /^Bearer (sk-[A-Za-z0-9_-]{8,200})$/;

/** The gateway key in an `Authorization: Bearer sk-…` header, if well formed. */
export const bearerKey = (header: string | undefined) => BEARER.exec(header ?? '')?.[1];

const KeyInfo = z.object({
  info: z.object({
    spend: z.number().nullish(),
    max_budget: z.number().nullish(),
    blocked: z.boolean().nullish(),
    /** v1.104: "active" | "expired" | "revoked" | "deleted". */
    status: z.string().nullish(),
    expires: z.string().nullish(),
  }),
});

export interface KeyCheckerOptions {
  /** LiteLLM base URL. Keys may read their own `/key/info` (see the key server's KEY_ROUTES). */
  litellmUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long an answer is reused, so most requests do not reach LiteLLM. */
  okTtlMs?: number;
  failTtlMs?: number;
}

/**
 * Checks a user's gateway key (a voucher key, or a ChatGPT account's key) against LiteLLM with
 * the key itself: it must be active, unexpired and below its spending cap. Answers are cached
 * briefly by key hash.
 */
export function createKeyChecker({
  litellmUrl,
  fetch: fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  okTtlMs = 5 * 60_000,
  failTtlMs = 60_000,
}: KeyCheckerOptions) {
  const cache = new Map<string, { status: KeyStatus; until: number }>();

  async function ask(key: string): Promise<KeyStatus> {
    let response: Response;
    try {
      response = await fetchImpl(`${litellmUrl}/key/info`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
    } catch {
      throw new KeyCheckUnavailableError();
    }
    if ([400, 401, 403, 404].includes(response.status)) return 'invalid';
    if (!response.ok) throw new KeyCheckUnavailableError();
    const parsed = KeyInfo.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new KeyCheckUnavailableError();
    const { spend, max_budget, blocked, status, expires } = parsed.data.info;
    if (blocked || (status && status !== 'active')) return 'invalid';
    if (expires && Date.parse(expires) <= now()) return 'invalid';
    if (max_budget != null && (spend ?? 0) >= max_budget) return 'no_credit';
    return 'ok';
  }

  return async function check(key: string): Promise<KeyStatus> {
    const id = keyId(key);
    const cached = cache.get(id);
    if (cached && cached.until > now()) return cached.status;
    const status = await ask(key);
    if (cache.size > 50_000) {
      for (const [k, v] of cache) if (v.until <= now()) cache.delete(k);
    }
    cache.set(id, { status, until: now() + (status === 'ok' ? okTtlMs : failTtlMs) });
    return status;
  };
}

export type KeyChecker = ReturnType<typeof createKeyChecker>;
