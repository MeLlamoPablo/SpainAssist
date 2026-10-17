import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BridgeErrorCode } from '@sa/shared';

/** Thrown by a handler to answer with a bridge error envelope. */
export class FakeBridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface FakeBridgeCall {
  method: string;
  params: Record<string, unknown>;
  authorization?: string;
  /** The client closed the connection before we answered (abort). */
  aborted: boolean;
  answered: boolean;
}

export type FakeBridgeHandler = (
  params: Record<string, unknown>,
  call: FakeBridgeCall,
) => unknown | Promise<unknown>;

export interface FakeBridge {
  url: string;
  token: string;
  calls: FakeBridgeCall[];
  callsTo(method: string): FakeBridgeCall[];
  /** Resolves with the next call to `method` (or an earlier unconsumed one). */
  waitForCall(method: string, timeoutMs?: number): Promise<FakeBridgeCall>;
  /** Resolves when the call's connection is closed by the client. */
  waitForAbort(call: FakeBridgeCall, timeoutMs?: number): Promise<void>;
  setHandler(method: string, handler: FakeBridgeHandler): void;
  close(): Promise<void>;
}

/** Never resolves: simulates a prompt the user has not answered. */
export const hang: FakeBridgeHandler = () => new Promise(() => {});

export async function createFakeBridge(
  handlers: Record<string, FakeBridgeHandler> = {},
  token = 'test-bridge-token',
): Promise<FakeBridge> {
  const table = new Map(Object.entries(handlers));
  const calls: FakeBridgeCall[] = [];
  const waiters: { method: string; resolve: (call: FakeBridgeCall) => void }[] = [];
  const abortWaiters = new Map<FakeBridgeCall, () => void>();
  const consumed = new Set<FakeBridgeCall>();

  const server: Server = createServer((req, res) => {
    const method = decodeURIComponent((req.url ?? '').replace(/^\/rpc\//, ''));
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      const call: FakeBridgeCall = {
        method,
        params: body ? (JSON.parse(body) as Record<string, unknown>) : {},
        authorization: req.headers.authorization,
        aborted: false,
        answered: false,
      };
      calls.push(call);
      res.on('close', () => {
        if (!call.answered) {
          call.aborted = true;
          abortWaiters.get(call)?.();
        }
      });
      const waiter = waiters.findIndex((w) => w.method === method);
      if (waiter >= 0) {
        consumed.add(call);
        waiters.splice(waiter, 1)[0]?.resolve(call);
      }
      const send = (status: number, payload: unknown) => {
        if (res.destroyed) return;
        call.answered = true;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${token}`) {
        send(401, { ok: false, error: { code: 'unauthorized', message: 'bad token' } });
        return;
      }
      const handler = table.get(method);
      if (!handler) {
        send(404, { ok: false, error: { code: 'not_found', message: `No handler for ${method}` } });
        return;
      }
      try {
        const result = await handler(call.params, call);
        send(200, { ok: true, result });
      } catch (error) {
        if (error instanceof FakeBridgeError) {
          send(error.status, { ok: false, error: { code: error.code, message: error.message } });
        } else {
          send(500, { ok: false, error: { code: 'internal', message: String(error) } });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    calls,
    callsTo: (method) => calls.filter((c) => c.method === method),
    waitForCall(method, timeoutMs = 10_000) {
      const existing = calls.find((c) => c.method === method && !consumed.has(c));
      if (existing) {
        consumed.add(existing);
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No ${method} call`)), timeoutMs);
        waiters.push({
          method,
          resolve: (call) => {
            clearTimeout(timer);
            resolve(call);
          },
        });
      });
    },
    waitForAbort(call, timeoutMs = 10_000) {
      if (call.aborted) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Call was not aborted')), timeoutMs);
        abortWaiters.set(call, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    setHandler(method, handler) {
      table.set(method, handler);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
