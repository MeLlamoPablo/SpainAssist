import { randomUUID } from 'node:crypto';
import type { Queryable } from './db/types';

/**
 * All SQL lives here. Numeric and bigint columns are cast (`::float8`, `::int`) so both drivers
 * return JS numbers; timestamps come back as Date from both and are converted with `iso()`.
 */

export type VoucherStatus = 'active' | 'redeemed' | 'revoked';

/**
 * Filter of the admin listing. `active` means still redeemable; `expired` is an active voucher
 * past its deadline (its stored status stays `active`).
 */
export type VoucherStatusFilter = VoucherStatus | 'expired';
export const VOUCHER_STATUS_FILTERS = ['active', 'expired', 'redeemed', 'revoked'] as const;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

// --- vouchers --------------------------------------------------------------------------------

export interface NewVoucher {
  codeHash: string;
  amountUsd: number;
  note?: string;
  batch?: string;
  expiresAt?: Date;
}

/** Inserts a voucher; returns false if the code hash already exists (code collision). */
export async function insertVoucher(db: Queryable, v: NewVoucher): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO vouchers (id, code_hash, amount_usd, note, batch, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (code_hash) DO NOTHING
     RETURNING id`,
    [randomUUID(), v.codeHash, v.amountUsd, v.note ?? null, v.batch ?? null, v.expiresAt ?? null],
  );
  return rows.length === 1;
}

export interface ClaimedVoucher {
  id: string;
  amountUsd: number;
  /** The voucher's own deadline, if it has one. */
  expiresAt?: Date;
}

/**
 * Atomically marks an active, unexpired voucher as redeemed. Under concurrency only one caller
 * gets the row: Postgres makes the others wait on the row lock and then re-check the WHERE
 * clause (no longer 'active'); PGlite serializes transactions. Must run inside the redemption
 * transaction so a failed key provisioning rolls it back.
 */
export async function claimVoucher(
  db: Queryable,
  codeHash: string,
): Promise<ClaimedVoucher | null> {
  const { rows } = await db.query<{ id: string; amount_usd: number; expires_at: Date | null }>(
    `UPDATE vouchers SET status = 'redeemed', redeemed_at = now()
      WHERE code_hash = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
      RETURNING id, amount_usd::float8 AS amount_usd, expires_at`,
    [codeHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    amountUsd: row.amount_usd,
    ...(row.expires_at ? { expiresAt: new Date(row.expires_at) } : {}),
  };
}

/** Why a voucher could not be claimed (null = unknown code). */
export async function voucherState(
  db: Queryable,
  codeHash: string,
): Promise<{ status: VoucherStatus; expired: boolean } | null> {
  const { rows } = await db.query<{ status: VoucherStatus; expired: boolean }>(
    `SELECT status, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
       FROM vouchers WHERE code_hash = $1`,
    [codeHash],
  );
  return rows[0] ?? null;
}

export interface IssuedKeySummary {
  provider: string;
  label: string;
  limitUsd: number;
  createdAt: string | null;
  expiresAt: string | null;
  disabledAt: string | null;
}

export interface VoucherSummary {
  id: string;
  status: VoucherStatus;
  /** Active but past its redemption deadline. */
  expired: boolean;
  amountUsd: number;
  note: string | null;
  batch: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  redeemedAt: string | null;
  key: IssuedKeySummary | null;
}

export async function listVouchers(
  db: Queryable,
  filter: { status?: VoucherStatusFilter; batch?: string; limit: number },
): Promise<VoucherSummary[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT v.id, v.status, v.amount_usd::float8 AS amount_usd, v.note, v.batch,
            v.created_at, v.expires_at, v.redeemed_at,
            (v.status = 'active' AND v.expires_at IS NOT NULL AND v.expires_at <= now()) AS expired,
            k.provider, k.label, k.limit_usd::float8 AS limit_usd, k.created_at AS key_created_at,
            k.expires_at AS key_expires_at, k.disabled_at AS key_disabled_at
       FROM vouchers v
       LEFT JOIN issued_keys k ON k.voucher_id = v.id
      WHERE ($1::text IS NULL
             OR ($1 IN ('redeemed', 'revoked') AND v.status = $1)
             OR ($1 = 'active' AND v.status = 'active'
                 AND (v.expires_at IS NULL OR v.expires_at > now()))
             OR ($1 = 'expired' AND v.status = 'active' AND v.expires_at <= now()))
        AND ($2::text IS NULL OR v.batch = $2)
      ORDER BY v.created_at DESC, v.id
      LIMIT $3`,
    [filter.status ?? null, filter.batch ?? null, filter.limit],
  );
  return rows.map((r) => ({
    id: r.id as string,
    status: r.status as VoucherStatus,
    expired: r.expired as boolean,
    amountUsd: r.amount_usd as number,
    note: (r.note as string | null) ?? null,
    batch: (r.batch as string | null) ?? null,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    redeemedAt: iso(r.redeemed_at),
    key: r.provider
      ? {
          provider: r.provider as string,
          label: r.label as string,
          limitUsd: r.limit_usd as number,
          createdAt: iso(r.key_created_at),
          expiresAt: iso(r.key_expires_at),
          disabledAt: iso(r.key_disabled_at),
        }
      : null,
  }));
}

export interface RevokedVoucher {
  /** Status before this call (`revoked` when it was revoked already). */
  previousStatus: VoucherStatus;
  amountUsd: number;
  /** The key the voucher's amount went to, if it was redeemed. */
  issuedKeyId: string | null;
}

/** Marks a voucher revoked (idempotent). Null if unknown. */
export async function revokeVoucher(db: Queryable, id: string): Promise<RevokedVoucher | null> {
  const { rows } = await db.query<{
    previous_status: VoucherStatus;
    amount_usd: number;
    issued_key_id: string | null;
  }>(
    `WITH old AS (SELECT id, status FROM vouchers WHERE id = $1 FOR UPDATE)
     UPDATE vouchers v SET status = 'revoked' FROM old WHERE v.id = old.id
     RETURNING old.status AS previous_status, v.amount_usd::float8 AS amount_usd, v.issued_key_id`,
    [id],
  );
  const row = rows[0];
  return row
    ? {
        previousStatus: row.previous_status,
        amountUsd: row.amount_usd,
        issuedKeyId: row.issued_key_id,
      }
    : null;
}

// --- issued keys -----------------------------------------------------------------------------

export type IssuedKeyKind = 'voucher' | 'chatgpt';

export async function insertIssuedKey(
  db: Queryable,
  k: {
    kind: IssuedKeyKind;
    /** Voucher keys only. */
    voucherId?: string;
    /** ChatGPT keys only: HMAC of the OpenAI account and the sealed key (see crypto.ts). */
    chatgpt?: { accountHash: string; keyCiphertext: string };
    provider: string;
    keyHash: string;
    label: string;
    limitUsd: number;
    expiresAt?: string;
  },
): Promise<void> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO issued_keys (id, kind, voucher_id, provider, key_hash, label, limit_usd, expires_at,
                              account_hash, key_ciphertext, last_issued_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $9::text IS NULL THEN NULL ELSE now() END)`,
    [
      id,
      k.kind,
      k.voucherId ?? null,
      k.provider,
      k.keyHash,
      k.label,
      k.limitUsd,
      k.expiresAt ?? null,
      k.chatgpt?.accountHash ?? null,
      k.chatgpt?.keyCiphertext ?? null,
    ],
  );
  if (k.voucherId) {
    await db.query('UPDATE vouchers SET issued_key_id = $2 WHERE id = $1', [k.voucherId, id]);
  }
}

/**
 * Records a voucher redeemed as a top-up: its amount went to an existing voucher key, which
 * now expires at `expiresAt` (null = never).
 */
export async function topUpIssuedKey(
  db: Queryable,
  t: { issuedKeyId: string; voucherId: string; amountUsd: number; expiresAt: string | null },
): Promise<void> {
  await db.query(
    'UPDATE issued_keys SET limit_usd = limit_usd + $2, expires_at = $3 WHERE id = $1',
    [t.issuedKeyId, t.amountUsd, t.expiresAt],
  );
  await db.query('UPDATE vouchers SET issued_key_id = $2 WHERE id = $1', [
    t.voucherId,
    t.issuedKeyId,
  ]);
}

/** Takes a revoked voucher's amount off the key it went to. */
export async function lowerIssuedKeyLimit(
  db: Queryable,
  issuedKeyId: string,
  amountUsd: number,
): Promise<void> {
  await db.query('UPDATE issued_keys SET limit_usd = greatest(0, limit_usd - $2) WHERE id = $1', [
    issuedKeyId,
    amountUsd,
  ]);
}

export interface ChatGPTKeyRow {
  provider: string;
  keyCiphertext: string;
  disabled: boolean;
}

/** The key of an OpenAI account, if it has one; records that it was handed out again. */
export async function touchChatGPTKey(
  db: Queryable,
  accountHash: string,
): Promise<ChatGPTKeyRow | null> {
  const { rows } = await db.query<{
    provider: string;
    key_ciphertext: string;
    disabled: boolean;
  }>(
    `UPDATE issued_keys SET last_issued_at = now()
      WHERE kind = 'chatgpt' AND account_hash = $1
      RETURNING provider, key_ciphertext, (disabled_at IS NOT NULL) AS disabled`,
    [accountHash],
  );
  const row = rows[0];
  return row
    ? { provider: row.provider, keyCiphertext: row.key_ciphertext, disabled: row.disabled }
    : null;
}

// --- server settings -------------------------------------------------------------------------

export async function getSetting(db: Queryable, name: string): Promise<string | null> {
  const { rows } = await db.query<{ value: string }>(
    'SELECT value FROM server_settings WHERE name = $1',
    [name],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(db: Queryable, name: string, value: string): Promise<void> {
  await db.query(
    `INSERT INTO server_settings (name, value) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [name, value],
  );
}

export interface FundedKey {
  id: string;
  provider: string;
  keyHash: string;
  disabled: boolean;
  /** Some voucher that funds the key is not revoked. */
  funded: boolean;
}

/** An issued key and whether any of the vouchers whose amounts went to it is still valid. */
export async function fundedKey(db: Queryable, issuedKeyId: string): Promise<FundedKey | null> {
  const { rows } = await db.query<{
    id: string;
    provider: string;
    key_hash: string;
    disabled: boolean;
    funded: boolean;
  }>(
    `SELECT k.id, k.provider, k.key_hash, (k.disabled_at IS NOT NULL) AS disabled,
            EXISTS (SELECT 1 FROM vouchers v
                     WHERE v.issued_key_id = k.id AND v.status <> 'revoked') AS funded
       FROM issued_keys k WHERE k.id = $1`,
    [issuedKeyId],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        provider: row.provider,
        keyHash: row.key_hash,
        disabled: row.disabled,
        funded: row.funded,
      }
    : null;
}

export async function markKeyDisabled(db: Queryable, id: string): Promise<void> {
  await db.query('UPDATE issued_keys SET disabled_at = now() WHERE id = $1', [id]);
}

/** An enabled, unexpired voucher key: it may start research and be topped up. */
export interface VoucherKey {
  id: string;
  keyHash: string;
  provider: string;
  /** ISO 8601; null = never expires. */
  expiresAt: string | null;
}

/**
 * An enabled, unexpired voucher key by its SHA-256, while some voucher that funds it is not
 * revoked (revoking blocks the key upstream; this also covers a block that failed).
 */
export async function findVoucherKeyByHash(
  db: Queryable,
  keyHash: string,
): Promise<VoucherKey | null> {
  const { rows } = await db.query<{
    id: string;
    key_hash: string;
    provider: string;
    expires_at: Date | null;
  }>(
    `SELECT k.id, k.key_hash, k.provider, k.expires_at
       FROM issued_keys k
      WHERE k.key_hash = $1 AND k.kind = 'voucher' AND k.disabled_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > now())
        AND EXISTS (SELECT 1 FROM vouchers v
                     WHERE v.issued_key_id = k.id AND v.status <> 'revoked')`,
    [keyHash],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        keyHash: row.key_hash,
        provider: row.provider,
        expiresAt: iso(row.expires_at),
      }
    : null;
}

/**
 * Any voucher key by its SHA-256 (also expired, blocked or revoked ones): what its vouchers add
 * up to and its expiry, for its balance.
 */
export async function findVoucherKeyLimit(
  db: Queryable,
  keyHash: string,
): Promise<{ provider: string; limitUsd: number; expiresAt: string | null } | null> {
  const { rows } = await db.query<{ provider: string; limit_usd: number; expires_at: Date | null }>(
    `SELECT provider, limit_usd::float8 AS limit_usd, expires_at
       FROM issued_keys WHERE key_hash = $1 AND kind = 'voucher'`,
    [keyHash],
  );
  const row = rows[0];
  return row
    ? { provider: row.provider, limitUsd: row.limit_usd, expiresAt: iso(row.expires_at) }
    : null;
}

/**
 * Serializes budget changes of one key (held until the transaction ends). Returns the key's
 * expiry and what its vouchers add up to, as read under the lock (null if the key is gone).
 */
export async function lockIssuedKey(
  tx: Queryable,
  issuedKeyId: string,
): Promise<{ expiresAt: string | null; limitUsd: number } | null> {
  const { rows } = await tx.query<{ expires_at: Date | null; limit_usd: number }>(
    'SELECT expires_at, limit_usd::float8 AS limit_usd FROM issued_keys WHERE id = $1 FOR UPDATE',
    [issuedKeyId],
  );
  return rows[0] ? { expiresAt: iso(rows[0].expires_at), limitUsd: rows[0].limit_usd } : null;
}

// --- research runs ---------------------------------------------------------------------------

export type ResearchRunState =
  | 'reserved'
  | 'running'
  | 'completed'
  | 'refunding'
  | 'refunded'
  | 'expired';

export interface ResearchRun {
  id: string;
  issuedKeyId: string;
  requestId: string | null;
  parallelRunId: string | null;
  processor: string;
  priceUsd: number;
  state: ResearchRunState;
  createdAt: string;
  finishedAt: string | null;
}

const RUN_COLUMNS = `id, issued_key_id, request_id, parallel_run_id, processor,
  price_usd::float8 AS price_usd, state, created_at, finished_at`;

function toRun(r: Record<string, unknown>): ResearchRun {
  return {
    id: r.id as string,
    issuedKeyId: r.issued_key_id as string,
    requestId: (r.request_id as string | null) ?? null,
    parallelRunId: (r.parallel_run_id as string | null) ?? null,
    processor: r.processor as string,
    priceUsd: r.price_usd as number,
    state: r.state as ResearchRunState,
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
    finishedAt: iso(r.finished_at),
  };
}

export async function insertResearchRun(
  db: Queryable,
  run: { id: string; issuedKeyId: string; requestId?: string; processor: string; priceUsd: number },
): Promise<ResearchRun> {
  const { rows } = await db.query<Record<string, unknown>>(
    `INSERT INTO research_runs (id, issued_key_id, request_id, processor, price_usd, state)
     VALUES ($1, $2, $3, $4, $5, 'reserved')
     RETURNING ${RUN_COLUMNS}`,
    [run.id, run.issuedKeyId, run.requestId ?? null, run.processor, run.priceUsd],
  );
  return toRun(rows[0]!);
}

export async function findRunByRequestId(
  db: Queryable,
  issuedKeyId: string,
  requestId: string,
): Promise<ResearchRun | null> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT ${RUN_COLUMNS} FROM research_runs WHERE issued_key_id = $1 AND request_id = $2`,
    [issuedKeyId, requestId],
  );
  return rows[0] ? toRun(rows[0]) : null;
}

/** A run, only if it belongs to the given key. */
export async function findRun(
  db: Queryable,
  issuedKeyId: string,
  id: string,
): Promise<ResearchRun | null> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT ${RUN_COLUMNS} FROM research_runs WHERE id = $1 AND issued_key_id = $2`,
    [id, issuedKeyId],
  );
  return rows[0] ? toRun(rows[0]) : null;
}

export async function findRunById(db: Queryable, id: string): Promise<ResearchRun | null> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT ${RUN_COLUMNS} FROM research_runs WHERE id = $1`,
    [id],
  );
  return rows[0] ? toRun(rows[0]) : null;
}

export async function countActiveRuns(db: Queryable, issuedKeyId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM research_runs
      WHERE issued_key_id = $1 AND state IN ('reserved', 'running')`,
    [issuedKeyId],
  );
  return rows[0]?.n ?? 0;
}

export async function markRunStarted(
  db: Queryable,
  id: string,
  parallelRunId: string,
): Promise<void> {
  await db.query(
    `UPDATE research_runs SET state = 'running', parallel_run_id = $2, started_at = now()
      WHERE id = $1 AND state = 'reserved'`,
    [id, parallelRunId],
  );
}

/** Final states that keep the charge. No-op if the run was already settled. */
export async function settleRun(
  db: Queryable,
  id: string,
  state: 'completed' | 'expired',
): Promise<void> {
  await db.query(
    `UPDATE research_runs SET state = $2, finished_at = now()
      WHERE id = $1 AND state IN ('reserved', 'running')`,
    [id, state],
  );
}

export async function runOwner(
  db: Queryable,
  id: string,
): Promise<{ issuedKeyId: string; keyHash: string } | null> {
  const { rows } = await db.query<{ issued_key_id: string; key_hash: string }>(
    `SELECT r.issued_key_id, k.key_hash
       FROM research_runs r JOIN issued_keys k ON k.id = r.issued_key_id WHERE r.id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? { issuedKeyId: row.issued_key_id, keyHash: row.key_hash } : null;
}

/** Moves a pending run to `refunded`; returns its price, or null if it was already settled. */
export async function markRunRefunded(db: Queryable, id: string): Promise<number | null> {
  const { rows } = await db.query<{ price_usd: number }>(
    `UPDATE research_runs SET state = 'refunded', finished_at = now()
      WHERE id = $1 AND state IN ('reserved', 'running', 'refunding')
      RETURNING price_usd::float8 AS price_usd`,
    [id],
  );
  return rows[0]?.price_usd ?? null;
}

export async function markRunRefunding(db: Queryable, id: string): Promise<void> {
  await db.query(
    `UPDATE research_runs SET state = 'refunding'
      WHERE id = $1 AND state IN ('reserved', 'running')`,
    [id],
  );
}

/** Runs that still need work: in flight, or owed a refund. */
export async function pendingRuns(db: Queryable): Promise<ResearchRun[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT ${RUN_COLUMNS} FROM research_runs
      WHERE state IN ('reserved', 'running', 'refunding') ORDER BY created_at`,
  );
  return rows.map(toRun);
}
