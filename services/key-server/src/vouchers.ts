import { randomBytes, randomUUID } from 'node:crypto';
import { DEMO_VOUCHER_BODY, generateVoucherCode, normalizeVoucherCode } from './codes';
import { hashVoucherCode } from './crypto';
import type { Db } from './db/types';
import { insertVoucher } from './store';

export interface CreateVouchersInput {
  count: number;
  amountUsd: number;
  expiresAt?: Date;
  note?: string;
  /** Batch label; generated when omitted. */
  batch?: string;
}

/**
 * Creates `count` vouchers in one transaction. The plaintext codes exist only in the return
 * value: the database keeps their HMAC.
 */
export async function createVouchers(
  db: Db,
  pepper: string,
  input: CreateVouchersInput,
): Promise<{ codes: string[]; batch: string }> {
  const batch =
    input.batch ?? `b-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`;
  const codes = await db.transaction(async (tx) => {
    const created: string[] = [];
    while (created.length < input.count) {
      const code = generateVoucherCode();
      const inserted = await insertVoucher(tx, {
        codeHash: hashVoucherCode(normalizeVoucherCode(code) as string, pepper),
        amountUsd: input.amountUsd,
        note: input.note,
        batch,
        expiresAt: input.expiresAt,
      });
      if (inserted) created.push(code); // a collision (30 bits) just means "draw again"
    }
    return created;
  });
  return { codes, batch };
}

export const DEMO_VOUCHER_AMOUNT_USD = 5;

/**
 * Development only (DEV_SEED=1 with the mock provider): makes sure the public demo voucher
 * SA-DEMO42 is active. A redeemed/revoked/expired demo voucher is retired (its hash is
 * renamed, keeping its issued key row intact) and a fresh one is created.
 */
export async function ensureDemoVoucher(
  db: Db,
  options: { pepper: string },
): Promise<'created' | 'active'> {
  const codeHash = hashVoucherCode(DEMO_VOUCHER_BODY, options.pepper);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; usable: boolean }>(
      `SELECT id, (status = 'active' AND (expires_at IS NULL OR expires_at > now())) AS usable
         FROM vouchers WHERE code_hash = $1 FOR UPDATE`,
      [codeHash],
    );
    const current = rows[0];
    if (current?.usable) return 'active';
    if (current) {
      await tx.query(`UPDATE vouchers SET code_hash = $2 WHERE id = $1`, [
        current.id,
        `${codeHash}:retired:${randomUUID()}`,
      ]);
    }
    await insertVoucher(tx, {
      codeHash,
      amountUsd: DEMO_VOUCHER_AMOUNT_USD,
      note: 'public demo voucher (DEV_SEED)',
      batch: 'dev-seed',
    });
    return 'created';
  });
}
