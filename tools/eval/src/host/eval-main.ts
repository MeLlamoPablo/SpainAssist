/**
 * Entry point of the eval agent host, bundled to `dist/eval-host.js` (scripts/build-eval-host.mjs).
 * The harness spawns it where the product spawns `dist/host.js` (`buildAgentLaunch` with
 * `hostPath`) and gives it its config in `SA_EVAL_CONFIG`. It is the product host
 * (`runHost` from `@sa/agent/host-runtime`) with the eval's hooks: see hooks.ts. Never packaged.
 *
 * stdout is the pi RPC channel: nothing in this entry or the hooks may write to it.
 */
import { hostLog, runHost } from '@sa/agent/host-runtime';
import { createEvalHooks } from './hooks';

async function main(): Promise<void> {
  await runHost(process.env, createEvalHooks(process.env));
}

main().catch((error: unknown) => {
  hostLog(
    'error',
    `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
