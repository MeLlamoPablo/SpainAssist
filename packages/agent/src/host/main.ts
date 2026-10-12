/**
 * Entry point of the agent host, bundled to dist/host.js. Spawned by the desktop app (see
 * buildAgentLaunch) with ELECTRON_RUN_AS_NODE=1, or with plain `node` in tests.
 */
import { hostLog } from './log';
import { runHost } from './run';

runHost().catch((error: unknown) => {
  hostLog(
    'error',
    `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
