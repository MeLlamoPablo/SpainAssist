/** Where the user's words point: run folders by path or by id, and the runs root. */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { defaultRunsRoot, isValidRunId } from '../run/results';

export function resolveRunsRoot(
  option: string | undefined,
  cwd: string,
  env: Record<string, string | undefined>,
): string {
  return option ? resolve(cwd, option) : defaultRunsRoot(env);
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The run folder an argument names: a path (relative ones against `cwd`), or a bare run id that
 * is looked up under `runsRoot` (then, failing that, in `cwd`). The answer may not exist: callers
 * say what is missing.
 */
export function resolveRunDir(arg: string, options: { cwd: string; runsRoot: string }): string {
  const bare = !/[\\/]/.test(arg) && isValidRunId(arg);
  if (bare) {
    const inRoot = join(options.runsRoot, arg);
    if (isDirectory(inRoot)) return inRoot;
    const inCwd = resolve(options.cwd, arg);
    return isDirectory(inCwd) ? inCwd : inRoot;
  }
  return isAbsolute(arg) ? arg : resolve(options.cwd, arg);
}

/**
 * `--from <runDir>#<n>` with the run folder as a path or a bare run id (`resolveRunDir`) and `#<n>`
 * optional. Returns the text `parseCheckpointRef` reads: an absolute folder, `#<n>` when given.
 */
export function resolveFromArgument(
  text: string,
  options: { cwd: string; runsRoot: string },
): string {
  const hash = text.lastIndexOf('#');
  const folder = hash === -1 ? text : text.slice(0, hash);
  const suffix = hash === -1 ? '' : text.slice(hash);
  return `${resolveRunDir(folder, options)}${suffix}`;
}

/** Whether `dir` holds a file (for the messages that say what a run folder is missing). */
export function hasFile(dir: string, name: string): boolean {
  return existsSync(join(dir, name));
}
