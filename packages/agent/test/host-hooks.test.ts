/**
 * HostHooks of `runHost`, exercised on real host processes: a test entry (helpers/hook-host.ts)
 * builds the hooks, spawns happen through buildAgentLaunch + PiRpcClient with the mock LLM as the
 * model and a fake bridge, as in integration.test.ts. The hooks record what they saw in a JSONL
 * file. Nothing here reaches the network: hostnames end in `.test`, and the egress and DNS
 * stand-ins answer for them.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ChatRequest, createMockLlm, type MockLlm, type ScenarioInput } from '@sa/mock-llm';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AgentHostConfig, buildAgentLaunch, PiRpcClient } from '../src/index';
import { formatToday } from '../src/prompt/system';
import type { AgentEvent } from '../src/rpc/events';
import {
  ASSISTANT_TOOL_NAMES,
  EXA_TOOL_NAMES,
  TOOL_NAMES,
  WEB_RESEARCH_TOOL_NAME,
} from '../src/tools/names';
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { RESEARCH_RUN, RESEARCH_TEXT, type TestHooks } from './helpers/hook-host-fixtures';

const packageRoot = join(import.meta.dirname, '..');
const hostPath = join(packageRoot, 'dist', `test-hook-host-${process.pid}.js`);

beforeAll(async () => {
  // The same bundle shape as scripts/build-host.mjs, for the test entry. Beside dist/host.js
  // because pi, typebox and the canvas stay external and resolve from the package.
  await build({
    absWorkingDir: packageRoot,
    entryPoints: ['test/helpers/hook-host.ts'],
    outfile: hostPath,
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
}, 60_000);

afterAll(() => {
  rmSync(hostPath, { force: true });
});

interface LogEntry {
  hook: string;
  [key: string]: unknown;
}

async function waitFor(
  events: AgentEvent[],
  predicate: (event: AgentEvent) => boolean,
  options: { from?: number; timeoutMs?: number } = {},
): Promise<AgentEvent> {
  const started = Date.now();
  for (;;) {
    const found = events.slice(options.from ?? 0).find(predicate);
    if (found) return found;
    if (Date.now() - started > (options.timeoutMs ?? 30_000)) {
      throw new Error(`Timed out. Events: ${events.map((e) => e.type).join(', ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const isRunEnd = (event: AgentEvent) => event.type === 'run_end';

describe('HostHooks (real host process)', () => {
  let llm: MockLlm;
  let bridge: FakeBridge;
  let workDir: string;
  let logFile: string;
  let clients: PiRpcClient[];

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'sa-agent-hooks-'));
    logFile = join(workDir, 'hooks.jsonl');
    writeFileSync(logFile, '');
    clients = [];
    llm = await createMockLlm({ scenario: { fallback: { text: 'Hecho.' } }, chunkSize: 16 });
    bridge = await createFakeBridge({
      'agent.credential': () => ({ credential: { type: 'api_key', key: 'llm-key-from-bridge' } }),
      'procedure.update': (params) => ({
        id: 'p1',
        title: 'Trámite',
        status: 'researching',
        steps: [],
        requirements: [],
        facts: [],
        sources: [],
        createdAt: '2026-10-03T00:00:00Z',
        updatedAt: '2026-10-03T00:00:00Z',
        archived: false,
        ...params,
      }),
    });
  });

  afterEach(async () => {
    for (const client of clients) await client.stop();
    await llm.close();
    await bridge.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  const log = (): LogEntry[] =>
    readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogEntry);
  const logOf = (hook: string) => log().filter((entry) => entry.hook === hook);

  function launch(hooks: Omit<TestHooks, 'log'>, options: Partial<AgentHostConfig> = {}) {
    return new PiRpcClient(
      buildAgentLaunch({
        nodeBinary: process.execPath,
        electronRunAsNode: false,
        cwd: workDir,
        config: {
          procedureId: 'p1',
          sessionFile: join(workDir, 'sessions', 'p1.jsonl'),
          language: 'es',
          model: { provider: 'custom', id: 'mock-model', baseUrl: llm.baseUrl },
          // Community learnings, sharing included: the agent has every tool of TOOL_NAMES.
          feedback: { submit: true, vote: true },
          ...options,
        },
        bridge: { url: bridge.url, token: bridge.token },
        hostPath,
        extraEnv: { SA_TEST_HOOKS: JSON.stringify({ ...hooks, log: logFile } satisfies TestHooks) },
      }),
    );
  }

  async function start(hooks: Omit<TestHooks, 'log'>, options: Partial<AgentHostConfig> = {}) {
    const client = launch(hooks, options);
    clients.push(client);
    const events: AgentEvent[] = [];
    client.on((event) => events.push(event));
    await client.start();
    return { client, events };
  }

  /** Sends `text` and waits for the run to end; returns the new events. */
  async function ask(started: { client: PiRpcClient; events: AgentEvent[] }, text: string) {
    const from = started.events.length;
    await started.client.prompt(text);
    await waitFor(started.events, isRunEnd, { from });
    return started.events.slice(from);
  }

  const completions = () =>
    llm
      .requests()
      .filter((r) => r.path.endsWith('/chat/completions'))
      .map((r) => r.body as ChatRequest);
  const toolNames = (body: ChatRequest) => (body.tools ?? []).map((t) => t.function?.name);
  const systemPrompt = (body: ChatRequest) => String(body.messages?.[0]?.content);
  const toolResults = (body: ChatRequest) =>
    (body.messages ?? [])
      .filter((m) => m.role === 'tool')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
  const script = (scenario: ScenarioInput) => llm.setScenario(scenario);

  describe('without hooks', () => {
    it('is the product host: no stub, no wrapper, the real clock', async () => {
      const started = await start({});
      await ask(started, 'Hola');
      const [body] = completions() as [ChatRequest];
      expect(toolNames(body)).toEqual([...TOOL_NAMES]);
      expect(systemPrompt(body)).toContain('Web research is not available');
      const today = (date: Date) => formatToday(date);
      expect([today(new Date()), today(new Date(Date.now() - 60_000))]).toContainEqual(
        systemPrompt(body).match(/Today is (.*)\./)?.[1],
      );
      expect(log()).toEqual([]);
    });
  });

  describe('egress', () => {
    it('reaches fetch_url, run_script and boe_search, with real URLs and no real DNS', async () => {
      script({
        rules: [
          {
            when: { turn: 0 },
            reply: {
              toolCalls: [
                { name: 'fetch_url', arguments: { url: 'https://sede.spain.test/tramite?id=7' } },
                {
                  name: 'run_script',
                  arguments: {
                    code: `const r = await fetch('https://api.spain.test/v1/datos', { method: 'POST', body: 'x' }); return await r.json();`,
                  },
                },
                { name: 'boe_search', arguments: { query: 'documento nacional de identidad' } },
              ],
            },
          },
        ],
        fallback: { text: 'Listo.' },
      });
      const started = await start({ egress: true });
      const events = await ask(started, 'Mira esas páginas');

      // Every request went to the stand-in, with the URL the agent asked for.
      const fetches = logOf('egress.fetch');
      expect(fetches.map((f) => String(f.url)).sort()).toEqual([
        'https://api.spain.test/v1/datos',
        'https://sede.spain.test/tramite?id=7',
        expect.stringMatching(
          /^https:\/\/www\.boe\.es\/datosabiertos\/api\/legislacion-consolidada\?query=/,
        ),
      ]);
      const byHost = (host: string) =>
        fetches.find((f) => new URL(String(f.url)).hostname === host);
      // fetch_url and run_script follow redirects by hand (manual) and pass a URL object; the
      // BOE search relies on the platform default and passes a string.
      expect(byHost('sede.spain.test')).toMatchObject({
        inputType: 'URL',
        redirect: 'manual',
        method: 'GET',
      });
      expect(byHost('api.spain.test')).toMatchObject({
        inputType: 'URL',
        redirect: 'manual',
        method: 'POST',
      });
      expect(byHost('www.boe.es')).toMatchObject({ inputType: 'string', method: 'GET' });
      expect(byHost('www.boe.es')?.redirect).toBeUndefined();

      // The guard asked the stand-in resolver (and only it) for the two guarded tools.
      expect(
        logOf('egress.resolveHost')
          .map((r) => r.host)
          .sort(),
      ).toEqual(['api.spain.test', 'sede.spain.test']);

      // What the model read came from the stand-in, produced by the product tools.
      const second = completions()[1] as ChatRequest;
      const results = toolResults(second);
      expect(results).toHaveLength(3);
      expect(
        results.find((r) => r.startsWith('URL: https://sede.spain.test/tramite?id=7')),
      ).toContain('Texto servido por el egress de prueba.');
      expect(results.some((r) => r.includes('"path": "/v1/datos"'))).toBe(true);
      expect(results.some((r) => r.includes('BOE-A-2005-21163'))).toBe(true);
      const ends = events.filter((e) => e.type === 'tool_end');
      expect(ends).toHaveLength(3);
      expect(ends.every((e) => e.type === 'tool_end' && !e.isError)).toBe(true);
    });

    it('keeps the production guard in front of the stand-in: literals and local names never reach it', async () => {
      script({
        rules: [
          {
            when: { turn: 0 },
            reply: {
              toolCalls: [
                { name: 'fetch_url', arguments: { url: 'http://127.0.0.1:8790/' } },
                { name: 'fetch_url', arguments: { url: 'http://localhost:8790/' } },
                { name: 'fetch_url', arguments: { url: 'https://nada.spain.test/' } },
                { name: 'fetch_url', arguments: { url: 'http://[::ffff:127.0.0.1]:8790/' } },
                {
                  name: 'run_script',
                  arguments: {
                    code: `try { await fetch('http://[64:ff9b::7f00:1]/x', { method: 'POST', body: 'a' }); } catch (e) { return e.message; }`,
                  },
                },
              ],
            },
          },
        ],
        fallback: { text: 'Listo.' },
      });
      const started = await start({ egress: true, wrapTool: true });
      await ask(started, 'Prueba');
      const results = toolResults(completions()[1] as ChatRequest);
      expect(results).toContain(
        'Could not read http://[::ffff:127.0.0.1]:8790/: Blocked: ::ffff:7f00:1 is a private address',
      );
      expect(results.some((r) => r.includes('Blocked: 64:ff9b::7f00:1 is a private address'))).toBe(
        true,
      );
      // Each refusal is reported to the embedder, inside the call that made it.
      const refused = logOf('egress.onBlocked').map((r) => ({
        url: r.url,
        method: r.method,
        message: r.message,
        tool: (r.call as { tool: string } | null)?.tool,
      }));
      expect(refused).toEqual(
        expect.arrayContaining([
          {
            url: 'http://127.0.0.1:8790/',
            method: 'GET',
            message: 'Blocked: 127.0.0.1 is a private address',
            tool: 'fetch_url',
          },
          {
            url: 'http://localhost:8790/',
            method: 'GET',
            message: 'Blocked: localhost is a local address',
            tool: 'fetch_url',
          },
          {
            url: 'http://[::ffff:7f00:1]:8790/',
            method: 'GET',
            message: 'Blocked: ::ffff:7f00:1 is a private address',
            tool: 'fetch_url',
          },
          {
            url: 'http://[64:ff9b::7f00:1]/x',
            method: 'POST',
            message: 'Blocked: 64:ff9b::7f00:1 is a private address',
            tool: 'run_script',
          },
        ]),
      );
      expect(refused).toHaveLength(4);
      expect(results).toContain(
        'Could not read http://127.0.0.1:8790/: Blocked: 127.0.0.1 is a private address',
      );
      expect(results).toContain(
        'Could not read http://localhost:8790/: Blocked: localhost is a local address',
      );
      // A name the egress cannot serve fails like a dead domain, with no address in the text.
      expect(results).toContain(
        'Could not read https://nada.spain.test/: Could not fetch nada.spain.test: ENOTFOUND',
      );
      expect(logOf('egress.fetch').map((f) => f.url)).toEqual(['https://nada.spain.test/']);
      expect(logOf('egress.resolveHost').map((r) => r.host)).toEqual(['nada.spain.test']);
    });

    it('does not give the assistant any network tool', async () => {
      const started = await start({ egress: true }, { role: 'assistant' });
      await ask(started, 'Hola');
      expect(toolNames(completions()[0] as ChatRequest)).toEqual([...ASSISTANT_TOOL_NAMES]);
    });
  });

  describe('research stub', () => {
    const userAsksResearch: ScenarioInput = {
      rules: [
        {
          when: { turn: 0 },
          reply: {
            toolCalls: [
              { name: 'web_research', arguments: { query: 'renovar NIE', mode: 'balanced' } },
            ],
          },
        },
      ],
      fallback: { text: 'Hecho.' },
    };

    it('replaces the backend and the tools: the real tool over a stand-in transport', async () => {
      script(userAsksResearch);
      // A custom endpoint: without the stub it has no web_research at all.
      const started = await start({ research: 'key-server' });
      await ask(started, 'Quiero renovar el NIE');
      const [first, second] = completions() as [ChatRequest, ChatRequest];
      expect(toolNames(first).sort()).toEqual([...TOOL_NAMES, WEB_RESEARCH_TOOL_NAME].sort());
      expect(systemPrompt(first)).toContain('call web_research once');
      expect(systemPrompt(first)).not.toContain('Web research is not available');

      const requests = logOf('research.fetch');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: 'https://research.spain.test/v1/research',
        body: { input: 'renovar NIE', mode: 'balanced' },
      });
      // The model reads exactly what the product tool produces for this stream.
      expect(toolResults(second)).toEqual([
        JSON.stringify({
          success: true,
          id: RESEARCH_RUN,
          status: 'completed',
          outputReady: true,
          output: { type: 'text', content: RESEARCH_TEXT, basis: [] },
        }),
      ]);
    });

    it('can emulate the Exa backend, with the stub providing its tools', async () => {
      const started = await start({ research: 'exa' });
      await ask(started, 'Hola');
      const [body] = completions() as [ChatRequest];
      expect(toolNames(body).sort()).toEqual([...TOOL_NAMES, ...EXA_TOOL_NAMES].sort());
      expect(systemPrompt(body)).toContain('research the procedure with exa_search');
      expect(systemPrompt(body)).not.toContain('web_research');
    });

    it('can remove web research that the config would give', async () => {
      const started = await start({ research: 'none' }, { research: { exa: true } });
      await ask(started, 'Hola');
      const [body] = completions() as [ChatRequest];
      expect(toolNames(body)).toEqual([...TOOL_NAMES]);
      expect(systemPrompt(body)).toContain('Web research is not available');
    });

    it('does not apply to the assistant, which never researches', async () => {
      const started = await start({ research: 'key-server' }, { role: 'assistant' });
      await ask(started, 'Hola');
      const [body] = completions() as [ChatRequest];
      expect(toolNames(body)).toEqual([...ASSISTANT_TOOL_NAMES]);
      expect(logOf('research.fetch')).toEqual([]);
    });
  });

  describe('wrapTool', () => {
    it('wraps every tool, research ones included, and a context survives parallel calls', async () => {
      script({
        rules: [
          {
            when: { turn: 0 },
            reply: {
              toolCalls: [
                {
                  id: 'call_a',
                  name: 'run_script',
                  arguments: {
                    code: `return await (await fetch('https://api.spain.test/a')).json();`,
                  },
                },
                {
                  id: 'call_b',
                  name: 'run_script',
                  arguments: {
                    code: `return await (await fetch('https://api.spain.test/b')).json();`,
                  },
                },
                {
                  id: 'call_c',
                  name: 'fetch_url',
                  arguments: { url: 'https://sede.spain.test/c' },
                },
                {
                  id: 'call_d',
                  name: 'web_research',
                  arguments: { query: 'renovar NIE', mode: 'fast' },
                },
              ],
            },
          },
        ],
        fallback: { text: 'Listo.' },
      });
      const started = await start({ wrapTool: true, egress: true, research: 'key-server' });
      const events = await ask(started, 'Todo a la vez');

      const starts = events.filter((e) => e.type === 'tool_start');
      expect(starts.map((e) => e.type === 'tool_start' && e.toolCallId).sort()).toEqual([
        'call_a',
        'call_b',
        'call_c',
        'call_d',
      ]);
      expect(
        logOf('wrapTool.start')
          .map((e) => `${e.id}:${e.tool}`)
          .sort(),
      ).toEqual([
        'call_a:run_script',
        'call_b:run_script',
        'call_c:fetch_url',
        'call_d:web_research',
      ]);
      expect(logOf('wrapTool.end')).toHaveLength(4);

      // Each request is attributed to the call that made it (AsyncLocalStorage over the hook).
      const attribution = Object.fromEntries(
        logOf('egress.fetch').map((f) => [f.url, (f.call as { id: string; tool: string }).id]),
      );
      expect(attribution).toEqual({
        'https://api.spain.test/a': 'call_a',
        'https://api.spain.test/b': 'call_b',
        'https://sede.spain.test/c': 'call_c',
      });
    });

    it('wraps the tools of the assistant too', async () => {
      llm.setScenario({
        rules: [
          {
            when: { turn: 0 },
            reply: { toolCalls: [{ id: 'call_v', name: 'vault_read', arguments: {} }] },
          },
        ],
        fallback: { text: 'Hecho.' },
      });
      bridge.setHandler('vault.read', () => ({ personal: [], documents: [], credentials: [] }));
      const started = await start({ wrapTool: true }, { role: 'assistant' });
      await ask(started, 'Hola');
      expect(logOf('wrapTool.start')).toEqual([
        { hook: 'wrapTool.start', tool: 'vault_read', id: 'call_v' },
      ]);
    });

    it('refuses a wrapper that renames a tool', async () => {
      const client = launch({ wrapTool: 'rename' });
      clients.push(client);
      await expect(client.start()).rejects.toThrow(/wrapTool must keep the tool name/);
    });
  });

  describe('onModel', () => {
    it.each(['procedure', 'assistant'] as const)(
      'sees the configured model before the first LLM request (%s)',
      async (role) => {
        const started = await start({ onModel: 'global-fetch' }, { role });
        await ask(started, 'Hola');
        const hooks = log();
        expect(hooks[0]).toEqual({
          hook: 'onModel',
          provider: 'custom',
          id: 'mock-model',
          baseUrl: llm.baseUrl,
          role,
        });
        // Installed there, a global fetch guard already captures the LLM traffic.
        expect(logOf('global-fetch').map((e) => e.url)).toContain(
          `${llm.baseUrl}/chat/completions`,
        );
        expect(llm.requests().length).toBeGreaterThan(0);
      },
    );
  });

  describe('now', () => {
    it.each(['procedure', 'assistant'] as const)(
      'pins "Today is" in the %s prompt, read on every turn',
      async (role) => {
        const clockFile = join(workDir, 'now.txt');
        writeFileSync(clockFile, '2026-03-14T09:30:00+01:00');
        const started = await start({ now: { file: clockFile } }, { role });
        await ask(started, 'Primero');
        expect(systemPrompt(completions().at(-1) as ChatRequest)).toContain(
          'Today is Saturday 2026-03-14 (Europe/Madrid).',
        );
        writeFileSync(clockFile, '2026-03-15T09:30:00+01:00');
        await ask(started, 'Segundo');
        expect(systemPrompt(completions().at(-1) as ChatRequest)).toContain(
          'Today is Sunday 2026-03-15 (Europe/Madrid).',
        );
        expect(logOf('now').length).toBeGreaterThanOrEqual(2);
      },
    );

    it('uses the time zone of the config', async () => {
      const started = await start({ now: '2026-03-14T23:30:00Z' }, { timeZone: 'Atlantic/Canary' });
      await ask(started, 'Hola');
      // 23:30 UTC is still the 14th in the Canary Islands (UTC+0 in winter).
      expect(systemPrompt(completions()[0] as ChatRequest)).toContain(
        'Today is Saturday 2026-03-14 (Atlantic/Canary).',
      );
    });
  });
});
