/**
 * Test entry of the agent host: `runHost` with HostHooks built from SA_TEST_HOOKS (a JSON
 * description, see TestHooks). Bundled by host-hooks.test.ts. Every hook appends what it saw to a
 * JSONL file, which is how the test observes a real host process. Stands in for what an offline
 * harness does with the same hooks: its own egress, a research stub, a tool wrapper.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, readFileSync } from 'node:fs';
import {
  createExaTools,
  createKeyServerResearchTool,
  type HostHooks,
  hostLog,
  runHost,
} from '../../src/host/runtime';
import {
  BOE_BODY,
  RESEARCH_RUN,
  RESEARCH_TEXT,
  SEDE_PAGE,
  type TestHooks,
} from './hook-host-fixtures';

const config = JSON.parse(process.env.SA_TEST_HOOKS ?? '{}') as TestHooks;
const calls = new AsyncLocalStorage<{ id: string; tool: string }>();

function record(entry: Record<string, unknown>): void {
  appendFileSync(config.log, `${JSON.stringify(entry)}\n`);
}

const urlOf = (input: string | URL | Request) =>
  input instanceof Request ? input.url : String(input);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

const frame = (event: Record<string, unknown>) =>
  new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

/** The key server's research stream, answered offline. */
const researchFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  record({ hook: 'research.fetch', url: urlOf(input), body: JSON.parse(String(init?.body)) });
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame({ type: 'created', id: RESEARCH_RUN, priceUsd: 0.05 }));
        controller.enqueue(
          frame({ type: 'progress', id: RESEARCH_RUN, status: 'running', elapsedSeconds: 3 }),
        );
        controller.enqueue(
          frame({
            type: 'completed',
            id: RESEARCH_RUN,
            output: { type: 'text', content: RESEARCH_TEXT, basis: [] },
          }),
        );
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}) as typeof fetch;

const hooks: HostHooks = {};

if (config.egress) {
  hooks.egress = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(urlOf(input));
      record({
        hook: 'egress.fetch',
        url: url.href,
        inputType: typeof input === 'string' ? 'string' : input instanceof URL ? 'URL' : 'Request',
        method: init?.method ?? 'GET',
        redirect: init?.redirect,
        call: calls.getStore() ?? null,
      });
      if (url.hostname === 'sede.spain.test') {
        return new Response(SEDE_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (url.hostname === 'api.spain.test') return jsonResponse({ path: url.pathname });
      if (url.hostname === 'www.boe.es') return jsonResponse(BOE_BODY);
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    }) as typeof fetch,
    resolveHost: async (host) => {
      record({ hook: 'egress.resolveHost', host });
      return [{ address: '203.0.113.10' }];
    },
    onBlocked: ({ url, method, message }) => {
      record({
        hook: 'egress.onBlocked',
        url: url.href,
        method,
        message,
        call: calls.getStore() ?? null,
      });
    },
  };
}

if (config.research === 'key-server') {
  hooks.research = {
    backend: 'key server',
    tools: ({ language }) => [
      createKeyServerResearchTool({
        keyServerUrl: 'https://research.spain.test',
        apiKey: async () => 'sk-stub-key',
        language,
        fetch: researchFetch,
      }),
    ],
  };
} else if (config.research === 'exa') {
  hooks.research = {
    backend: 'exa',
    tools: ({ language }) =>
      createExaTools({
        apiKey: async () => undefined,
        language,
        fetch: (async () => {
          throw new Error('not reachable in this test');
        }) as typeof fetch,
      }),
  };
} else if (config.research === 'none') {
  hooks.research = { backend: undefined, tools: () => [] };
}

if (config.wrapTool) {
  hooks.wrapTool = (tool) =>
    config.wrapTool === 'rename'
      ? { ...tool, name: `${tool.name}_wrapped` }
      : {
          ...tool,
          execute: (id, params, signal, onUpdate, ctx) =>
            calls.run({ id, tool: tool.name }, async () => {
              record({ hook: 'wrapTool.start', tool: tool.name, id });
              const result = await tool.execute(id, params, signal, onUpdate, ctx);
              record({ hook: 'wrapTool.end', tool: tool.name, id });
              return result;
            }),
        };
}

if (config.onModel) {
  hooks.onModel = (model, resolved) => {
    record({
      hook: 'onModel',
      provider: model.provider,
      id: model.id,
      baseUrl: model.baseUrl,
      role: resolved.role,
    });
    if (config.onModel === 'global-fetch') {
      const realFetch = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        record({ hook: 'global-fetch', url: urlOf(input) });
        return realFetch(input, init);
      }) as typeof fetch;
    }
  };
}

if (config.now) {
  const { now } = config;
  hooks.now = () => {
    const iso = typeof now === 'string' ? now : readFileSync(now.file, 'utf8').trim();
    record({ hook: 'now', iso });
    return new Date(iso);
  };
}

runHost(process.env, hooks).catch((error: unknown) => {
  hostLog(
    'error',
    `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
