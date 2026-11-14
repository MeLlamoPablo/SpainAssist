/**
 * The eval host bundle (`dist/eval-host.js`), run the way the harness runs it: a child process
 * built by the product's `buildAgentLaunch` (plus `evalHostLaunch`) and driven over pi's RPC
 * protocol by `PiRpcClient`, with `tools/mock-llm` as the model gateway, a fake bridge as the app
 * and a fake world as SpainBench. Everything is on 127.0.0.1; the hostnames the agent uses are
 * `.test` names (and `www.boe.es`, which the world serves: the bundle never resolves a name).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEvent,
  type AgentHostConfig,
  buildAgentLaunch,
  COORDINATOR_TOOL_NAMES,
  PiRpcClient,
} from '@sa/agent';
import { type ChatRequest, createMockLlm, type MockLlm, type ScenarioInput } from '@sa/mock-llm';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeBridge,
  type FakeBridge,
  workflowHandlers,
} from '../../../../packages/agent/test/helpers/fake-bridge';
import type { HostEvalConfig, NetRecord } from '../../src/contracts';
import { evalHostLaunch, evalHostPath, writeHostEvalConfig } from '../../src/host';
import { readNetLog } from '../../src/net/netlog-reader';
import {
  BOE,
  BOE_LAW_ID,
  COLLECTOR,
  type FakeWorld,
  SEDE,
  SEDE_PAGE_TEXT,
  startFakeWorld,
  UNMAPPED,
} from './fake-world';
import { hostConfig, recordedAnswer } from './support';

const packageRoot = join(import.meta.dirname, '..', '..');
const agentRoot = join(packageRoot, '..', '..', 'packages', 'agent');
const evalHost = evalHostPath();
const probeHost = join(packageRoot, 'dist', `test-probe-host-${process.pid}.js`);
const productHost = join(agentRoot, 'dist', 'host.js');

beforeAll(async () => {
  execFileSync(process.execPath, [join(packageRoot, 'scripts', 'build-eval-host.mjs')], {
    stdio: 'pipe',
  });
  execFileSync(process.execPath, [join(agentRoot, 'scripts', 'build-host.mjs')], { stdio: 'pipe' });
  // The test entry is bundled like the eval host, beside it (pi, typebox and the canvas resolve
  // from this package).
  await build({
    absWorkingDir: packageRoot,
    entryPoints: ['test/host/probe-host.ts'],
    outfile: probeHost,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@earendil-works/*', 'typebox', 'typebox/*', '@napi-rs/canvas'],
    banner: {
      js: "import { createRequire as __saCreateRequire } from 'node:module'; const require = __saCreateRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
}, 120_000);

afterAll(() => {
  rmSync(probeHost, { force: true });
});

describe('the two host bundles', () => {
  it('keep the eval hooks out of the product host, which has none to enable', () => {
    const product = readFileSync(productHost, 'utf8');
    const evalBundle = readFileSync(evalHost, 'utf8');
    const markers = [
      'SA_EVAL_CONFIG',
      'x-spainbench-world',
      'createWorldFetch',
      'createEgressGuard',
      'research.invalid',
      'HostEvalConfig',
    ];
    for (const marker of markers) {
      expect(evalBundle, `the eval host has ${marker}`).toContain(marker);
      expect(product, `the product host has no ${marker}`).not.toContain(marker);
    }
    expect(product).not.toMatch(/spainbench|sa-eval|eval-host|SA_TEST_HOOKS/i);
    const { sources } = JSON.parse(readFileSync(`${productHost}.map`, 'utf8')) as {
      sources: string[];
    };
    expect(sources.filter((source) => /tools\/eval/.test(source))).toEqual([]);
    const evalSources = (
      JSON.parse(readFileSync(`${evalHost}.map`, 'utf8')) as { sources: string[] }
    ).sources;
    expect(evalSources.some((source) => source.endsWith('src/host/eval-main.ts'))).toBe(true);
    // Nothing that needs a browser or Electron is in the host process.
    expect(evalSources.filter((source) => /playwright|electron|eval-network/.test(source))).toEqual(
      [],
    );
  });
});

describe('the eval host over RPC', () => {
  let llm: MockLlm;
  let bridge: FakeBridge;
  let world: FakeWorld;
  let workDir: string;
  let netlog: string;
  let configFile: string;
  let clients: PiRpcClient[];
  let unlisted: { server: Server; origin: string; hits: string[] };

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'sa-eval-host-it-'));
    netlog = join(workDir, 'net', 'host.jsonl');
    configFile = join(workDir, 'host-config.json');
    clients = [];
    llm = await createMockLlm({ scenario: { fallback: { text: 'Hecho.' } }, chunkSize: 16 });
    world = await startFakeWorld();
    bridge = await createFakeBridge({
      ...workflowHandlers(),
      'agent.credential': () => ({
        credential: { type: 'api_key', key: 'voucher-key-from-bridge' },
      }),
      'vault.read': () => ({ personal: [], documents: [], credentials: [] }),
    });
    // An origin that is neither the gateway nor the world: nothing may ever reach it.
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.end('reached');
    });
    server.on('upgrade', (req, socket) => {
      hits.push(`UPGRADE ${req.url}`);
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    unlisted = {
      server,
      origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      hits,
    };
  });

  afterEach(async () => {
    for (const client of clients) await client.stop();
    await llm.close();
    await bridge.close();
    await world.close();
    unlisted.server.closeAllConnections();
    await new Promise((resolve) => unlisted.server.close(resolve));
    rmSync(workDir, { recursive: true, force: true });
  });

  interface LaunchOptions {
    config?: Partial<HostEvalConfig>;
    agent?: Partial<AgentHostConfig>;
    hostPath?: string;
    extraEnv?: Record<string, string>;
    /** Leave the config file out of the environment. */
    withoutConfig?: boolean;
  }

  function launch(options: LaunchOptions = {}): PiRpcClient {
    writeHostEvalConfig(configFile, hostConfig(world.origin, netlog, options.config));
    const eval_ = evalHostLaunch(configFile);
    const client = new PiRpcClient(
      buildAgentLaunch({
        nodeBinary: process.execPath,
        electronRunAsNode: false,
        cwd: workDir,
        config: {
          role: 'agent',
          procedureId: 'a1',
          sessionFile: join(workDir, 'sessions', 'a1.jsonl'),
          language: 'es',
          // The voucher provider at the mock gateway: what voucher runs use, pointed at the meter.
          model: { provider: 'litellm', id: 'anthropic/claude-haiku-5.5', baseUrl: llm.baseUrl },
          ...options.agent,
        },
        bridge: { url: bridge.url, token: bridge.token },
        ...eval_,
        hostPath: options.hostPath ?? eval_.hostPath,
        extraEnv: {
          ...(options.withoutConfig ? {} : eval_.extraEnv),
          ...options.extraEnv,
        },
      }),
    );
    clients.push(client);
    return client;
  }

  async function start(options: LaunchOptions = {}) {
    const client = launch(options);
    const events: AgentEvent[] = [];
    client.on((event) => events.push(event));
    await client.start();
    return { client, events };
  }

  async function ask(started: Awaited<ReturnType<typeof start>>, text: string) {
    const from = started.events.length;
    await started.client.prompt(text);
    const deadline = Date.now() + 30_000;
    while (!started.events.slice(from).some((event) => event.type === 'run_end')) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for the run to end');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return started.events.slice(from);
  }

  const completions = () =>
    llm
      .requests()
      .filter((r) => r.path.endsWith('/chat/completions'))
      .map((r) => r.body as ChatRequest);
  /** Text of a message's content (Anthropic models get content parts with cache markers). */
  const textOf = (content: unknown): string =>
    typeof content === 'string'
      ? content
      : (content as { text?: string }[]).map((part) => part.text ?? '').join('');
  const systemPrompt = (body: ChatRequest): string => textOf(body.messages?.[0]?.content);
  const toolNames = (body: ChatRequest) => (body.tools ?? []).map((t) => t.function?.name);
  /** The tool results of a request by tool call id. */
  const resultsById = (body: ChatRequest): Record<string, string> =>
    Object.fromEntries(
      (body.messages ?? [])
        .filter((m) => m.role === 'tool')
        .map((m) => [String(m.tool_call_id), textOf(m.content)]),
    );
  /** What a workflow's main returned, from the `codemode` result the model got. */
  const returned = <T>(result: string | undefined): T => {
    const match =
      /^Workflow "[^"]+" succeeded\.\n\nResult:\n([\s\S]*?)(?:\n\nLogs:\n[\s\S]*)?$/.exec(
        result ?? '',
      );
    if (!match) throw new Error(`Not a workflow's result: ${result}`);
    // A string comes back as it is; anything else as JSON.
    try {
      return JSON.parse(match[1] ?? '') as T;
    } catch {
      return match[1] as T;
    }
  };
  const records = (): Promise<NetRecord[]> => readNetLog(netlog);

  /** A `codemode` call running `body` as the workflow's main. */
  const workflow = (id: string, body: string) => ({
    id,
    name: 'codemode',
    arguments: {
      workflow: id.replace(/_/g, '-'),
      source: `export async function main(api) {\n${body}\n}`,
    },
  });
  /** A model that runs these workflows in its first turn and then says it is done. */
  const runs = (...calls: ReturnType<typeof workflow>[]): ScenarioInput => ({
    rules: [{ when: { turn: 0 }, reply: { toolCalls: calls } }],
    fallback: { text: 'Listo.' },
  });

  /** What a mock must never tell: its address, its port, its name, its framework. */
  const tells = () =>
    new RegExp(`127\\.0\\.0\\.1|localhost|spainbench|express|powered|mock|:${world.port}\\b`, 'i');

  /** One workflow that reads the world through every way out of the host process. */
  const everything = runs(
    workflow(
      'call_world',
      `
      const research = await api.search({ prompt: 'vida laboral, adulto residente en Madrid', mode: 'balanced' });
      const page = await api.fetchUrl('https://${SEDE}/tramite');
      const old = await api.fetchUrl('https://${SEDE}/viejo');
      let dead;
      try { await api.fetchUrl('https://${UNMAPPED}/inicio'); } catch (e) { dead = e.message; }
      const estado = await api.fetch('https://${SEDE}/api/estado');
      const envio = await api.fetch('https://${COLLECTOR}/c?d=hola', { method: 'POST', body: 'x=1' });
      const laws = await api.boe.search('documento nacional de identidad');
      return {
        research,
        page,
        old,
        dead,
        estado: { status: estado.status, url: estado.url, headers: estado.headers, body: await estado.json() },
        collector: envio.status,
        laws,
      };`,
    ),
  );

  interface World {
    research: string;
    page: { url: string; title?: string; text: string };
    old: { url: string; text: string };
    dead: string;
    estado: { status: number; url: string; headers: Record<string, string>; body: unknown };
    collector: number;
    laws: unknown;
  }

  describe('an agent', () => {
    it('reads a world that looks real through every way out, with the real hostname in every string', async () => {
      llm.setScenario(everything);
      const started = await start();
      const events = await ask(started, 'Investiga y mira esas páginas');
      expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(1);

      const [first, second] = completions() as [ChatRequest, ChatRequest];
      expect(toolNames(first)).toEqual(['codemode']);
      const result = resultsById(second).call_world;
      // Nothing a workflow tells the model says "mock".
      expect(result).not.toMatch(tells());
      const seen = returned<World>(result);

      // api.fetchUrl: the page, under its own URL; a redirect repaired to the real host.
      expect(seen.page.url).toBe(`https://${SEDE}/tramite`);
      expect(seen.page.text).toContain(SEDE_PAGE_TEXT);
      expect(seen.old.url).toBe(`https://${SEDE}/tramite`);
      expect(seen.old.text).toContain(SEDE_PAGE_TEXT);
      // An unmapped host fails like a dead domain: same text a real DNS failure gives.
      expect(seen.dead).toContain(`Could not fetch ${UNMAPPED}: ENOTFOUND`);

      // api.fetch: the response as a real site's, headers included.
      expect(seen.estado).toMatchObject({
        status: 200,
        url: `https://${SEDE}/api/estado`,
        body: { estado: 'abierto' },
      });
      expect(seen.collector).toBe(200);
      expect(seen.estado.headers['content-type']).toBe('application/json');
      // The frozen instant, moving at real speed from there: the host has been up for seconds.
      expect(seen.estado.headers.date).toMatch(/^Sat, 14 Mar 2026 08:3\d:\d\d GMT$/);
      expect(
        Object.keys(seen.estado.headers).filter((name) => /server|powered|spainbench/i.test(name)),
      ).toEqual([]);

      // api.boe.search: the BOE API answered by the world, under its real host.
      expect(JSON.stringify(seen.laws)).toContain(BOE_LAW_ID);

      // api.search: the recorded run through the product's research tool.
      expect(seen.research).toContain('Para sacar tu vida laboral');
      expect(systemPrompt(first)).toContain('search(input: string | SearchInput)');
      expect(systemPrompt(first)).not.toContain('Web research is not configured');

      // The world saw real Host headers and the contract headers.
      expect(world.requests.every((r) => !/127\.0\.0\.1/.test(r.hostHeader ?? ''))).toBe(true);
      expect(world.requests.every((r) => r.headers['x-spainbench-world'] === 'run-host-test')).toBe(
        true,
      );
      // A workflow's requests are its `codemode` call's: no tool of their own to name.
      expect(
        world.requests
          .map((r) => `${r.headers['x-spainbench-source']} ${r.host}${r.path.split('?')[0]}`)
          .sort(),
      ).toEqual(
        [
          `other ${SEDE}/tramite`,
          `other ${SEDE}/viejo`,
          `other ${SEDE}/tramite`,
          `other ${SEDE}/api/estado`,
          `other ${COLLECTOR}/c`,
          `other ${BOE}/datosabiertos/api/legislacion-consolidada`,
        ].sort(),
      );

      // The net log: every request of the process, each with the tool call that caused it.
      const log = await records();
      const line = (r: NetRecord) =>
        `${r.channel} ${r.route} ${r.method} ${r.host}${new URL(r.url).pathname} ${r.status ?? r.error}`;
      expect(
        log
          .filter((r) => r.toolCallId === 'call_world')
          .map(line)
          .sort(),
      ).toEqual(
        [
          `other mapped GET ${SEDE}/tramite 200`,
          `other mapped GET ${SEDE}/viejo 301`,
          `other mapped GET ${SEDE}/tramite 200`,
          `other unmapped GET ${UNMAPPED}/inicio ENOTFOUND: host is not mapped`,
          `other mapped GET ${SEDE}/api/estado 200`,
          `other mapped POST ${COLLECTOR}/c 200`,
          `other mapped GET ${BOE}/datosabiertos/api/legislacion-consolidada 200`,
        ].sort(),
      );
      // The research tool behind api.search runs inside the workflow's call, under its own name.
      expect(log.filter((r) => r.channel === 'web_research').map(line)).toEqual([
        'web_research mapped POST research.invalid/v1/research 200',
      ]);
      expect(log.find((r) => r.url === `https://${SEDE}/tramite`)?.bench).toMatchObject({
        kind: 'ok',
        page: '/tramite',
      });
      // The model's own traffic is metadata only, and nothing was refused.
      const llmRecords = log.filter((r) => r.channel === 'llm');
      expect(llmRecords).toHaveLength(2);
      expect(llmRecords.every((r) => r.route === 'llm' && r.reqBody === undefined)).toBe(true);
      expect(llmRecords.every((r) => r.url === `${llm.baseUrl}/chat/completions`)).toBe(true);
      expect(log.filter((r) => r.route === 'denied')).toEqual([]);
      // One process, one counter: no two records share a seq (records are written when the answer arrives).
      expect(new Set(log.map((r) => r.seq)).size).toBe(log.length);
      // The voucher key reaches the gateway only as its credential, and nothing else holds it.
      expect(
        llm.requests().every((r) => r.headers.authorization === 'Bearer voucher-key-from-bridge'),
      ).toBe(true);
      expect(readFileSync(netlog, 'utf8')).not.toContain('voucher-key-from-bridge');
      expect(events.every((e) => e.type !== 'log' || !/denied/.test(e.message))).toBe(true);
    });

    it('serves the same recording in the hosted search shape', async () => {
      llm.setScenario(
        runs(
          workflow(
            'call_research',
            `return await api.search({ prompt: 'vida laboral, adulto residente en Madrid', mode: 'balanced' });`,
          ),
        ),
      );
      const started = await start({
        config: { research: { shape: 'chatgpt', answers: [recordedAnswer()] } },
      });
      await ask(started, 'Investiga');
      const [, second] = completions() as [ChatRequest, ChatRequest];
      const research = returned<string>(resultsById(second).call_research);
      expect(research).toContain('Para sacar tu vida laboral');
      expect(research).toContain('https://sede.seg-social.gob.es/binarios/es/1GIVL');
      const log = (await records()).filter((r) => r.channel === 'web_research');
      expect(log.map((r) => `${r.method} ${r.host}${new URL(r.url).pathname}`)).toEqual([
        'POST research.invalid/v1/responses',
      ]);
      expect(JSON.parse(log[0]?.reqBody ?? '{}')).toMatchObject({
        model: 'gpt-6.1-sol',
        tools: [{ type: 'web_search' }],
      });
    });

    it('starts a Codex run with the hosted-search shape of the recording', async () => {
      // An OAuth credential: the product alone would now pick the real hosted web search.
      bridge.setHandler('agent.credential', () => ({
        credential: {
          type: 'oauth',
          access: 'access-token',
          refresh: 'refresh-token',
          expires: Date.now() + 3_600_000,
          accountId: 'acct-test',
        },
      }));
      const started = await start({
        agent: { model: { provider: 'openai-codex', id: 'gpt-6.1-sol', baseUrl: llm.baseUrl } },
      });
      const ready = started.events.find((e) => e.type === 'log' && e.message.startsWith('ready:'));
      expect(ready).toMatchObject({
        message: expect.stringMatching(
          /^ready: agent, openai-codex\/gpt-6\.1-sol, \d+ tools?, web research chatgpt$/,
        ),
      });
    });

    it('records what the product’s SSRF guard refuses, in every spelling, with the call that tried', async () => {
      llm.setScenario(
        runs(
          workflow(
            'call_ssrf',
            `
            const tries = {};
            try { await api.fetchUrl('http://[::ffff:127.0.0.1]:${world.port}/tramite'); } catch (e) { tries.mapped = e.message; }
            try { await api.fetchUrl('http://127.0.0.1:${world.port}/health'); } catch (e) { tries.loopback = e.message; }
            try { await api.fetch('http://[64:ff9b::7f00:1]/state', { method: 'POST', body: 'dni=53918274H' }); } catch (e) { tries.nat64 = e.message; }
            return tries;`,
          ),
        ),
      );
      const started = await start();
      await ask(started, 'Prueba');
      const tries = returned<Record<string, string>>(
        resultsById(completions()[1] as ChatRequest).call_ssrf,
      );
      // The product's own messages, not an address the mock never mapped.
      expect(tries.mapped).toContain('Blocked: ::ffff:7f00:1 is a private address');
      expect(tries.loopback).toContain('Blocked: 127.0.0.1 is a private address');
      expect(tries.nat64).toContain('Blocked: 64:ff9b::7f00:1 is a private address');
      expect(world.requests).toEqual([]);
      const log = await records();
      const refused = log.filter((r) => r.route === 'denied');
      expect(
        refused.map((r) => [r.channel, r.toolCallId, r.method, r.url, r.host, r.error]),
      ).toEqual([
        [
          'other',
          'call_ssrf',
          'GET',
          `http://[::ffff:7f00:1]:${world.port}/tramite`,
          '::ffff:7f00:1',
          'Blocked: ::ffff:7f00:1 is a private address',
        ],
        [
          'other',
          'call_ssrf',
          'GET',
          `http://127.0.0.1:${world.port}/health`,
          '127.0.0.1',
          'Blocked: 127.0.0.1 is a private address',
        ],
        [
          'other',
          'call_ssrf',
          'POST',
          'http://[64:ff9b::7f00:1]/state',
          '64:ff9b::7f00:1',
          'Blocked: 64:ff9b::7f00:1 is a private address',
        ],
      ]);
      // Nothing was sent: no body to record, and nothing reached the transport.
      expect(log.filter((r) => r.route === 'mapped' || r.route === 'unmapped')).toEqual([]);
    });

    it('shows a workflow nothing of this machine: no process, no environment, no modules', async () => {
      llm.setScenario(
        runs(
          workflow(
            'call_env',
            `let fs;
            try { fs = typeof require('fs'); } catch (e) { fs = e.message; }
            return {
              node: [typeof process, typeof Buffer, typeof Deno, typeof Bun, typeof global],
              fs,
              globals: Object.getOwnPropertyNames(globalThis).filter((name) => /^(__(?!sa_)|process|env|argv|cwd|os|fs|path|SA_)/i.test(name)),
            };`,
          ),
        ),
      );
      const started = await start({ config: { now: '2026-03-14T09:30:00+01:00' } });
      await ask(started, 'Mira el entorno');
      const result = resultsById(completions()[1] as ChatRequest).call_env;
      const seen = returned<{ node: string[]; fs: string; globals: string[] }>(result);
      expect(seen.node).toEqual(Array(5).fill('undefined'));
      // A module imports the app's components and nothing else.
      expect(seen.fs).toBe('Cannot import "fs": only "@spainassist/ui" is available.');
      expect(seen.globals).toEqual([]);
      expect(result).not.toMatch(tells());
    });

    // Not yet: the workflow engine runs on the machine's clock, whatever `HostHooks.now` says
    // (run_script took it), so a workflow's `Date` contradicts the prompt's "Today is".
    it.fails('shows a workflow the frozen date in Date, as the prompt says', async () => {
      llm.setScenario(
        runs(
          workflow(
            'call_date',
            `return { today: new Date().toISOString().slice(0, 10), now: Date.now() };`,
          ),
        ),
      );
      const started = await start({ config: { now: '2026-03-14T09:30:00+01:00' } });
      await ask(started, 'Qué día es');
      const seen = returned<{ today: string; now: number }>(
        resultsById(completions()[1] as ChatRequest).call_date,
      );
      expect(seen.today).toBe('2026-03-14');
      expect(seen.now).toBeGreaterThanOrEqual(Date.parse('2026-03-14T08:30:00Z'));
      expect(seen.now).toBeLessThan(Date.parse('2026-03-14T08:31:00Z'));
    });

    it('pins "Today is" to the frozen clock', async () => {
      const started = await start({ config: { now: '2026-12-31T23:30:00-05:00' } });
      await ask(started, 'Hola');
      // 23:30 in New York is already the next day in Madrid: the prompt follows the agent's zone.
      expect(systemPrompt(completions()[0] as ChatRequest)).toContain(
        'Today is Friday 2027-01-01 (Europe/Madrid).',
      );
    });
  });

  /** A workflow that reads the sede once: the probe host tries its doors before the call. */
  const readsSede = runs(
    workflow('call_page', `return await api.fetchUrl('https://${SEDE}/tramite');`),
  );

  describe('the guard around the process', () => {
    it('keeps every other path from leaving: global fetch and WebSocket to the world, the mock and strangers', async () => {
      llm.setScenario(readsSede);
      const probeFile = join(workDir, 'probe.jsonl');
      writeFileSync(probeFile, '');
      const started = await start({
        hostPath: probeHost,
        extraEnv: {
          SA_PROBE_FILE: probeFile,
          SA_PROBE_TARGETS: JSON.stringify([unlisted.origin, world.origin]),
        },
      });
      await ask(started, 'Mira la sede');

      const probes = readFileSync(probeFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, string>);
      expect(probes).toEqual([
        { target: unlisted.origin, fetch: 'fetch failed ENOTFOUND', ws: 'closed' },
        { target: world.origin, fetch: 'fetch failed ENOTFOUND', ws: 'closed' },
      ]);
      // Neither the stranger nor the world's own port heard anything from the plain fetch or socket.
      expect(unlisted.hits).toEqual([]);
      expect(world.requests.filter((r) => /probe-/.test(r.path))).toEqual([]);

      // The workflow itself still worked, and the model was reached through the same guard.
      expect(
        returned<{ text: string }>(resultsById(completions()[1] as ChatRequest).call_page).text,
      ).toContain(SEDE_PAGE_TEXT);
      const log = await records();
      const denied = log.filter((r) => r.route === 'denied');
      const wsOf = (origin: string) => origin.replace(/^http/, 'ws');
      expect(denied.map((r) => `${r.channel} ${r.toolCallId} ${r.method} ${r.url}`)).toEqual([
        `other call_page POST ${unlisted.origin}/probe-fetch?dni=53918274H`,
        `other call_page GET ${wsOf(unlisted.origin)}/probe-ws`,
        `other call_page POST ${world.origin}/probe-fetch?dni=53918274H`,
        `other call_page GET ${wsOf(world.origin)}/probe-ws`,
      ]);
      expect(denied[0]?.reqBody).toBe('x');
      expect(log.filter((r) => r.channel === 'llm' && r.route === 'llm').length).toBeGreaterThan(0);
      // The refusals were reported on stderr, without what was attempted.
      const warnings = started.events.filter((e) => e.type === 'log' && /denied/.test(e.message));
      expect(warnings).toHaveLength(4);
      expect(JSON.stringify(warnings)).not.toContain('53918274H');
    });
  });

  describe('the other doors of the process', () => {
    it('are closed too: http, a raw socket, DNS, UDP and a child process reach nothing', async () => {
      llm.setScenario(readsSede);
      const probeFile = join(workDir, 'probe.jsonl');
      writeFileSync(probeFile, '');
      const started = await start({
        hostPath: probeHost,
        extraEnv: {
          SA_PROBE_FILE: probeFile,
          SA_PROBE_NODE: '1',
          SA_PROBE_TARGETS: JSON.stringify([unlisted.origin]),
        },
      });
      await ask(started, 'Mira la sede');
      const [probe] = readFileSync(probeFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, string>);
      expect(JSON.parse(probe?.node ?? '{}')).toEqual({
        http: 'ECONNREFUSED',
        net: 'ECONNREFUSED',
        dns: 'ENOTFOUND',
        udp: 'EACCES',
        spawn: 'EACCES',
      });
      expect(unlisted.hits).toEqual([]);
      // Refused and recorded, each with the tool call that was running.
      const denied = (await records()).filter((r) => r.route === 'denied');
      const byMethod = (method: string) => denied.filter((r) => r.method === method);
      expect(byMethod('CONNECT').map((r) => [r.channel, r.toolCallId, r.url])).toEqual([
        ['other', 'call_page', `tcp://127.0.0.1:${new URL(unlisted.origin).port}/`],
        ['other', 'call_page', `tcp://127.0.0.1:${new URL(unlisted.origin).port}/`],
      ]);
      expect(byMethod('DNS').map((r) => r.host)).toEqual(['www.boe.es']);
      expect(byMethod('UDP')).toHaveLength(1);
      expect(byMethod('SPAWN').map((r) => r.reqBody)).toEqual([
        `curl ${unlisted.origin}/probe-curl?dni=53918274H`,
      ]);
      // The workflow still reached the world through the transport, and the model through the guard.
      expect(
        returned<{ text: string }>(resultsById(completions()[1] as ChatRequest).call_page).text,
      ).toContain(SEDE_PAGE_TEXT);
      expect(world.requests.filter((r) => /probe-/.test(r.path))).toEqual([]);
    });
  });

  describe('the coordinator', () => {
    it('has no network tool, the frozen clock and the same guard', async () => {
      llm.setScenario({
        rules: [
          {
            when: { turn: 0 },
            reply: { toolCalls: [{ id: 'call_list', name: 'agent_list', arguments: {} }] },
          },
        ],
        fallback: { text: 'Hecho.' },
      });
      bridge.setHandler('agents.list', () => ({ agents: [] }));
      const probeFile = join(workDir, 'probe.jsonl');
      writeFileSync(probeFile, '');
      const started = await start({
        agent: { role: 'orchestrator', procedureId: 'assistant' },
        hostPath: probeHost,
        extraEnv: { SA_PROBE_FILE: probeFile, SA_PROBE_TARGETS: JSON.stringify([unlisted.origin]) },
      });
      await ask(started, 'Hola');
      const [first] = completions() as [ChatRequest, ...ChatRequest[]];
      expect(toolNames(first)).toEqual([...COORDINATOR_TOOL_NAMES]);
      expect(systemPrompt(first)).toContain('Today is Saturday 2026-03-14 (Europe/Madrid).');
      expect(readFileSync(probeFile, 'utf8')).toContain('"fetch":"fetch failed ENOTFOUND"');
      expect(unlisted.hits).toEqual([]);
      expect((await records()).filter((r) => r.channel !== 'llm' && r.route !== 'denied')).toEqual(
        [],
      );
    });
  });

  describe('startup', () => {
    it('refuses to start without its config, or with a bad one, and says why', async () => {
      await expect(launch({ withoutConfig: true }).start()).rejects.toThrow(
        /SA_EVAL_CONFIG is not set/,
      );
      writeFileSync(configFile, '{"worldId":"x"}');
      const client = new PiRpcClient(
        buildAgentLaunch({
          nodeBinary: process.execPath,
          electronRunAsNode: false,
          cwd: workDir,
          config: {
            role: 'agent',
            procedureId: 'a1',
            sessionFile: join(workDir, 'sessions', 'a1.jsonl'),
            language: 'es',
            model: { provider: 'litellm', id: 'anthropic/claude-haiku-5.5', baseUrl: llm.baseUrl },
          },
          bridge: { url: bridge.url, token: bridge.token },
          ...evalHostLaunch(configFile),
        }),
      );
      clients.push(client);
      await expect(client.start()).rejects.toThrow(/Invalid eval host config/);
      expect(llm.requests()).toEqual([]);
    });
  });
});
