import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { BridgeErrorCode, BridgeMethod, BridgeParamsOf, BridgeResults } from '@sa/shared';

/**
 * Client for the app's host bridge (see @sa/shared bridge.ts):
 *   POST {url}/rpc/{method}, Authorization: Bearer {token}, JSON body
 *   -> 200 { ok: true, result } | 4xx/5xx { ok: false, error: { code, message } }
 *
 * Built on node:http (not fetch): undici's default 300 s headers/body timeouts would kill
 * prompt.* requests that legitimately wait minutes for the user. Every call accepts the tool's
 * AbortSignal; aborting destroys the socket, which tells the app to cancel the pending request.
 */

export type BridgeClientErrorCode =
  | BridgeErrorCode
  | 'network'
  | 'aborted'
  | 'timeout'
  | 'bad_response';

export class BridgeError extends Error {
  readonly code: BridgeClientErrorCode;
  readonly status?: number;
  readonly method: string;

  constructor(code: BridgeClientErrorCode, message: string, method: string, status?: number) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.method = method;
    this.status = status;
  }
}

export interface BridgeCallOptions {
  signal?: AbortSignal;
  /** Override the per-method default timeout (ms). 0 = no timeout. */
  timeoutMs?: number;
}

/** Methods that may wait for the user (no timeout). */
const WAITS_FOR_USER: ReadonlySet<string> = new Set([
  'prompt.form',
  'prompt.confirm',
  'prompt.userAction',
  'browser.loginClave',
  'browser.fillFromUser',
  'browser.useCertificate',
]);

export function defaultBridgeTimeoutMs(method: string): number {
  if (WAITS_FOR_USER.has(method)) return 0;
  if (method === 'agent.credential') return 15_000;
  if (method === 'agent.refreshCredential') return 60_000;
  if (method.startsWith('browser.')) return 180_000;
  if (method.startsWith('research.') || method.startsWith('feedback.')) return 60_000;
  return 30_000;
}

export interface BridgeTransport {
  call<M extends BridgeMethod>(
    method: M,
    params: BridgeParamsOf<M>,
    options?: BridgeCallOptions,
  ): Promise<BridgeResults[M]>;
}

const MAX_RESPONSE_BYTES = 30 * 1024 * 1024;

export class BridgeClient implements BridgeTransport {
  private readonly base: URL;
  private readonly token: string;
  private readonly agent: HttpAgent | HttpsAgent;

  constructor(options: { url: string; token: string }) {
    if (!options.url) throw new Error('Bridge URL is missing (SA_BRIDGE_URL)');
    if (!options.token) throw new Error('Bridge token is missing (SA_BRIDGE_TOKEN)');
    this.base = new URL(options.url.endsWith('/') ? options.url : `${options.url}/`);
    this.token = options.token;
    this.agent =
      this.base.protocol === 'https:'
        ? new HttpsAgent({ keepAlive: true })
        : new HttpAgent({ keepAlive: true });
  }

  call<M extends BridgeMethod>(
    method: M,
    params: BridgeParamsOf<M>,
    options: BridgeCallOptions = {},
  ): Promise<BridgeResults[M]> {
    const url = new URL(`rpc/${method}`, this.base);
    const body = Buffer.from(JSON.stringify(params ?? {}), 'utf8');
    const timeoutMs = options.timeoutMs ?? defaultBridgeTimeoutMs(method);
    const signals = [
      options.signal,
      timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    ].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

    return new Promise<BridgeResults[M]>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(method, signal, options.signal));
        return;
      }
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(url, {
        method: 'POST',
        agent: this.agent,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'content-length': body.length,
          accept: 'application/json',
        },
      });

      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => {
        finish(() => reject(abortError(method, signal, options.signal)));
        req.destroy();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      req.on('error', (error) => {
        finish(() =>
          reject(new BridgeError('network', `Could not reach the app: ${error.message}`, method)),
        );
      });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(() =>
              reject(new BridgeError('bad_response', 'Bridge response too large', method)),
            );
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (error) => {
          finish(() => reject(new BridgeError('network', error.message, method)));
        });
        res.on('end', () => {
          finish(() => {
            const status = res.statusCode ?? 0;
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              reject(
                new BridgeError(
                  status >= 400 ? httpStatusCode(status) : 'bad_response',
                  `Bridge returned HTTP ${status} with a non-JSON body`,
                  method,
                  status,
                ),
              );
              return;
            }
            const envelope = parsed as
              | { ok: true; result: unknown }
              | { ok: false; error?: { code?: string; message?: string } }
              | undefined;
            if (envelope && envelope.ok === true) {
              resolve(envelope.result as BridgeResults[M]);
              return;
            }
            const error = envelope && envelope.ok === false ? envelope.error : undefined;
            reject(
              new BridgeError(
                (error?.code as BridgeErrorCode | undefined) ?? httpStatusCode(status),
                error?.message ?? `Bridge returned HTTP ${status}`,
                method,
                status,
              ),
            );
          });
        });
      });
      req.end(body);
    });
  }

  close(): void {
    this.agent.destroy();
  }
}

function httpStatusCode(status: number): BridgeClientErrorCode {
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 503) return 'unavailable';
  if (status >= 500) return 'internal';
  return 'bad_response';
}

function abortError(
  method: string,
  combined: AbortSignal | undefined,
  caller: AbortSignal | undefined,
): BridgeError {
  if (caller?.aborted) return new BridgeError('aborted', 'Cancelled', method);
  const reason = combined?.reason as { name?: string } | undefined;
  if (reason?.name === 'TimeoutError') {
    return new BridgeError('timeout', 'The app did not answer in time', method);
  }
  return new BridgeError('aborted', 'Cancelled', method);
}
