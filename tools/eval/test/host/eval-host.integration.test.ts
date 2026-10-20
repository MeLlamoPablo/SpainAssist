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
  ASSISTANT_TOOL_NAMES,
  buildAgentLaunch,
  PiRpcClient,
} from '@sa/agent';
import { type ChatRequest, createMockLlm, type MockLlm, type ScenarioInput } from '@sa/mock-llm';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeBridge,
  type FakeBridge,
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
      'agent.credential': () => ({
        credential: { type: 'api_key', key: 'voucher-key-from-bridge' },
      }),
      'vault.read': () => ({ personal: [], documents: [], credentials: [] }),
      // The app's scrubber: these queries hold no personal data.
      'research.scrub': (params) => ({ text: String(params.text), redactions: 0 }),
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
          procedureId: 'p1',
          sessionFile: join(workDir, 'sessions', 'p1.jsonl'),
          language: 'es',
          // The voucher provider at the mock gateway: what voucher runs use, pointed at the meter.
          model: { provider: 'litellm', id: 'anthropic/claude-haiku-5.5', baseUrl: llm.baseUrl },
          // No background compaction calls in the middle of a test.
          idleCompaction: { minTokens: 1_000_000_000 },
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
  /** The system prompt as text (Anthropic models get it as content parts with cache markers). */
  const systemPrompt = (body: ChatRequest): string => {
    const content = body.messages?.[0]?.content;
    if (typeof content === 'string') return content;
    return (content as { text?: string }[]).map((part) => part.text ?? '').join('');
  };
  const toolNames = (body: ChatRequest) => (body.tools ?? []).map((t) => t.function?.name);
  /** The tool results of a request by tool call id. */
  const resultsById = (body: ChatRequest): Record<string, string> =>
    Object.fromEntries(
      (body.messages ?? [])
        .filter((m) => m.role === 'tool')
        .map((m) => [
          String(m.tool_call_id),
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        ]),
    );
  const records = (): Promise<NetRecord[]> => readNetLog(netlog);

  /** What a mock must never tell: its address, its port, its name, its framework. */
  const tells = () =>
    new RegExp(`127\\.0\\.0\\.1|localhost|spainbench|express|powered|mock|:${world.port}\\b`, 'i');

  const everything: ScenarioInput = {
    rules: [
      {
        when: { turn: 0 },
        reply: {
          toolCalls: [
            {
              id: 'call_research',
              name: 'web_research',
              arguments: { query: 'vida laboral, adulto residente en Madrid', mode: 'balanced' },
            },
            { id: 'call_page', name: 'fetch_url', arguments: { url: `https://${SEDE}/tramite` } },
            { id: 'call_old', name: 'fetch_url', arguments: { url: `https://${SEDE}/viejo` } },
            {
              id: 'call_dead',
              name: 'fetch_url',
              arguments: { url: `https://${UNMAPPED}/inicio` },
            },
            {
              id: 'call_script',
              name: 'run_script',
              arguments: {
                code: `
                  const estado = await fetch('https://${SEDE}/api/estado');
                  const envio = await fetch('https://${COLLECTOR}/c?d=hola', { method: 'POST', body: 'x=1' });
                  return {
                    status: estado.status,
                    url: estado.url,
                    headers: Object.fromEntries(estado.headers.entries()),
                    body: await estado.json(),
                    collector: envio.status,
                  };`,
              },
            },
            {
              id: 'call_boe',
              name: 'boe_search',
              arguments: { query: 'documento nacional de identidad' },
            },
          ],
        },
      },
    ],
    fallback: { text: 'Listo.' },
  };

  describe('a procedure agent', () => {
    it('reads a world that looks real through every tool, with the real hostname in every string', async () => {
      llm.setScenario(everything);
      const started = await start();
      const events = await ask(started, 'Investiga y mira esas páginas');
      expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(6);

      const [first, second] = completions() as [ChatRequest, ChatRequest];
      const results = resultsById(second);
      expect(Object.keys(results).sort()).toEqual([
        'call_boe',
        'call_dead',
        'call_old',
        'call_page',
        'call_research',
        'call_script',
      ]);

      // Nothing a tool tells the model says "mock".
      expect(Object.values(results).join('\n')).not.toMatch(tells());

      // fetch_url: the page, under its own URL; a redirect repaired to the real host.
      expect(results.call_page).toMatch(new RegExp(`^URL: https://${SEDE}/tramite`));
      expect(results.call_page).toContain(SEDE_PAGE_TEXT);
      expect(results.call_old).toContain(
        `URL: https://${SEDE}/tramite (redirected from https://${SEDE}/viejo)`,
      );
      expect(results.call_old).toContain(SEDE_PAGE_TEXT);
      // An unmapped host fails like a dead domain: same text a real DNS failure gives.
      expect(results.call_dead).toBe(
        `Could not read https://${UNMAPPED}/inicio: Could not fetch ${UNMAPPED}: ENOTFOUND`,
      );

      // run_script: the response as a real site's, headers included.
      const script = JSON.parse(
        (results.call_script as string).split('--- Result ---\n')[1]?.split('\n\n(')[0] ?? '',
      ) as {
        status: number;
        url: string;
        headers: Record<string, string>;
        body: unknown;
        collector: number;
      };
      expect(script).toMatchObject({
        status: 200,
        url: `https://${SEDE}/api/estado`,
        body: { estado: 'abierto' },
        collector: 200,
      });
      expect(script.headers['content-type']).toBe('application/json');
      // The frozen instant, moving at real speed from there: the host has been up for seconds.
      expect(script.headers.date).toMatch(/^Sat, 14 Mar 2026 08:3\d:\d\d GMT$/);
      expect(
        Object.keys(script.headers).filter((name) => /server|powered|spainbench/i.test(name)),
      ).toEqual([]);
      expect(results.call_script).toContain('(2 requests;');

      // boe_search: the BOE API answered by the world, under its real host.
      expect(results.call_boe).toContain(BOE_LAW_ID);

      // web_research: the recorded run through the product tool, byte for byte.
      const answer = recordedAnswer();
      expect(results.call_research).toBe(
        JSON.stringify({
          success: true,
          id: answer.id,
          status: 'completed',
          outputReady: true,
          output: answer.output,
        }),
      );
      expect(toolNames(first)).toContain('web_research');
      expect(systemPrompt(first)).toContain('call web_research once');
      expect(systemPrompt(first)).not.toContain('Web research is not available');

      // The world saw real Host headers and the contract headers, never the agent's own tools' names.
      expect(world.requests.every((r) => !/127\.0\.0\.1/.test(r.hostHeader ?? ''))).toBe(true);
      const bySource = (source: string) =>
        world.requests.filter((r) => r.headers['x-spainbench-source'] === source);
      expect(
        bySource('fetch_url')
          .map((r) => `${r.host}${r.path}`)
          .sort(),
      ).toEqual([`${SEDE}/tramite`, `${SEDE}/tramite`, `${SEDE}/viejo`]);
      expect(
        bySource('run_script')
          .map((r) => `${r.host}${r.path}`)
          .sort(),
      ).toEqual([`${COLLECTOR}/c?d=hola`, `${SEDE}/api/estado`]);
      expect(bySource('boe_search').map((r) => r.host)).toEqual([BOE]);
      expect(world.requests.every((r) => r.headers['x-spainbench-world'] === 'run-host-test')).toBe(
        true,
      );
      expect(world.requests).toHaveLength(6);

      // The net log: every request of the process, each with the tool call that caused it.
      const log = await records();
      const attribution = (id: string) =>
        log
          .filter((r) => r.toolCallId === id)
          .map(
            (r) =>
              `${r.channel} ${r.route} ${r.method} ${r.host}${new URL(r.url).pathname} ${r.status ?? r.error}`,
          );
      expect(attribution('call_page')).toEqual([`fetch_url mapped GET ${SEDE}/tramite 200`]);
      expect(attribution('call_old')).toEqual([
        `fetch_url mapped GET ${SEDE}/viejo 301`,
        `fetch_url mapped GET ${SEDE}/tramite 200`,
      ]);
      expect(attribution('call_dead')).toEqual([
        `fetch_url unmapped GET ${UNMAPPED}/inicio ENOTFOUND: host is not mapped`,
      ]);
      expect(attribution('call_script').sort()).toEqual([
        `run_script mapped GET ${SEDE}/api/estado 200`,
        `run_script mapped POST ${COLLECTOR}/c 200`,
      ]);
      expect(attribution('call_boe')).toEqual([
        `boe_search mapped GET ${BOE}/datosabiertos/api/legislacion-consolidada 200`,
      ]);
      expect(attribution('call_research')).toEqual([
        'web_research mapped POST research.invalid/v1/research 200',
      ]);
      expect(log.find((r) => r.toolCallId === 'call_page')?.bench).toMatchObject({
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
      llm.setScenario(everything);
      const started = await start({
        config: { research: { shape: 'chatgpt', answers: [recordedAnswer()] } },
      });
      await ask(started, 'Investiga');
      const [first, second] = completions() as [ChatRequest, ChatRequest];
      const tool = (first.tools ?? []).find((t) => t.function?.name === 'web_research')?.function;
      expect((tool as { description: string }).description).toContain(
        "Each call uses the user's ChatGPT plan.",
      );
      const result = JSON.parse(resultsById(second).call_research as string) as {
        success: boolean;
        id?: string;
        output: { type: string; content: string; basis: { url: string }[] };
      };
      expect(result.success).toBe(true);
      expect(result.id).toBeUndefined();
      expect(result.output.type).toBe('text');
      expect(result.output.content).toContain('Para sacar tu vida laboral');
      expect(result.output.basis.map((b) => b.url)).toContain(
        'https://sede.seg-social.gob.es/binarios/es/1GIVL',
      );
      const research = (await records()).filter((r) => r.channel === 'web_research');
      expect(research.map((r) => `${r.method} ${r.host}${new URL(r.url).pathname}`)).toEqual([
        'POST research.invalid/v1/responses',
      ]);
      expect(JSON.parse(research[0]?.reqBody ?? '{}')).toMatchObject({
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
          /^ready: procedure, openai-codex\/gpt-6\.1-sol, \d+ tools, web research chatgpt$/,
        ),
      });
    });

    it('records what the product’s SSRF guard refuses, in every spelling, with the tool that tried', async () => {
      llm.setScenario({
        rules: [
          {
            when: { turn: 0 },
            reply: {
              toolCalls: [
                {
                  id: 'call_mapped',
                  name: 'fetch_url',
                  arguments: { url: `http://[::ffff:127.0.0.1]:${world.port}/tramite` },
                },
                {
                  id: 'call_loopback',
                  name: 'fetch_url',
                  arguments: { url: `http://127.0.0.1:${world.port}/health` },
                },
                {
                  id: 'call_script',
                  name: 'run_script',
                  arguments: {
                    code: `try { await fetch('http://[64:ff9b::7f00:1]/state', { method: 'POST', body: 'dni=53918274H' }); } catch (e) { return e.message; }`,
                  },
                },
              ],
            },
          },
        ],
        fallback: { text: 'Listo.' },
      });
      const started = await start();
      await ask(started, 'Prueba');
      const results = resultsById(completions()[1] as ChatRequest);
      // The product's own messages, not an address the mock never mapped.
      expect(results.call_mapped).toBe(
        `Could not read http://[::ffff:127.0.0.1]:${world.port}/tramite: Blocked: ::ffff:7f00:1 is a private address`,
      );
      expect(results.call_loopback).toBe(
        `Could not read http://127.0.0.1:${world.port}/health: Blocked: 127.0.0.1 is a private address`,
      );
      expect(results.call_script).toContain('Blocked: 64:ff9b::7f00:1 is a private address');
      expect(world.requests).toEqual([]);
      const log = await records();
      const refused = log.filter((r) => r.route === 'denied');
      expect(
        refused.map((r) => [r.channel, r.toolCallId, r.method, r.url, r.host, r.error]),
      ).toEqual([
        [
          'fetch_url',
          'call_mapped',
          'GET',
          `http://[::ffff:7f00:1]:${world.port}/tramite`,
          '::ffff:7f00:1',
          'Blocked: ::ffff:7f00:1 is a private address',
        ],
        [
          'fetch_url',
          'call_loopback',
          'GET',
          `http://127.0.0.1:${world.port}/health`,
          '127.0.0.1',
          'Blocked: 127.0.0.1 is a private address',
        ],
        [
          'run_script',
          'call_script',
          'POST',
          'http://[64:ff9b::7f00:1]/state',
          '64:ff9b::7f00:1',
          'Blocked: 64:ff9b::7f00:1 is a private address',
        ],
      ]);
      // Nothing was sent: no body to record, and nothing reached the transport.
      expect(log.filter((r) => r.route === 'mapped' || r.route === 'unmapped')).toEqual([]);
    });

    it('shows a script nothing of this machine: no process, no environment, and the frozen date in Date', async () => {
      llm.setScenario({
        rules: [
          {
            when: { turn: 0 },
            reply: {
              toolCalls: [
                {
                  id: 'call_env',
                  name: 'run_script',
                  arguments: {
                    code: `return {
                      node: [typeof process, typeof require, typeof Buffer, typeof module, typeof Deno, typeof Bun],
                      globals: Object.getOwnPropertyNames(globalThis).filter((name) => /^(__|process|env|argv|cwd|os|fs|path|SA_)/i.test(name)),
                      today: new Date().toISOString().slice(0, 10),
                      year: new Date().getUTCFullYear(),
                      now: Date.now(),
                    };`,
                  },
                },
              ],
            },
          },
        ],
        fallback: { text: 'Listo.' },
      });
      const started = await start({ config: { now: '2026-03-14T09:30:00+01:00' } });
      await ask(started, 'Mira el entorno');
      const result = resultsById(completions()[1] as ChatRequest).call_env as string;
      // Anthropic models get a tool result as content parts with a cache marker.
      const text = (JSON.parse(result) as { text: string }[]).map((part) => part.text).join('');
      const seen = JSON.parse(text.split('--- Result ---\n')[1]?.split('\n\n(')[0] ?? '') as {
        node: string[];
        globals: string[];
        today: string;
        year: number;
        now: number;
      };
      expect(seen.node).toEqual(Array(6).fill('undefined'));
      expect(seen.globals).toEqual([]);
      // The frozen date, not the machine's, which is what the prompt says too.
      expect(seen.today).toBe('2026-03-14');
      expect(seen.year).toBe(2026);
      expect(seen.now).toBeGreaterThanOrEqual(Date.parse('2026-03-14T08:30:00Z'));
      expect(seen.now).toBeLessThan(Date.parse('2026-03-14T08:31:00Z'));
      expect(text).not.toMatch(tells());
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

  describe('the guard around the process', () => {
    it('keeps every other path from leaving: global fetch and WebSocket to the world, the mock and strangers', async () => {
      llm.setScenario({
        rules: [
          {
            when: { turn: 0 },
            reply: {
              toolCalls: [
                {
                  id: 'call_page',
                  name: 'fetch_url',
                  arguments: { url: `https://${SEDE}/tramite` },
                },
              ],
            },
          },
        ],
        fallback: { text: 'Listo.' },
      });
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

      // The tool itself still worked, and the model was reached through the same guard.
      expect(resultsById(completions()[1] as ChatRequest).call_page).toContain(SEDE_PAGE_TEXT);
      const log = await records();
      const denied = log.filter((r) => r.route === 'denied');
      const wsOf = (origin: string) => origin.replace(/^http/, 'ws');
      expect(denied.map((r) => `${r.channel} ${r.toolCallId} ${r.method} ${r.url}`)).toEqual([
        `fetch_url call_page POST ${unlisted.origin}/probe-fetch?dni=53918274H`,
        `fetch_url call_page GET ${wsOf(unlisted.origin)}/probe-ws`,
        `fetch_url call_page POST ${world.origin}/probe-fetch?dni=53918274H`,
        `fetch_url call_page GET ${wsOf(world.origin)}/probe-ws`,
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
      llm.setScenario({
        rules: [
          {
            when: { turn: 0 },
            reply: {
              toolCalls: [
                {
                  id: 'call_page',
                  name: 'fetch_url',
                  arguments: { url: `https://${SEDE}/tramite` },
                },
              ],
            },
          },
        ],
        fallback: { text: 'Listo.' },
      });
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
        ['fetch_url', 'call_page', `tcp://127.0.0.1:${new URL(unlisted.origin).port}/`],
        ['fetch_url', 'call_page', `tcp://127.0.0.1:${new URL(unlisted.origin).port}/`],
      ]);
      expect(byMethod('DNS').map((r) => r.host)).toEqual(['www.boe.es']);
      expect(byMethod('UDP')).toHaveLength(1);
      expect(byMethod('SPAWN').map((r) => r.reqBody)).toEqual([
        `curl ${unlisted.origin}/probe-curl?dni=53918274H`,
      ]);
      // The tool itself still reached the world through the transport, and the model through the guard.
      expect(resultsById(completions()[1] as ChatRequest).call_page).toContain(SEDE_PAGE_TEXT);
      expect(world.requests.filter((r) => /probe-/.test(r.path))).toEqual([]);
    });
  });

  describe('the assistant', () => {
    it('has no network tool, the frozen clock and the same guard', async () => {
      llm.setScenario({
        rules: [
          {
            when: { turn: 0 },
            reply: { toolCalls: [{ id: 'call_vault', name: 'vault_read', arguments: {} }] },
          },
        ],
        fallback: { text: 'Hecho.' },
      });
      const probeFile = join(workDir, 'probe.jsonl');
      writeFileSync(probeFile, '');
      const started = await start({
        agent: { role: 'assistant', procedureId: 'assistant' },
        hostPath: probeHost,
        extraEnv: { SA_PROBE_FILE: probeFile, SA_PROBE_TARGETS: JSON.stringify([unlisted.origin]) },
      });
      await ask(started, 'Hola');
      const [first] = completions() as [ChatRequest, ...ChatRequest[]];
      expect(toolNames(first)).toEqual([...ASSISTANT_TOOL_NAMES]);
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
            procedureId: 'p1',
            sessionFile: join(workDir, 'sessions', 'p1.jsonl'),
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
