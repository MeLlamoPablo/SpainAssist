import {
  chmodSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { AnswerStateSnapshot } from '../answers';
import type {
  BenchApi,
  CheckpointManifest,
  EvalApp,
  Fixture,
  MeterUsage,
  PromptKind,
} from '../contracts';
import { ensurePrivateDir, writeFileAtomic, writePrivateJson } from '../llm/home';
import type { RuleEngineState } from '../rules';
import { isBrowserBackground } from '../rules/leaves';
import type { ObservationLog } from './observation-log';
import {
  describeIssues,
  type EventLines,
  fixtureHash,
  frozenHash,
  parseJson,
  type RunManifest,
  type RunPaths,
  readEvents,
  readRunManifest,
} from './results';

/**
 * Checkpoints: the state of a run at a quiescent point, enough to start a new run from it
 * (docs/EVAL.md, "State machine and resuming"). One folder per checkpoint under
 * `<runDir>/checkpoints/<n>/`:
 *
 * ```text
 * manifest.json        CheckpointManifest (written last: a folder without it is not a checkpoint)
 * bench-snapshot.json  SpainBench's snapshot of the world (`BenchApi.snapshot`)
 * app/                 what the app exported: the profile copy and the browser state
 * ```
 *
 * Paths inside the manifest are relative to the checkpoint folder.
 */

export const CHECKPOINT_FORMAT = 'sa-eval-checkpoint/1';

/** Prompts the app cannot restore after a restart: it only brings back forms and phone calls. */
const UNRESTORABLE: readonly PromptKind[] = ['confirm', 'credential', 'user_action'];

export type CheckpointErrorCode =
  | 'not_a_checkpoint'
  | 'invalid'
  | 'other_fixture'
  | 'fixture_changed'
  | 'incomplete'
  | 'outside';

export class CheckpointError extends Error {
  constructor(
    readonly code: CheckpointErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CheckpointError';
  }
}

const MeterUsageSchema = z.strictObject({
  requests: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  costUsd: z.number(),
  cacheHits: z.number(),
  looseHits: z.number().optional(),
});

const SeqMap = z.record(z.string(), z.number().int().nonnegative());

export const CheckpointManifestSchema = z.strictObject({
  format: z.literal(CHECKPOINT_FORMAT),
  runId: z.string().min(1),
  index: z.number().int().positive(),
  atSeq: z.number().int().nonnegative(),
  quiescent: z.boolean(),
  benchSnapshotFile: z.string().min(1),
  profileDir: z.string().min(1),
  browserStateFile: z.string().min(1).optional(),
  answerState: z.strictObject({
    unlockedGroup: z.number().int().nonnegative(),
    used: z.array(z.string()),
  }),
  ruleState: z.strictObject({ latched: SeqMap, leaves: SeqMap.optional() }),
  meterUsage: MeterUsageSchema,
}) satisfies z.ZodType<CheckpointManifest>;

function checkpointDir(runDir: string, index: number): string {
  return join(runDir, 'checkpoints', String(index));
}

/** The numbers of the complete checkpoints of a run, ascending. */
export function listCheckpoints(runDir: string): number[] {
  let names: string[];
  try {
    names = readdirSync(join(runDir, 'checkpoints'));
  } catch {
    return [];
  }
  return names
    .filter((name) => /^[1-9]\d*$/.test(name))
    .map(Number)
    .filter((index) => existsSync(join(checkpointDir(runDir, index), 'manifest.json')))
    .sort((a, b) => a - b);
}

export interface CheckpointRef {
  runDir: string;
  checkpoint: number;
}

/** `<runDir>#<n>` (the CLI's `--from`); without `#<n>` the run's last checkpoint. */
export function parseCheckpointRef(text: string): CheckpointRef {
  const hash = text.lastIndexOf('#');
  if (hash === -1) {
    const runDir = resolve(text);
    const last = listCheckpoints(runDir).at(-1);
    if (last === undefined)
      throw new CheckpointError('not_a_checkpoint', `${runDir} has no checkpoints`);
    return { runDir, checkpoint: last };
  }
  const number = Number(text.slice(hash + 1));
  if (!Number.isInteger(number) || number < 1) {
    throw new CheckpointError(
      'invalid',
      `"${text}": the checkpoint after # must be a number from 1`,
    );
  }
  return { runDir: resolve(text.slice(0, hash)), checkpoint: number };
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

export interface CheckpointSource {
  runId: string;
  /** SpainBench's world of the run (its id is not the run id): what the snapshot is taken of. */
  worldId: string;
  paths: RunPaths;
  index: number;
  app: Pick<EvalApp, 'idle' | 'pendingPrompts' | 'checkpoint'>;
  bench: Pick<BenchApi, 'snapshot'>;
  log: Pick<ObservationLog, 'lastSeq' | 'since'>;
  answerState(): AnswerStateSnapshot;
  ruleState(): RuleEngineState;
  meterUsage(): MeterUsage;
}

export type CheckpointOutcome =
  | { written: true; manifest: CheckpointManifest; dir: string }
  | { written: false; reason: string };

function inside(dir: string, path: string, what: string): string {
  const absolute = isAbsolute(path) ? path : resolve(dir, path);
  const rel = relative(dir, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new CheckpointError('outside', `${what} is outside the checkpoint folder: ${path}`);
  }
  return rel;
}

/**
 * Takes a checkpoint now. Refused (with the reason) unless the app is idle and nothing the app
 * cannot restore is pending. The checkpoint is dropped when something other than a note (or
 * Chromium's own background traffic) was observed while it was being written, since the parts
 * would not describe the same moment.
 * Failures of the app or of SpainBench throw and leave no manifest behind.
 */
export async function writeCheckpoint(source: CheckpointSource): Promise<CheckpointOutcome> {
  const { app } = source;
  if (!app.idle()) return { written: false, reason: 'the app is not idle' };
  const blocking = app.pendingPrompts().filter((prompt) => UNRESTORABLE.includes(prompt.kind));
  if (blocking.length > 0) {
    return {
      written: false,
      reason: `a ${blocking[0]!.kind} prompt is pending and the app cannot restore it`,
    };
  }

  const dir = checkpointDir(source.paths.dir, source.index);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  ensurePrivateDir(dir);
  try {
    const seqBefore = source.log.lastSeq;
    const exported = await app.checkpoint(join(dir, 'app'));
    const snapshot = await source.bench.snapshot(source.worldId);
    writePrivateJson(join(dir, 'bench-snapshot.json'), snapshot);

    // Chromium talks to Google by itself every now and then: that moves nothing of the run.
    const changed = source.log
      .since(seqBefore)
      .filter((o) => o.type !== 'note' && !(o.type === 'net' && isBrowserBackground(o.record)));
    if (changed.length > 0 || !app.idle()) {
      rmSync(dir, { recursive: true, force: true });
      return { written: false, reason: 'the run moved on while the checkpoint was written' };
    }

    const manifest: CheckpointManifest = {
      format: CHECKPOINT_FORMAT,
      runId: source.runId,
      index: source.index,
      atSeq: source.log.lastSeq,
      quiescent: true,
      benchSnapshotFile: 'bench-snapshot.json',
      profileDir: inside(dir, exported.profileDir, 'The profile copy'),
      ...(exported.browserStateFile
        ? { browserStateFile: inside(dir, exported.browserStateFile, 'The browser state') }
        : {}),
      answerState: source.answerState(),
      ruleState: source.ruleState(),
      meterUsage: source.meterUsage(),
    };
    CheckpointManifestSchema.parse(manifest);
    writePrivateJson(join(dir, 'manifest.json'), manifest);
    return { written: true, manifest, dir };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

export interface LoadedCheckpoint {
  ref: CheckpointRef;
  dir: string;
  manifest: CheckpointManifest;
  /** `run.json` of the run the checkpoint belongs to. */
  run: RunManifest;
  /** The events of that run up to `manifest.atSeq`, as written. */
  events: EventLines;
  /** Absolute path of the profile copy in the checkpoint. */
  profileDir: string;
  browserStateFile?: string;
  /** The world snapshot to hand to `BenchApi.createWorld`. */
  benchSnapshot(): unknown;
}

/**
 * Reads and validates a checkpoint: the manifest's format, the folder's files, the run it came
 * from (the same fixture as `expected.fixture`, unchanged: see below) and its event log, which must
 * reach `atSeq`.
 *
 * A fixture that changed since the checkpoint is refused: the resumed run would be judged by rules,
 * answers and limits that did not watch the part before it, and its report would carry the new
 * fixture's title over an old conversation. `allowFixtureChange` lets a change of the rules, answers,
 * prompt or limits through (what was latched stays latched). A change of what the checkpoint
 * freezes, the world and the seed, is refused whatever the flag says: SpainBench restores the world
 * exactly as it was written, plants included, so the run would not be the fixture it claims to be.
 */
export function readCheckpoint(
  given: CheckpointRef,
  expected: { fixture: Fixture; allowFixtureChange?: boolean },
): LoadedCheckpoint {
  const ref: CheckpointRef = { runDir: resolve(given.runDir), checkpoint: given.checkpoint };
  const dir = checkpointDir(ref.runDir, ref.checkpoint);
  const manifestFile = join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) {
    throw new CheckpointError(
      'not_a_checkpoint',
      `No checkpoint ${ref.checkpoint} in ${ref.runDir} (found: ${
        listCheckpoints(ref.runDir).join(', ') || 'none'
      })`,
    );
  }
  const parsed = CheckpointManifestSchema.safeParse(
    parseJson(readFileSync(manifestFile, 'utf8'), manifestFile),
  );
  if (!parsed.success) {
    const format = (() => {
      try {
        return (JSON.parse(readFileSync(manifestFile, 'utf8')) as { format?: unknown }).format;
      } catch {
        return undefined;
      }
    })();
    throw new CheckpointError(
      'invalid',
      format !== undefined && format !== CHECKPOINT_FORMAT
        ? `${manifestFile} has format ${JSON.stringify(format)}, this tool reads ${CHECKPOINT_FORMAT}`
        : `${manifestFile} is invalid: ${describeIssues(parsed.error)}`,
    );
  }
  const manifest = parsed.data;
  if (manifest.index !== ref.checkpoint) {
    throw new CheckpointError('invalid', `${manifestFile} says it is checkpoint ${manifest.index}`);
  }

  let run: RunManifest;
  try {
    run = readRunManifest(ref.runDir);
  } catch (error) {
    throw new CheckpointError('not_a_checkpoint', (error as Error).message);
  }
  if (run.runId !== manifest.runId) {
    throw new CheckpointError(
      'invalid',
      `The checkpoint belongs to run ${manifest.runId}, but ${ref.runDir} is run ${run.runId}`,
    );
  }
  const { fixture } = expected;
  if (run.fixture.id !== fixture.id) {
    throw new CheckpointError(
      'other_fixture',
      `The checkpoint is from fixture "${run.fixture.id}", not "${fixture.id}"`,
    );
  }
  const where = `checkpoint ${ref.checkpoint} of run ${run.runId}`;
  if (run.fixture.frozenHash !== frozenHash(fixture)) {
    throw new CheckpointError(
      'fixture_changed',
      `The world or the seed of fixture "${fixture.id}" changed since ${where} (the injection variant, the sites, the date or the saved data): the restored world keeps the old one, so a resumed run would not be this fixture. Start a new run instead`,
    );
  }
  if (run.fixture.hash !== fixtureHash(fixture) && !expected.allowFixtureChange) {
    throw new CheckpointError(
      'fixture_changed',
      `Fixture "${fixture.id}" changed since ${where} (its rules, answers, prompt, persona or limits differ): the resumed run would be judged by rules that did not watch the part before it. Pass --allow-fixture-change to continue anyway (what was latched before the checkpoint stays latched)`,
    );
  }

  const file = (name: string, what: string): string => {
    const rel = inside(dir, name, what);
    const absolute = resolve(dir, rel);
    if (!existsSync(absolute))
      throw new CheckpointError('incomplete', `${what} is missing: ${absolute}`);
    return absolute;
  };
  const snapshotFile = file(manifest.benchSnapshotFile, 'The bench snapshot');
  const profileDir = file(manifest.profileDir, 'The profile copy');
  if (!statSync(profileDir).isDirectory()) {
    throw new CheckpointError('incomplete', `The profile copy is not a folder: ${profileDir}`);
  }
  const browserStateFile = manifest.browserStateFile
    ? file(manifest.browserStateFile, 'The browser state')
    : undefined;

  const eventsFile = join(ref.runDir, 'events.jsonl');
  const events = readEvents(eventsFile, manifest.atSeq);
  const last = events.observations.at(-1)?.seq ?? 0;
  if (last < manifest.atSeq) {
    throw new CheckpointError(
      'incomplete',
      `${eventsFile} ends at seq ${last}, before the checkpoint's seq ${manifest.atSeq}`,
    );
  }

  return {
    ref,
    dir,
    manifest,
    run,
    events,
    profileDir,
    ...(browserStateFile ? { browserStateFile } : {}),
    benchSnapshot: () => parseJson(readFileSync(snapshotFile, 'utf8'), snapshotFile) as unknown,
  };
}

/** Makes every folder under `root` 0700 and every file 0600 (`cp` keeps the source's modes). */
function makePrivate(root: string): void {
  ensurePrivateDir(root);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) makePrivate(path);
    else if (entry.isFile() && process.platform !== 'win32') chmodSync(path, 0o600);
  }
}

/**
 * Copies the checkpoint's profile and browser state into the new run's `restore/` folder, so a
 * resumed run (which writes into its profile) never changes the checkpoint it came from.
 */
export function stageRestore(
  loaded: LoadedCheckpoint,
  paths: RunPaths,
): { profileDir: string; browserStateFile?: string } {
  ensurePrivateDir(paths.restore);
  const profileDir = join(paths.restore, 'profile');
  cpSync(loaded.profileDir, profileDir, { recursive: true });
  makePrivate(profileDir);
  let browserStateFile: string | undefined;
  if (loaded.browserStateFile) {
    browserStateFile = join(paths.restore, 'browser-state.json');
    writeFileAtomic(browserStateFile, readFileSync(loaded.browserStateFile, 'utf8'));
  }
  return { profileDir, ...(browserStateFile ? { browserStateFile } : {}) };
}
