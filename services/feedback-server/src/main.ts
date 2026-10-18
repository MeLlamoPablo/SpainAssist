import { serve } from '@hono/node-server';
import { createKeyChecker } from '@sa/gateway-keys';
import { createApp } from './app';
import { loadConfig } from './config';
import { migrate } from './db/migrate';
import { openDb } from './db/open';
import { scheduleVotePurge } from './feedback/retention';
import { seedFeedback } from './feedback/seed';

const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

async function main() {
  const config = loadConfig();
  const db = await openDb(config.databaseUrl);
  const applied = await migrate(db);
  if (applied.length > 0) log(`migrations applied: ${applied.join(', ')}`);

  if (config.devSeed) {
    const n = await seedFeedback(db);
    if (n > 0) log(`seeded ${n} example learnings (tag "seed")`);
  }
  // Retention: votes are deleted once they stop counting (VOTE_DECAY_END_DAYS), hourly.
  const stopPurge = scheduleVotePurge(db, config.votes, log);
  const app = createApp({
    db,
    adminToken: config.adminToken,
    trustProxy: config.trustProxy,
    ...(config.users
      ? {
          users: {
            checkKey: createKeyChecker({ litellmUrl: config.users.litellmUrl }),
            idSecret: config.users.idSecret,
          },
        }
      : {}),
    limits: {
      submitPerHour: config.submitPerHour,
      searchPerMinute: config.searchPerMinute,
      votePerHour: config.votePerHour,
      submitPerKeyPerDay: config.submitPerKeyPerDay,
      votePerKeyPerDay: config.votePerKeyPerDay,
    },
    mcp: config.mcp,
    votes: config.votes,
    log,
  });
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) =>
    log(
      `feedback server on http://${info.address}:${info.port} (db: ${db.kind}, admin: ${
        config.adminToken ? 'on' : 'off'
      }, mcp: ${config.mcp ? 'on' : 'off'}, sharing: ${config.users ? 'on' : 'off: no LITELLM_URL'})`,
    ),
  );

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log(`${signal}: shutting down`);
    stopPurge();
    server.close(() => {
      db.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
