import { randomBytes } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir } from './home';

/**
 * Cross-process mutual exclusion for the files whose single-use secrets rotate (`codex.json`).
 *
 * The lock is a directory `L` and the arbiter is the file `L/owner.json` ({ id, pid, startedAt }):
 * whoever creates it holds the lock. It is created complete and atomically (written to a temp file
 * and hard-linked into place, which fails if the file exists), so there is no moment at which a
 * lock exists without an owner, and an empty directory is a free lock.
 *
 * A holder that died (SIGKILL, power) leaves its `owner.json` behind. The lock is stale when the
 * owner's process is gone or the record is older than `staleMs` (the pid may have been reused), or
 * when the file is unreadable and older than `staleMs`. Taking over a stale lock is the dangerous
 * step: a contender that judged the lock stale and was then delayed must never remove the live
 * lock that somebody else created after it. So a takeover goes through a claim keyed by the
 * identity of the stale owner (`L.break-<id>`, an exclusive `mkdir`): only one contender holds the
 * claim of a given dead owner, it re-reads the owner after getting the claim, and removes
 * `owner.json` only if it is still that same owner and still stale. Anyone who finds the owner
 * changed leaves the lock alone. A claim abandoned by a contender that died in the middle expires
 * by age. Residual risk, accepted: two contenders that break such an expired claim within the
 * same millisecond, which needs a process killed inside a microsecond window first.
 *
 * Releasing removes `owner.json` only if it is still ours, never throws (an error of the section
 * or its result must not be replaced by a failed cleanup) and removes the directory when it is
 * empty. Inside one process, callers queue on a promise chain instead of polling the directory.
 */

export interface LockOptions {
  /** Give up waiting after this long (default 30 s). */
  timeoutMs?: number;
  /** A lock older than this is considered abandoned (default 60 s). */
  staleMs?: number;
  /** Poll interval base; jittered (default 40 ms). */
  pollMs?: number;
  /** Tests: the clock used for staleness. */
  now?: () => number;
}

export class LockTimeoutError extends Error {
  constructor(readonly lockDir: string) {
    super(`Timed out waiting for the lock ${lockDir} (held by another eval process)`);
    this.name = 'LockTimeoutError';
  }
}

interface Owner {
  id: string;
  pid: number;
  startedAt: number;
}

type Holder =
  | { kind: 'free' }
  | { kind: 'owner'; owner: Owner }
  /** `owner.json` exists but is not a valid record. */
  | { kind: 'unreadable'; mtimeMs: number };

/** How long a contender may keep a break claim; it needs microseconds. */
const CLAIM_TTL_MS = 10_000;
const UNREADABLE = 'unreadable';

const queues = new Map<string, Promise<unknown>>();

const ownerFile = (lockDir: string) => join(lockDir, 'owner.json');

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return errorCode(error) === 'EPERM';
  }
}

function inspect(lockDir: string): Holder {
  const file = ownerFile(lockDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'free' };
    throw error;
  }
  try {
    const owner = JSON.parse(text) as Partial<Owner>;
    if (
      typeof owner.id === 'string' &&
      typeof owner.pid === 'number' &&
      typeof owner.startedAt === 'number'
    ) {
      return { kind: 'owner', owner: owner as Owner };
    }
  } catch {
    // Not JSON: unreadable, judged by the age of the file.
  }
  try {
    return { kind: 'unreadable', mtimeMs: statSync(file).mtimeMs };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'free' };
    throw error;
  }
}

/** The identity of the holder when it is stale, undefined when it is free or still holding. */
function staleIdentity(holder: Holder, staleMs: number, now: number): string | undefined {
  if (holder.kind === 'owner') {
    const { owner } = holder;
    return now - owner.startedAt > staleMs || !pidAlive(owner.pid) ? owner.id : undefined;
  }
  if (holder.kind === 'unreadable') {
    return now - holder.mtimeMs > staleMs ? UNREADABLE : undefined;
  }
  return undefined;
}

/**
 * What came of trying to become the holder: `created` (`owner.json` is ours), `held` (somebody
 * else's `owner.json` is there) or `vanished` (the directory was removed under us by its last
 * holder, which was releasing; the caller simply tries again). The platforms report a vanished
 * directory differently (ENOENT, and EINVAL on macOS), so those are not told apart from a real
 * error here: the caller gives up when it keeps happening.
 */
type Attempt = { kind: 'created' } | { kind: 'held' } | { kind: 'vanished'; error: unknown };

function tryCreate(lockDir: string, owner: Owner): Attempt {
  const temp = join(lockDir, `owner.${owner.id}.tmp`);
  try {
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    linkSync(temp, ownerFile(lockDir));
    return { kind: 'created' };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EEXIST') return { kind: 'held' };
    if (code === 'ENOENT' || code === 'EINVAL') return { kind: 'vanished', error };
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Consecutive times the directory may vanish under a contender before it is a real error. */
const MAX_VANISHED = 200;

/**
 * Removes the stale holder `identity`, if (after taking its claim) it is still that holder and
 * still stale. Returns whether the situation was settled, so the caller can try to create the lock
 * at once; false when another contender holds the claim and the caller should wait.
 */
function breakStale(
  lockDir: string,
  identity: string,
  staleMs: number,
  now: () => number,
): boolean {
  const claim = `${lockDir}.break-${identity}`;
  try {
    mkdirSync(claim, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    try {
      // Somebody else is breaking this lock. If they died doing it, the claim ages out.
      if (Date.now() - statSync(claim).mtimeMs > CLAIM_TTL_MS) {
        rmSync(claim, { recursive: true, force: true });
      }
    } catch {
      // The claim was released meanwhile.
    }
    return false;
  }
  try {
    const holder = inspect(lockDir);
    const current = holder.kind === 'owner' ? holder.owner.id : UNREADABLE;
    if (holder.kind === 'free' || current !== identity) return true;
    if (staleIdentity(holder, staleMs, now()) !== identity) return true;
    unlinkSync(ownerFile(lockDir));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  } finally {
    rmSync(claim, { recursive: true, force: true });
  }
  return true;
}

/** Removes our `owner.json` if it is still ours. Never throws. */
function release(lockDir: string, owner: Owner): void {
  try {
    const holder = inspect(lockDir);
    if (holder.kind === 'owner' && holder.owner.id === owner.id) unlinkSync(ownerFile(lockDir));
    // Only succeeds when nobody else is in the directory.
    rmdirSync(lockDir);
  } catch {
    // A failed cleanup must not replace the result or the error of the section; the lock then
    // ages out like one left by a crash.
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function acquire(lockDir: string, options: LockOptions): Promise<Owner> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const staleMs = options.staleMs ?? 60_000;
  const pollMs = options.pollMs ?? 40;
  const deadline = Date.now() + timeoutMs;
  ensurePrivateDir(join(lockDir, '..'));
  let vanished = 0;
  for (;;) {
    const owner: Owner = {
      id: randomBytes(8).toString('hex'),
      pid: process.pid,
      startedAt: now(),
    };
    const attempt = tryCreate(lockDir, owner);
    if (attempt.kind === 'created') return owner;
    vanished = attempt.kind === 'vanished' ? vanished + 1 : 0;
    if (attempt.kind === 'vanished' && vanished > MAX_VANISHED) throw attempt.error;
    const holder = inspect(lockDir);
    const stale = staleIdentity(holder, staleMs, now());
    // Something changed (the lock was free, or a stale holder was dealt with): try again at once.
    const settled =
      holder.kind === 'free' || (stale !== undefined && breakStale(lockDir, stale, staleMs, now));
    if (Date.now() >= deadline) throw new LockTimeoutError(lockDir);
    if (!settled) await sleep(pollMs / 2 + Math.random() * pollMs);
  }
}

/** Runs `fn` while holding the lock `lockDir`; the lock is always released. */
export function withFileLock<T>(
  lockDir: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {},
): Promise<T> {
  const task = async (): Promise<T> => {
    const owner = await acquire(lockDir, options);
    try {
      return await fn();
    } finally {
      release(lockDir, owner);
    }
  };
  const previous = queues.get(lockDir) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => {});
  queues.set(lockDir, tail);
  void tail.then(() => {
    if (queues.get(lockDir) === tail) queues.delete(lockDir);
  });
  return run;
}
