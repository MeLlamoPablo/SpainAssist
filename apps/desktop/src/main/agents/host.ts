import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { AgentLaunch } from '@sa/agent';

const PACKAGE = '@sa/agent';

function findPackageRoot(start: string): string | undefined {
  let dir = dirname(start);
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === PACKAGE)
          return dir;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Path of the agent host script (`@sa/agent` dist/host.js, built with
 * `corepack pnpm --filter @sa/agent build`). `@sa/agent` itself is bundled into main, so its own
 * `agentHostPath()` cannot be used: the package is resolved from the app instead.
 *   1. SA_AGENT_HOST (must exist)
 *   2. `agent-host/host.js` in the app (packaged: copied into app.asar by electron-builder.ts,
 *      next to the node_modules that hold its external imports)
 *   3. @sa/agent resolved from the app (dev: the workspace package)
 *   4. the monorepo layout next to the app (apps/desktop -> packages/agent)
 */
export function resolveAgentHostScript(opts: {
  override?: string;
  /** import.meta.url of the main bundle. */
  fromUrl: string;
  /** app.getAppPath() */
  appPath?: string;
}): string {
  if (opts.override) {
    const path = resolve(opts.override);
    if (!existsSync(path)) throw new Error(`SA_AGENT_HOST does not exist: ${path}`);
    return path;
  }
  const candidates: string[] = opts.appPath ? [join(opts.appPath, 'agent-host', 'host.js')] : [];
  try {
    const req = createRequire(opts.fromUrl);
    try {
      candidates.push(join(dirname(req.resolve(`${PACKAGE}/package.json`)), 'dist', 'host.js'));
    } catch {
      // "exports" may not expose package.json
    }
    try {
      const root = findPackageRoot(req.resolve(PACKAGE));
      if (root) candidates.push(join(root, 'dist', 'host.js'));
    } catch {
      // not resolvable from here (packaged app)
    }
  } catch {
    // invalid fromUrl
  }
  if (opts.appPath) candidates.push(resolve(opts.appPath, '../../packages/agent/dist/host.js'));
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(
    `The agent host is not built. Run "corepack pnpm --filter @sa/agent build" (looked in: ${
      [...new Set(candidates)].join(', ') || 'nowhere'
    }).`,
  );
}

/**
 * Makes sure the launch runs `hostScript`: replaces the script argument chosen by
 * buildAgentLaunch (which cannot know where the app found the package).
 */
export function withHostScript(launch: AgentLaunch, hostScript: string): AgentLaunch {
  const index = launch.args.findIndex((a) => /\.(c|m)?js$/.test(a));
  if (index < 0) return { ...launch, args: [hostScript, ...launch.args] };
  if (launch.args[index] === hostScript) return launch;
  const args = [...launch.args];
  args[index] = hostScript;
  return { ...launch, args };
}
