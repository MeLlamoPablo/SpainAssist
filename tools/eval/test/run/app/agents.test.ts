/**
 * The launch of an agent host as the app asks for it: what the run changes in the config, the host
 * config it writes and the environment the host gets. No process is started.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentHostConfig, AgentLaunchOptions } from '@sa/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  EvalAppDeps,
  EvalAppSpec,
  HostEvalConfig,
  ResearchAnswer,
} from '../../../src/contracts';
import { HostTable } from '../../../src/net';
import {
  AgentFleet,
  type AgentFleetOptions,
  type AgentIdentity,
  agentKeyOf,
} from '../../../src/run/app/agents';
import { COLLECTOR, IDP, PORTAL } from './support';

const research: ResearchAnswer = {
  id: '95bf65c0-52a4-4bca-b05f-e48b200311b3',
  output: { type: 'text', content: 'respuesta', basis: [] },
};

let root: string;
let launched: AgentIdentity[];
let halted: boolean;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sa-fleet-'));
  launched = [];
  halted = false;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fleet(over: { now?: string; origin?: string } = {}): AgentFleet {
  const spec = {
    runDir: root,
    bench: {
      publicOrigin: over.origin ?? 'http://127.0.0.1:4010',
      scoringOrigin: 'http://127.0.0.1:4020',
      hosts: [],
      worldId: 'run-fleet',
    },
    now: over.now ?? '2026-10-16T10:00:00+02:00',
  } as unknown as EvalAppSpec;
  const deps = {
    meter: { agentBaseUrl: (key: string) => `http://127.0.0.1:4000/r/tok/a/${key}/v1` },
  } as unknown as EvalAppDeps;
  const options: AgentFleetOptions = {
    spec,
    deps,
    hosts: new HostTable([
      { pattern: PORTAL, kind: 'site' },
      { pattern: IDP, kind: 'site' },
      { pattern: COLLECTOR, kind: 'collector' },
    ]),
    research,
    hostBundle: '/bundle/eval-host.js',
    onLaunch: (identity) => launched.push(identity),
    onEvent: () => {},
    onOperation: () => {},
    aborted: () => halted,
  };
  return new AgentFleet(options);
}

const config = (over: Partial<AgentHostConfig> = {}): AgentHostConfig => ({
  role: 'procedure',
  procedureId: 'p_00000000000000aa',
  sessionFile: join(root, 'procedures', 'p_00000000000000aa', 'session.jsonl'),
  language: 'es',
  model: {
    provider: 'litellm',
    id: 'anthropic/claude-haiku-5.5',
    baseUrl: 'https://gateway.example/v1',
    maxTokens: 8192,
  },
  research: {
    keyServerUrl: 'http://key-server.eval.invalid',
    exa: true,
    exaBaseUrl: 'https://exa.example',
    boeBaseUrl: 'https://boe.example',
    allowPrivateHosts: true,
  },
  extraTrustedHosts: [],
  dniePhone: false,
  ...over,
});

const options = (c: AgentHostConfig): AgentLaunchOptions => ({
  nodeBinary: '/usr/bin/electron',
  electronRunAsNode: true,
  cwd: join(root, 'work'),
  config: c,
  bridge: { url: 'http://127.0.0.1:5000', token: 'bridge-token' },
  hostPath: '/product/host.js',
  inheritEnv: { PATH: '/usr/bin', HOME: '/home/x', HTTPS_PROXY: 'http://proxy.example:3128' },
  extraEnv: { NODE_OPTIONS: '--inspect' },
});

const sentConfig = (launch: { env: Record<string, string> }) =>
  JSON.parse(launch.env.SA_AGENT_CONFIG as string) as AgentHostConfig;

describe('the launch of an agent host', () => {
  it('runs the eval host bundle with plain Node, not the product host with Electron', () => {
    const launch = fleet().lib.buildAgentLaunch(options(config()));
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(['/bundle/eval-host.js']);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("points the model at the meter under the agent's own key, keeping the rest of its config", () => {
    const f = fleet();
    const procedure = sentConfig(f.lib.buildAgentLaunch(options(config())));
    expect(procedure.model).toEqual({
      provider: 'litellm',
      id: 'anthropic/claude-haiku-5.5',
      baseUrl: 'http://127.0.0.1:4000/r/tok/a/procedure-p_00000000000000aa/v1',
      maxTokens: 8192,
    });
    const assistant = sentConfig(
      f.lib.buildAgentLaunch(
        options(
          config({
            role: 'assistant',
            procedureId: 'assistant',
            model: { provider: 'litellm', id: 'm', baseUrl: 'https://g/v1', thinkingLevel: 'high' },
          }),
        ),
      ),
    );
    expect(assistant.model).toMatchObject({
      baseUrl: 'http://127.0.0.1:4000/r/tok/a/assistant/v1',
      thinkingLevel: 'high',
    });
    expect(assistant.role).toBe('assistant');
    expect(procedure.language).toBe('es');
    expect(procedure.dniePhone).toBe(false);
  });

  it('strips every research URL and key and turns idle compaction off', () => {
    const sent = sentConfig(fleet().lib.buildAgentLaunch(options(config())));
    expect(sent.research).toEqual({});
    expect(JSON.stringify(sent)).not.toMatch(/key-server|exa|boe\.example|allowPrivateHosts/);
    expect(sent.idleCompaction).toEqual({ minTokens: Number.MAX_SAFE_INTEGER });
  });

  it('writes the host config of the process: the world, its own net log, the research and the clock', () => {
    const launch = fleet().lib.buildAgentLaunch(options(config()));
    const file = join(root, 'host', 'procedure-p_00000000000000aa.json');
    expect(launch.env.SA_EVAL_CONFIG).toBe(file);
    const written = JSON.parse(readFileSync(file, 'utf8')) as HostEvalConfig;
    expect(written).toEqual({
      worldId: 'run-fleet',
      mockOrigin: 'http://127.0.0.1:4010',
      scoringOrigin: 'http://127.0.0.1:4020',
      routes: [PORTAL, IDP, COLLECTOR],
      unmapped: { mode: 'enotfound' },
      netlog: join(root, 'net', 'host-procedure-p_00000000000000aa.jsonl'),
      llm: { extraAllowOrigins: [] },
      research: { shape: 'auto', answers: [research] },
      now: '2026-10-16T10:00:00+02:00',
    });
    expect(launched).toEqual([
      {
        agentKey: 'procedure-p_00000000000000aa',
        agent: 'procedure',
        procedureId: 'p_00000000000000aa',
        sessionFile: config().sessionFile,
        generation: 1,
        netlog: written.netlog,
        configFile: file,
      },
    ]);
  });

  it('gives each launch of the same agent its own config file and net log (seq numbers one process)', () => {
    const f = fleet();
    f.lib.buildAgentLaunch(options(config()));
    f.lib.buildAgentLaunch(options(config()));
    f.lib.buildAgentLaunch(options(config()));
    expect(
      launched.map((l) => [
        l.generation,
        l.netlog.split('/').at(-1),
        l.configFile.split('/').at(-1),
      ]),
    ).toEqual([
      [1, 'host-procedure-p_00000000000000aa.jsonl', 'procedure-p_00000000000000aa.json'],
      [2, 'host-procedure-p_00000000000000aa-2.jsonl', 'procedure-p_00000000000000aa-2.json'],
      [3, 'host-procedure-p_00000000000000aa-3.jsonl', 'procedure-p_00000000000000aa-3.json'],
    ]);
    // Another agent starts at 1.
    f.lib.buildAgentLaunch(options(config({ role: 'assistant', procedureId: 'assistant' })));
    expect(launched.at(-1)).toMatchObject({ agentKey: 'assistant', generation: 1 });
  });

  it('gives the host an environment with no proxy, no NODE_OPTIONS, and loopback excluded from any proxy', () => {
    const launch = fleet().lib.buildAgentLaunch(options(config()));
    expect(launch.env.HTTPS_PROXY).toBeUndefined();
    expect(launch.env.HTTP_PROXY).toBeUndefined();
    expect(launch.env.NODE_OPTIONS).toBe('--inspect');
    expect(launch.env.NO_PROXY).toBe('127.0.0.1,localhost,::1');
    expect(launch.env.no_proxy).toBe('127.0.0.1,localhost,::1');
    expect(launch.env.SA_BRIDGE_URL).toBe('http://127.0.0.1:5000');
    expect(launch.env.PI_OFFLINE).toBe('1');
  });

  it('refuses to start an agent once the run is halted', () => {
    const f = fleet();
    const launch = f.lib.buildAgentLaunch(options(config()));
    halted = true;
    expect(() => f.lib.buildAgentLaunch(options(config()))).toThrow(/aborted/);
    expect(() => f.lib.createClient(launch)).toThrow(/aborted/);
    expect(launched).toHaveLength(1);
  });

  it('only makes clients for launches it made', () => {
    const f = fleet();
    expect(() => f.lib.createClient({ command: 'x', args: [], env: {}, cwd: root })).toThrow(
      /did not make/,
    );
    const client = f.lib.createClient(f.lib.buildAgentLaunch(options(config())));
    expect(client.running).toBe(false);
    expect(f.active).toBe(0);
  });
});

describe('validate', () => {
  it('accepts a world a host can be configured with', () => {
    expect(() => fleet().validate()).not.toThrow();
  });

  it('refuses a clock without its offset and a mock that is not on this machine', () => {
    expect(() => fleet({ now: '2026-10-16T10:00:00' }).validate()).toThrow(
      /Invalid eval host config/,
    );
    expect(() => fleet({ origin: 'http://mock.example:3010' }).validate()).toThrow(
      /Invalid eval host config/,
    );
  });
});

describe('agentKeyOf', () => {
  it('is the key the meter knows an agent by', () => {
    expect(agentKeyOf('assistant')).toBe('assistant');
    expect(agentKeyOf('p_00000000000000aa')).toBe('procedure-p_00000000000000aa');
  });
});
