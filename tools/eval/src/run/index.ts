/**
 * The run: one fixture from the first prompt to the written artifacts. `runFixture` is the entry;
 * the rest is what the CLI and the tests need around it. See tools/eval/README.md ("The run").
 */

export {
  CHECKPOINT_FORMAT,
  CheckpointError,
  CheckpointManifestSchema,
  type CheckpointRef,
  listCheckpoints,
  parseCheckpointRef,
  readCheckpoint,
  writeCheckpoint,
} from './checkpoint';
export { type RunOptions, type RunOutcome, runFixture } from './loop';
export { ObservationLog } from './observation-log';
export {
  generateRunId,
  isValidRunId,
  readRunResult,
  renderActivity,
  renderRunReport,
  renderSummaryTable,
  reportRun,
  runPaths,
  summarizeResult,
} from './results';
export { RunSecrets } from './secrets';
export { createUserSimulator, SimulatorError } from './simulator';
