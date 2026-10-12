import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_ENV } from '@sa/shared';
import { type AgentHostConfig, AgentHostConfigSchema } from './config';

export interface AgentLaunchOptions {
  /** Electron binary (process.execPath) or a Node binary. */
  nodeBinary: string;
  /** Set ELECTRON_RUN_AS_NODE=1 (true when nodeBinary is Electron). */
  electronRunAsNode: boolean;
  /** Working directory for the agent (an empty, app-owned directory per procedure). */
  cwd: string;
  config: AgentHostConfig;
  bridge: { url: string; token: string };
  /** pi's private config dir (PI_CODING_AGENT_DIR). Default `<cwd>/pi-agent`. Nothing is written there today. */
  agentDir?: string;
  /** Path of dist/host.js. Default: agentHostPath(). Pass it when the package is bundled into the app. */
  hostPath?: string;
  /** Environment to inherit the allow-listed variables from. Default process.env. */
  inheritEnv?: Record<string, string | undefined>;
  /** Extra NON-SECRET variables (e.g. NODE_OPTIONS for debugging). */
  extraEnv?: Record<string, string>;
}

export interface AgentLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/**
 * Only these variables are inherited by the agent process (no API keys, no NODE_OPTIONS):
 * what Node needs to find temp dirs and system libraries, locale/time zone, and proxies.
 */
export const INHERITED_ENV_VARS = [
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
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

/**
 * Absolute path of the bundled host script (dist/host.js). Override with SA_AGENT_HOST_PATH, or
 * pass `hostPath` to buildAgentLaunch when @sa/agent is bundled into the app (import.meta.url
 * then points at the app bundle).
 */
export function agentHostPath(): string {
  const fromEnv = process.env.SA_AGENT_HOST_PATH;
  if (fromEnv) return resolve(fromEnv);
  return fileURLToPath(new URL('../dist/host.js', import.meta.url));
}

/**
 * How to spawn one agent host. The transport (stdio JSONL) is hidden behind PiRpcClient's
 * RpcTransport, so a hardened build can later run the host with Electron's utilityProcess.
 */
export function buildAgentLaunch(opts: AgentLaunchOptions): AgentLaunch {
  const parsed = AgentHostConfigSchema.safeParse(opts.config);
  if (!parsed.success) throw new Error(`Invalid agent config: ${parsed.error.message}`);
  if (!isAbsolute(opts.cwd)) throw new Error('cwd must be an absolute path');
  const config = parsed.data;
  const source = opts.inheritEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_VARS) {
    const value = source[key];
    if (value) env[key] = value;
  }
  Object.assign(env, opts.extraEnv ?? {}, {
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    PI_SKIP_VERSION_CHECK: '1',
    PI_CODING_AGENT_DIR: resolve(opts.agentDir ?? join(opts.cwd, 'pi-agent')),
    [BRIDGE_ENV.url]: opts.bridge.url,
    [BRIDGE_ENV.token]: opts.bridge.token,
    [BRIDGE_ENV.procedureId]: config.procedureId,
    [BRIDGE_ENV.language]: config.language,
    [BRIDGE_ENV.config]: JSON.stringify({ ...config, sessionFile: resolve(config.sessionFile) }),
  });
  if (opts.electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  return {
    command: opts.nodeBinary,
    args: [opts.hostPath ?? agentHostPath()],
    env,
    cwd: opts.cwd,
  };
}
