/**
 * Builds the whole main process (createMainServices) with fakes for Electron and the library
 * packages, in a temporary userData directory. Used by the main-process tests.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_AGENT_ID,
  type BridgeMethod,
  type FeatureFlags,
  type PromptItem,
  type SaArgs,
  type SaEvent,
  type SaMethod,
  type SaResult,
} from '@sa/shared';
import type { SaEnv } from '../app/env';
import { createAppPaths } from '../app/paths';
import { createMainServices, type MainDeps, type MainServices } from '../app/services';
import { createLogger } from '../core/logger';
import { type Biometric, noBiometric, type ProviderLib } from '../ports';
import type { FetchFn } from '../remote/http';
import {
  basicPii,
  createFakeAgentLib,
  createFakeProviderLib,
  FakeBrowser,
  fakeKeyProvider,
  MemoryVault,
} from './fakes';

export const APP_PAGE = 'app://bundle/index.html';

export interface TestAppOptions {
  env?: Partial<SaEnv>;
  providerLib?: ProviderLib;
  /** fetch used for backends (key server, feedback server, Exa). Default: always offline. */
  fetch?: FetchFn;
  biometric?: Biometric;
  idleMs?: number;
  certificateOrigins?: string[];
  startSidecar?: MainDeps['startSidecar'];
  /** Feature flags. Default: every feature on. */
  features?: Partial<FeatureFlags>;
  /** The relay socket for DNIe signatures (with `env.relayServerUrl`). */
  relaySocket?: typeof WebSocket;
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Bridge response as seen by tests (results are loosely typed on purpose). */
export interface RpcBody {
  ok: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: test convenience for deep result assertions
  result?: any;
  error?: { code: string; message: string };
}

export const offlineFetch: FetchFn = async () => {
  throw new TypeError('fetch failed');
};

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: parsed JSON bodies inspected by tests
  body: any;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch that records requests and answers with `handler` (offline backends for tests). */
export function createFakeFetch(
  handler: (req: FakeRequest) => Response | Promise<Response>,
): FetchFn & {
  requests: FakeRequest[];
} {
  const requests: FakeRequest[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const req: FakeRequest = {
      method: init?.method ?? 'GET',
      url,
      headers: new Headers(init?.headers),
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(req);
    return handler(req);
  }) as FetchFn & { requests: FakeRequest[] };
  fn.requests = requests;
  return fn;
}

export async function createTestApp(opts: TestAppOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sa-main-test-'));
  const paths = createAppPaths(join(dir, 'userData'), join(dir, 'os-tmp'));
  const logLines: string[] = [];
  const logger = createLogger({ level: 'debug', sinks: [(line) => logLines.push(line)] });
  const vault = new MemoryVault({ backend: 'test', secure: false });
  const browser = new FakeBrowser();
  const agentLib = createFakeAgentLib();
  const backendFetch = opts.fetch ?? offlineFetch;
  const providerLib = opts.providerLib ?? createFakeProviderLib();
  const opened: string[] = [];
  const openedPaths: string[] = [];
  let relaunched = 0;

  const mainDeps: MainDeps = {
    env: {
      e2e: true,
      keyServerUrl: 'http://127.0.0.1:8787',
      feedbackServerUrl: 'http://127.0.0.1:8788',
      flagsToken: 'default:development.test',
      extraTrustedHosts: [],
      warnings: [],
      ...opts.env,
    },
    paths,
    documentDownloadsDir: join(dir, 'Downloads'),
    logger,
    appInfo: {
      name: 'Spain Assist',
      version: '0.0.0-test',
      platform: 'darwin',
      isDev: true,
      isE2E: true,
      features: { feedbackServer: true, dniePhone: true, mustUpdate: false, ...opts.features },
    },
    keyProvider: fakeKeyProvider(),
    biometric: opts.biometric ?? noBiometric,
    openVault: async () => vault,
    agentLib,
    providerLib,
    browserFactory: () => browser,
    startSidecar: opts.startSidecar,
    certificateOrigins: opts.certificateOrigins ?? ['https://pasarela-ident.clave.gob.es'],
    pii: basicPii,
    fetch: backendFetch,
    openExternal: async (url) => {
      opened.push(url);
    },
    revealWindow: () => {},
    openPath: async (path) => {
      openedPaths.push(path);
      return '';
    },
    relaunch: () => {
      relaunched++;
    },
    hostScript: () => '/app/packages/agent/dist/host.js',
    nodeBinary: '/fake/electron',
    electronRunAsNode: true,
    isTrustedSender: (ctx) => ctx.isMainFrame && ctx.senderUrl === APP_PAGE,
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
    ...(opts.relaySocket ? { relaySocket: opts.relaySocket } : {}),
  };

  let services: MainServices = await createMainServices(mainDeps);

  const events: SaEvent[] = [];
  services.events.on((e) => events.push(structuredClone(e)));

  function invoke<M extends SaMethod>(method: M, ...args: SaArgs<M>): Promise<SaResult<M>> {
    return services.router.dispatch(method, args, {
      senderUrl: APP_PAGE,
      isMainFrame: true,
    }) as Promise<SaResult<M>>;
  }

  async function rpc(
    method: BridgeMethod | string,
    params: unknown,
    token: string | undefined,
    init: { signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: RpcBody }> {
    const res = await fetch(`${services.bridge.url()}/rpc/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
      body: JSON.stringify(params),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    return { status: res.status, body: (await res.json()) as RpcBody };
  }

  /** Creates a procedure without starting an agent and issues a bridge token for it. */
  async function procedureWithToken(title = 'Trámite de prueba') {
    const procedure = await services.procedures.create(title);
    const token = services.tokens.issue(procedure.id);
    return { procedureId: procedure.id, token };
  }

  /** Waits until `predicate` holds (polling), for async background work. */
  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /**
   * The oldest pending prompt of an agent: the assistant's are in the conversation, a
   * procedure's on its card (runtime).
   */
  function pendingPrompt(agentId: string = ASSISTANT_AGENT_ID): PromptItem | undefined {
    if (agentId !== ASSISTANT_AGENT_ID)
      return services.procedures.get(agentId)?.runtime.prompts?.[0];
    return services.conversation
      .transcript()
      .find((i): i is PromptItem => i.type === 'prompt' && i.status === 'pending');
  }

  /** The latest agent client (and its launch) started for an agent id. */
  function agentFor(agentId: string) {
    const index = agentLib.launches.findLastIndex((l) => l.config.procedureId === agentId);
    const launch = agentLib.launches[index];
    const client = agentLib.clients.find(
      (c) => c.launch.env.SA_BRIDGE_TOKEN === launch?.bridge.token,
    );
    return launch && client ? { launch, client, token: launch.bridge.token } : undefined;
  }

  /** Sends a chat message and waits until the assistant got it. */
  async function say(text: string) {
    await invoke('chat.send', { text });
    await services.chat.settled();
    const assistant = agentFor(ASSISTANT_AGENT_ID);
    if (!assistant) throw new Error('The assistant did not start');
    return assistant;
  }

  /**
   * Starts a procedure the way the assistant does (bridge `procedures.start` with the
   * assistant's token) and waits until its agent got the brief.
   */
  async function startProcedure(title = 'Renovar el DNI', brief = 'Quiere renovar el DNI.') {
    const assistant = agentFor(ASSISTANT_AGENT_ID) ?? (await say('Hola'));
    const res = await rpc('procedures.start', { title, brief }, assistant.token);
    if (!res.body.ok) throw new Error(`procedures.start failed: ${res.body.error?.message}`);
    const procedureId: string = res.body.result.procedureId;
    await services.coordinator.settled();
    return { procedureId, assistant, agent: agentFor(procedureId) };
  }

  async function close() {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
  }

  return {
    dir,
    paths,
    get services() {
      return services;
    },
    /** A new launch on the same data; `features` changes flags, which are read at start-up. */
    async restart(features?: Partial<FeatureFlags>) {
      await services.shutdown();
      if (features)
        mainDeps.appInfo = {
          ...mainDeps.appInfo,
          features: { ...mainDeps.appInfo.features, ...features },
        };
      services = await createMainServices(mainDeps);
      services.events.on((e) => events.push(structuredClone(e)));
    },
    vault,
    browser,
    agentLib,
    providerLib,
    events,
    logLines,
    opened,
    openedPaths,
    relaunched: () => relaunched,
    invoke,
    rpc,
    procedureWithToken,
    waitFor,
    pendingPrompt,
    agentFor,
    say,
    startProcedure,
    close,
  };
}
