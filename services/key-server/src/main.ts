import { serve } from '@hono/node-server';
import { createApp } from './app';
import { DEMO_VOUCHER_CODE } from './codes';
import { loadConfig } from './config';
import { migrate } from './db/migrate';
import { openDatabase } from './db/open';
import { errorSummary } from './errors';
import { createChatGPTVerifier, remoteJwks } from './identity';
import { createLogger } from './logger';
import { createProvisioner } from './providers';
import { ParallelTaskApi } from './research/parallel';
import { ResearchService } from './research/service';
import { SubsidyTeam } from './subsidy-team';
import { ensureDemoVoucher } from './vouchers';

const HOUR_MS = 3_600_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log = createLogger({ level: config.logLevel });
  for (const warning of config.warnings) log.warn(warning);

  const db = await openDatabase(config.databaseUrl);
  const applied = await migrate(db);
  if (applied.length > 0) log.info('migrations applied', { versions: applied.join(',') });

  const provisioner = createProvisioner(config);
  if (provisioner.kind === 'mock') {
    log.warn('LITELLM_ADMIN_URL not set: issuing mock keys for the local mock LLM', {
      baseUrl: config.mockLlmBaseUrl,
    });
  }

  // The demo code is public, so it is only ever honoured with the mock provider.
  let devSeed = config.devSeed;
  if (devSeed && provisioner.kind !== 'mock') {
    log.warn('DEV_SEED ignored: a real LiteLLM proxy is configured');
    devSeed = false;
  }
  if (devSeed) {
    await ensureDemoVoucher(db, { pepper: config.voucherPepper });
    log.info('dev seed: demo voucher is active (re-armed after each redemption)', {
      code: DEMO_VOUCHER_CODE,
    });
  }

  // OpenAI's keys are fetched on the first ChatGPT key request, not at startup.
  const identity = createChatGPTVerifier({
    issuer: config.openaiIdentity.issuer,
    keys: remoteJwks(config.openaiIdentity.jwksUrl),
    audiencePrefix: config.openaiIdentity.audiencePrefix,
  });

  const research = config.parallel
    ? new ResearchService({
        db,
        provisioner,
        upstream: new ParallelTaskApi(config.parallel),
        settings: config.research,
        logger: log,
      })
    : undefined;
  if (research) {
    log.info('web research enabled', {
      modes: Object.entries(config.research.modes)
        .map(([mode, { processor, priceUsd }]) => `${mode}=${processor} $${priceUsd}`)
        .join(', '),
    });
  } else {
    log.warn('PARALLEL_API_KEY not set: web research is disabled');
  }
  const resumeResearch = () =>
    research
      ?.resume()
      .then(({ followed, refunded }) => {
        if (followed || refunded) log.info('research runs resumed', { followed, refunded });
      })
      .catch((err) => log.warn('research housekeeping failed', { error: errorSummary(err) }));
  void resumeResearch();

  // ChatGPT keys get a changed DECIDER_MODEL; retried by the housekeeping until it succeeds.
  const subsidyTeam = new SubsidyTeam(db, provisioner, {
    deciderModel: config.deciderModel,
    monthlyBudgetUsd: config.chatgptKeys.globalMonthlyBudgetUsd,
  });
  let keyModelsSynced = false;
  const syncKeyModels = () =>
    keyModelsSynced
      ? undefined
      : subsidyTeam
          .syncModels()
          .then((keys) => {
            keyModelsSynced = true;
            if (keys) log.info('ChatGPT keys moved to the decider model', { keys });
          })
          .catch((err) => log.warn('ChatGPT key models not updated', { error: errorSummary(err) }));
  void syncKeyModels();

  const app = createApp({
    db,
    config: { ...config, devSeed },
    provisioner,
    identity,
    logger: log,
    research,
  });
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    log.info('key server listening', {
      url: `http://${info.address}:${info.port}`,
      database: db.kind,
      keys: provisioner.kind,
      admin: Boolean(config.adminToken),
    });
  });

  // Housekeeping: follow unfinished research runs, retry refunds and key model updates.
  const housekeeping = setInterval(() => {
    void resumeResearch();
    void syncKeyModels();
  }, HOUR_MS);
  housekeeping.unref();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    clearInterval(housekeeping);
    server.close(() => {
      db.close()
        .catch((err) => log.error('error closing database', { error: errorSummary(err) }))
        .finally(() => process.exit(0));
    });
    // Do not hang forever on keep-alive connections.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(
    JSON.stringify({ level: 'error', msg: 'key server failed to start', error: errorSummary(err) }),
  );
  process.exit(1);
});
