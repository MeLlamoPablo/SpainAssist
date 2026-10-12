/**
 * Creates vouchers directly in the database and prints the codes (one per line on stdout; the
 * summary goes to stderr, so `> codes.txt` captures only codes). Uses the same DATABASE_URL and
 * VOUCHER_PEPPER as the server.
 *
 *   corepack pnpm --filter @sa/key-server vouchers:create -- --count 5 --amount 5 \
 *     [--note demo] [--batch name] [--expires-at 2027-01-01T00:00:00Z]
 *
 * With PGlite (the dev default) stop the server first: only one process may open the database.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../config';
import { migrate } from '../db/migrate';
import { openDatabase } from '../db/open';
import { createVouchers } from '../vouchers';

const USAGE = `Usage: vouchers:create -- --count <n> --amount <usd> [--note <text>] [--batch <name>]
                       [--expires-at <ISO 8601>]`;

const NUMBER = { error: 'must be a number' };

const Args = z.object({
  count: z.coerce.number(NUMBER).int().min(1).max(1000),
  amount: z.coerce
    .number(NUMBER)
    .min(0.01)
    .max(10_000)
    .transform((v) => Math.round(v * 100) / 100),
  note: z.string().max(500).optional(),
  batch: z.string().min(1).max(100).optional(),
  'expires-at': z.iso.datetime({ offset: true }).optional(),
});

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift(); // `pnpm run x -- --flag` forwards the separator
  const { values } = parseArgs({
    args: argv,
    options: {
      count: { type: 'string', default: '1' },
      amount: { type: 'string' },
      note: { type: 'string' },
      batch: { type: 'string' },
      'expires-at': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.error(USAGE);
    return;
  }
  const parsed = Args.safeParse(values);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `--${i.path.join('.')}: ${i.message}`);
    throw new Error(`${details.join('\n')}\n${USAGE}`);
  }
  const args = parsed.data;
  const expiresAt = args['expires-at'] ? new Date(args['expires-at']) : undefined;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new Error('--expires-at must be in the future');
  }

  const config = loadConfig(process.env);
  for (const warning of config.warnings) console.error(`warning: ${warning}`);
  const db = await openDatabase(config.databaseUrl);
  try {
    await migrate(db);
    const { codes, batch } = await createVouchers(db, config.voucherPepper, {
      count: args.count,
      amountUsd: args.amount,
      expiresAt,
      note: args.note,
      batch: args.batch,
    });
    for (const code of codes) process.stdout.write(`${code}\n`);
    console.error(
      `Created ${codes.length} voucher(s) of $${args.amount} ` +
        `(batch ${batch}${expiresAt ? `, redeem before ${expiresAt.toISOString()}` : ''}). ` +
        'These codes are shown only once: store them safely.',
    );
  } finally {
    await db.close();
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
