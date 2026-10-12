import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ASSISTANT_AGENT_ID,
  ASSISTANT_METHODS,
  type BridgeErrorCode,
  type BridgeMethod,
  BridgeParams,
  type BridgeResults,
  procedureMayCall,
} from '@sa/shared';
import type { z } from 'zod';
import { BridgeError } from '../core/errors';
import type { Logger } from '../core/logger';
import { errorMessage } from '../core/util';
import type { TokenRegistry } from './tokens';

export interface BridgeContext {
  /**
   * The calling agent: a procedure id, or ASSISTANT_AGENT_ID for the assistant. Methods are
   * gated by kind before handlers run, so procedure-scoped handlers always get a procedure id.
   */
  procedureId: string;
  /** Aborted when the agent's HTTP request closes (e.g. the run was aborted). */
  signal: AbortSignal;
}

export type BridgeParamsOut<M extends BridgeMethod> = z.output<(typeof BridgeParams)[M]>;

export type BridgeHandlers = {
  [M in BridgeMethod]: (
    params: BridgeParamsOut<M>,
    ctx: BridgeContext,
  ) => Promise<BridgeResults[M]>;
};

const STATUS: Record<BridgeErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  policy_denied: 403,
  not_found: 404,
  user_rejected: 409,
  internal: 500,
  browser_error: 502,
  unavailable: 503,
};

const METHOD_PATH = /^\/rpc\/([A-Za-z]+\.[A-Za-z]+)$/;

function isBridgeMethod(name: string): name is BridgeMethod {
  return Object.hasOwn(BridgeParams, name);
}

function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * The host bridge: HTTP on 127.0.0.1 (random port) for agent processes only.
 *   POST /rpc/<method>, Authorization: Bearer <per-agent token>, JSON body = params.
 *   200 {ok:true,result} | 4xx/5xx {ok:false,error:{code,message}}.
 * Requests with an Origin header (i.e. from a web page) are refused. Long-polling methods get
 * an AbortSignal that fires when the client closes the request.
 */
export class BridgeServer {
  private server?: Server;
  private baseUrl?: string;
  private port = 0;

  constructor(
    private readonly deps: {
      tokens: TokenRegistry;
      handlers: BridgeHandlers;
      logger: Logger;
      /** The agent a token belongs to still exists (the assistant, or a live procedure). */
      agentExists(id: string): boolean;
      maxBodyBytes?: number;
    },
  ) {}

  async listen(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    server.keepAliveTimeout = 5_000;
    server.timeout = 0;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.deps.logger.info(`host bridge listening on port ${this.port}`);
    return this.baseUrl;
  }

  url(): string {
    if (!this.baseUrl) throw new Error('Bridge not started');
    return this.baseUrl;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.baseUrl = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(json),
      'cache-control': 'no-store',
    });
    res.end(json);
  }

  private fail(res: ServerResponse, code: BridgeErrorCode, message: string): void {
    this.send(res, STATUS[code], { ok: false, error: { code, message } });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    if (req.headers.origin !== undefined) return this.fail(res, 'unauthorized', 'Forbidden');
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`)
      return this.fail(res, 'unauthorized', 'Forbidden');
    if (req.method !== 'POST') return this.fail(res, 'not_found', 'Use POST /rpc/<method>');

    const match = METHOD_PATH.exec((req.url ?? '').split('?')[0] ?? '');
    const methodName = match?.[1];
    if (!methodName || !isBridgeMethod(methodName))
      return this.fail(res, 'not_found', 'Unknown method');
    const method = methodName;

    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    const procedureId = this.deps.tokens.resolve(token);
    if (!procedureId || !this.deps.agentExists(procedureId))
      return this.fail(res, 'unauthorized', 'Invalid or expired token');
    const allowed =
      procedureId === ASSISTANT_AGENT_ID ? ASSISTANT_METHODS.has(method) : procedureMayCall(method);
    if (!allowed) return this.fail(res, 'policy_denied', 'This method is not available to you.');

    let raw: unknown;
    try {
      const text = await readBody(req, this.deps.maxBodyBytes ?? 1024 * 1024);
      raw = text.trim() ? JSON.parse(text) : {};
    } catch (err) {
      return this.fail(
        res,
        'bad_request',
        err instanceof BridgeError ? err.message : 'Body must be JSON',
      );
    }
    const parsed = BridgeParams[method].safeParse(raw);
    if (!parsed.success)
      return this.fail(res, 'bad_request', `Invalid params: ${summarizeZodError(parsed.error)}`);

    const log = this.deps.logger;
    try {
      const handler = this.deps.handlers[method] as (
        params: unknown,
        ctx: BridgeContext,
      ) => Promise<unknown>;
      const result = await handler(parsed.data, { procedureId, signal: controller.signal });
      log.debug(`rpc ${method} ok`, { procedureId, ms: Date.now() - started });
      this.send(res, 200, { ok: true, result });
    } catch (err) {
      if (err instanceof BridgeError) {
        log.info(`rpc ${method} -> ${err.code}`, {
          procedureId,
          ms: Date.now() - started,
          error: err.message,
        });
        return this.fail(res, err.code, err.message);
      }
      log.error(`rpc ${method} failed`, { procedureId, error: errorMessage(err) });
      return this.fail(res, 'internal', 'Internal error in the app');
    }
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new BridgeError('bad_request', 'Request body too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}
