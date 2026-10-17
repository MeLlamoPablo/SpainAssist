/**
 * How the run loop launches an eval host: the product's `buildAgentLaunch` with the eval host
 * bundle as `hostPath` and the config file in the environment.
 *
 *   const launch = buildAgentLaunch({
 *     nodeBinary: process.execPath, electronRunAsNode: false,   // plain Node: no Electron in the eval
 *     cwd, config, bridge,                                      // as the app does for its agents
 *     ...evalHostLaunch(configFile),                            // hostPath, extraEnv, inheritEnv
 *   });
 *
 * The bundle must be built first (`corepack pnpm --filter @sa/eval build:host`).
 */
import { fileURLToPath } from 'node:url';
import type { AgentLaunchOptions } from '@sa/agent';
import { EVAL_CONFIG_ENV } from './config';

/** Absolute path of `dist/eval-host.js`. */
export function evalHostPath(): string {
  return fileURLToPath(new URL('../../dist/eval-host.js', import.meta.url));
}

/**
 * What the host's environment may inherit from the harness: what Node needs to find its temp
 * folder and system libraries, and the locale. Never proxies or certificate settings (the host
 * reaches nothing but the model gateway and the mock), and never keys or `NODE_OPTIONS`.
 */
const INHERITED = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'TZ',
] as const;

/**
 * The `buildAgentLaunch` options that turn the product launch into an eval host launch. Use one
 * config file (and net log) per host process: the assistant and every procedure agent are separate
 * processes and `seq` numbers the records of one log.
 */
export function evalHostLaunch(
  configFile: string,
  source: Record<string, string | undefined> = process.env,
): Required<Pick<AgentLaunchOptions, 'hostPath' | 'extraEnv' | 'inheritEnv'>> {
  const inheritEnv: Record<string, string | undefined> = {};
  for (const key of INHERITED) inheritEnv[key] = source[key];
  return {
    hostPath: evalHostPath(),
    extraEnv: { [EVAL_CONFIG_ENV]: configFile },
    inheritEnv,
  };
}
