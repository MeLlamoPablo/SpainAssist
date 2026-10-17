/**
 * The deny-by-default guard of the eval host: replaces `globalThis.fetch` and
 * `globalThis.WebSocket` so that only the model gateway can be reached for real. Everything else a
 * host process might do through them (BOE, Exa, pi's own calls, an unwired tool) fails like a dead
 * network and is logged as `route: 'denied'`. The tools' real traffic never comes here: the eval
 * host gives them `createWorldFetch` (`egress.fetch`).
 *
 * Underneath, `node-guard.ts` closes the other doors of the process (TCP sockets, DNS, UDP, child
 * processes) to the same allow-list plus the origins that are only reachable by socket (the mock
 * and the bridge), and logs what it refuses the same way.
 *
 * Plain Node: bundled into the eval host. Never print to stdout (the host's RPC channel).
 */
import type { NetChannel, NetRecord } from '../contracts';
import { isLoopbackHost, normalizeHost } from './hosts';
import { bodyFields, headersToRecord, type NetLog } from './netlog';
import { installNodeGuard, type Refusal } from './node-guard';
import { fetchFailed, readRequestBody } from './wire';
import { channelOfTool, currentCallContext } from './world-fetch';

export interface EgressGuardOptions {
  /**
   * Origins that may be reached for real: the model gateway (`https://chatgpt.com`,
   * `http://127.0.0.1:<meter port>`). `ws://` and `wss://` are the same origin as `http://` and
   * `https://`.
   */
  allowOrigins: Iterable<string>;
  /**
   * Origins the process may also open sockets to (and resolve the names of), but not through the
   * global `fetch`: the mock's public listener (`createWorldFetch` connects with `node:http`) and
   * the bridge to the app.
   */
  socketOrigins?: Iterable<string>;
  log: NetLog;
  /** What allowed requests go through. Default: the globals when the guard is created. */
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
}

export interface EgressGuard {
  readonly fetch: typeof fetch;
  readonly WebSocket: typeof WebSocket;
  /** Allows one more origin (the model's `baseUrl`, known when the model is). */
  allow(origin: string): void;
  allowedOrigins(): string[];
  /**
   * Replaces `globalThis.fetch` and `globalThis.WebSocket` and closes the process' sockets, DNS,
   * UDP and child processes (`node-guard.ts`). Returns the function that puts everything back.
   */
  install(): () => void;
}

function httpOrigin(origin: string): string {
  return new URL(origin.replace(/^ws(s?):/i, 'http$1:')).origin;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createEgressGuard(opts: EgressGuardOptions): EgressGuard {
  const { log } = opts;
  const realFetch = opts.fetch ?? globalThis.fetch;
  const RealWebSocket = opts.WebSocket ?? globalThis.WebSocket;
  const allowed = new Set<string>();
  const allow = (origin: string) => {
    allowed.add(httpOrigin(origin));
  };
  for (const origin of opts.allowOrigins) allow(origin);
  const socketOnly = new Set<string>();
  for (const origin of opts.socketOrigins ?? []) socketOnly.add(httpOrigin(origin));
  /** The host and port of every origin a socket may be opened to. */
  const endpoints = () =>
    [...allowed, ...socketOnly].map((origin) => {
      const url = new URL(origin);
      return { host: normalizeHost(url.hostname), port: portOf(url) };
    });

  /** One record for a request to the gateway (metadata only) or for a refused one. */
  const record = (
    rest: Pick<NetRecord, 'method' | 'url' | 'host' | 'route'> & Partial<NetRecord>,
    started: number,
    seq: number,
    t: string,
  ) => {
    const ctx = currentCallContext();
    const channel: NetChannel = rest.route === 'llm' ? 'llm' : channelOfTool(ctx?.tool);
    log.append({
      seq,
      t,
      channel,
      ...(rest.route !== 'llm' && ctx?.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
      reqHeaders: {},
      durationMs: Math.round(performance.now() - started),
      ...rest,
    });
  };

  /** A refusal of `node-guard.ts` as the same kind of record a refused `fetch` leaves. */
  const recordRefusal = (refusal: Refusal) => {
    const seq = log.nextSeq();
    const t = log.stamp();
    switch (refusal.kind) {
      case 'connect': {
        const target = refusal.path
          ? `unix:${encodeURI(refusal.path)}`
          : `tcp://${refusal.host.includes(':') ? `[${refusal.host.replace(/^\[|\]$/g, '')}]` : refusal.host}:${refusal.port}/`;
        record(
          {
            method: 'CONNECT',
            url: target,
            host: refusal.host,
            route: 'denied',
            error: `denied: ${refusal.path ?? `${refusal.host}:${refusal.port}`} is not reachable from this process`,
          },
          performance.now(),
          seq,
          t,
        );
        return;
      }
      case 'dns':
        record(
          {
            method: 'DNS',
            url: `dns://${refusal.host || 'localhost'}/`,
            host: refusal.host,
            route: 'denied',
            error: `denied: ${refusal.call} of ${refusal.host} is not allowed in this process`,
          },
          performance.now(),
          seq,
          t,
        );
        return;
      case 'udp':
        record(
          {
            method: 'UDP',
            url: `udp://${refusal.host}${refusal.port ? `:${refusal.port}` : ''}/`,
            host: refusal.host,
            route: 'denied',
            error: 'denied: this process opens no UDP traffic',
          },
          performance.now(),
          seq,
          t,
        );
        return;
      case 'spawn': {
        const program = refusal.command.trim().split(/\s+/)[0] ?? '';
        record(
          {
            method: 'SPAWN',
            url: `spawn://${encodeURIComponent(program.split(/[\\/]/).pop() ?? program)}/`,
            host: program,
            route: 'denied',
            // The command line, so that a canary in its arguments is seen by the scan.
            ...bodyFields(Buffer.from(refusal.command), Buffer.byteLength(refusal.command)),
            error: 'denied: this process starts no network client or interpreter',
          },
          performance.now(),
          seq,
          t,
        );
        return;
      }
    }
  };

  const guardedFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      return realFetch(input, init); // no host to reach: fetch fails on its own
    }
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const seq = log.nextSeq();
    const t = log.stamp();
    const started = performance.now();
    if (allowed.has(url.origin)) {
      // Metadata only: the model traffic is the meter's to record.
      const shown = {
        method,
        url: `${url.origin}${url.pathname}`,
        host: url.hostname,
        route: 'llm' as const,
      };
      try {
        const response = await realFetch(input, init);
        record({ ...shown, status: response.status }, started, seq, t);
        return response;
      } catch (err) {
        record({ ...shown, error: describeError(err) }, started, seq, t);
        throw err;
      }
    }
    const sent = await attemptedRequest(input, init);
    record(
      {
        method,
        url: url.href,
        host: url.hostname,
        route: 'denied',
        ...sent,
        error: `denied: ${url.origin} is not an allowed origin`,
      },
      started,
      seq,
      t,
    );
    throw fetchFailed('ENOTFOUND', url.hostname, { port: portOf(url) });
  };

  const GuardedWebSocket = function GuardedWebSocket(
    url: string | URL,
    protocols?: string | string[] | Record<string, unknown>,
  ) {
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      return new RealWebSocket(url, protocols as string | string[]); // throws its own SyntaxError
    }
    const seq = log.nextSeq();
    const t = log.stamp();
    const started = performance.now();
    if (allowed.has(httpOrigin(parsed.href))) {
      record(
        {
          method: 'GET',
          url: `${parsed.origin}${parsed.pathname}`,
          host: parsed.hostname,
          route: 'llm',
        },
        started,
        seq,
        t,
      );
      return new RealWebSocket(url, protocols as string | string[]);
    }
    record(
      {
        method: 'GET',
        url: parsed.href,
        host: parsed.hostname,
        route: 'denied',
        error: `denied: ${httpOrigin(parsed.href)} is not an allowed origin`,
      },
      started,
      seq,
      t,
    );
    return new DeniedWebSocket(parsed.href);
  } as unknown as typeof WebSocket;
  GuardedWebSocket.prototype = RealWebSocket.prototype;
  for (const name of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const)
    Object.defineProperty(GuardedWebSocket, name, { value: RealWebSocket[name] });

  return {
    fetch: guardedFetch as typeof fetch,
    WebSocket: GuardedWebSocket,
    allow,
    allowedOrigins: () => [...allowed],
    install() {
      const previousFetch = globalThis.fetch;
      const previousWebSocket = globalThis.WebSocket;
      globalThis.fetch = guardedFetch as typeof fetch;
      globalThis.WebSocket = GuardedWebSocket;
      const restoreNode = installNodeGuard({
        mayConnect: (host, port) => {
          const wanted = normalizeHost(host);
          return endpoints().some(
            (endpoint) =>
              endpoint.port === port &&
              (endpoint.host === wanted ||
                (isLoopbackHost(endpoint.host) && isLoopbackHost(wanted))),
          );
        },
        mayResolve: (host) => {
          const wanted = normalizeHost(host);
          return isLoopbackHost(wanted) || endpoints().some((endpoint) => endpoint.host === wanted);
        },
        refused: (refusal) => recordRefusal(refusal),
      });
      return () => {
        restoreNode();
        if (globalThis.fetch === (guardedFetch as typeof fetch)) globalThis.fetch = previousFetch;
        if (globalThis.WebSocket === GuardedWebSocket) globalThis.WebSocket = previousWebSocket;
      };
    },
  };
}

function portOf(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443;
}

/** What a refused request tried to send (headers, body), for the record. Never throws. */
async function attemptedRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<Pick<NetRecord, 'reqHeaders' | 'reqBody' | 'reqBodyEncoding' | 'reqBodyBytes'>> {
  try {
    const fromRequest = input instanceof Request ? input : undefined;
    const headers = headersToRecord(new Headers(init?.headers ?? fromRequest?.headers));
    let bytes: Buffer | undefined;
    if (init?.body !== undefined)
      bytes = (await readRequestBody(init.body as BodyInit | null))?.bytes;
    else if (fromRequest?.body) bytes = Buffer.from(await fromRequest.clone().arrayBuffer());
    return { reqHeaders: headers, ...bodyFields(bytes, bytes?.length ?? 0) };
  } catch {
    return { reqHeaders: {} };
  }
}

/**
 * What `new WebSocket(...)` gives for a host that does not exist: a socket that never opens, then
 * reports an error and closes with code 1006.
 */
class DeniedWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  readonly bufferedAmount = 0;
  readonly extensions = '';
  readonly protocol = '';
  binaryType: BinaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    super();
    setTimeout(() => {
      this.readyState = DeniedWebSocket.CLOSED;
      this.emit(new Event('error'), this.onerror);
      const close = new Event('close');
      Object.assign(close, { code: 1006, reason: '', wasClean: false });
      this.emit(close, this.onclose);
    }, 0);
  }

  send(): void {
    throw new DOMException('Still in CONNECTING state.', 'InvalidStateError');
  }

  close(): void {}

  private emit(event: Event, handler: ((event: Event) => void) | null): void {
    handler?.call(this, event);
    this.dispatchEvent(event);
  }
}
