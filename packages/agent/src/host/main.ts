/**
 * Entry point of the agent host, bundled to dist/host.js. Spawned by the desktop app (see
 * buildAgentLaunch) with ELECTRON_RUN_AS_NODE=1, or with plain `node` in tests.
 */
import { hostLog } from './log';
import { runHost } from './run';

// This process hosts the agent's chat and all its workflows: a rejection nobody handled (a bug,
// or one model code found a way to cause) is logged instead of ending them all.
process.on('unhandledRejection', (reason: unknown) => {
  hostLog(
    'error',
    `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});

runHost().catch((error: unknown) => {
  hostLog(
    'error',
    `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
