/**
 * The harness side of SpainBench: the scoring API client, the server launcher, the version check,
 * the event follower and the artifacts. See tools/eval/README.md ("SpainBench client") and
 * docs/EVAL.md.
 */

export { type SaveBenchArtifactsOptions, saveBenchArtifacts } from './artifacts';
export {
  type BenchDescription,
  checkBenchVersion,
  describeBench,
  type Runnable,
  runnable,
} from './check';
export {
  BENCH_WORLD_ID_PATTERN,
  type BenchApiOptions,
  createBenchApi,
  newWorldId,
} from './client';
export {
  BenchError,
  type BenchErrorCode,
  BenchLaunchError,
  BenchTargetError,
  BenchVersionError,
  isBenchError,
} from './errors';
export { benchObservation, type FollowBenchOptions, followBenchEvents } from './events';
export {
  type BenchExit,
  type BenchServer,
  type ConnectBenchOptions,
  type ConnectedBench,
  connectBench,
  type LaunchedBench,
  openBench,
  type StartBenchOptions,
  startBench,
} from './launcher';
export { type BenchEnv, type BenchTarget, resolveBenchTarget } from './target';
