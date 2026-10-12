import { serve } from '@hono/node-server';
import { createKeyChecker } from '@sa/gateway-keys';
import { createApp } from './app';
import { loadConfig } from './config';

const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

function main() {
  const config = loadConfig();
  const app = createApp({
    mapboxToken: config.mapboxToken,
    checkKey: createKeyChecker({ litellmUrl: config.litellmUrl }),
    dailyLimit: config.dailyLimit,
    weeklyLimit: config.weeklyLimit,
    perIpPerMinute: config.perIpPerMinute,
    trustProxy: config.trustProxy,
    log,
  });
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) =>
    log(
      `maps server on http://${info.address}:${info.port} (limits per key: ${config.dailyLimit}/day, ${config.weeklyLimit}/week)`,
    ),
  );

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log(`${signal}: shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (err) {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
