/**
 * What can go wrong between the harness and SpainBench, as typed errors. `BenchError` is the
 * scoring API client's (`client.ts`); `BenchLaunchError` is the launcher's (`launcher.ts`).
 * Messages name the endpoint or the step and never carry the scoring token.
 */

export type BenchErrorCode =
  /** No answer: connection refused or reset, DNS, a timeout, a body cut short. Worth retrying. */
  | 'unreachable'
  /** The token was refused (HTTP 401 or 403). */
  | 'unauthorized'
  /** HTTP 404: no such world or download (or a path this server does not have). */
  | 'not_found'
  /** HTTP 410: the world was deleted, expired or replaced. */
  | 'gone'
  /** HTTP 409: the world exists, or a snapshot does not fit this server. */
  | 'conflict'
  /** Any other 4xx: the request was refused as malformed or not allowed. */
  | 'bad_request'
  /** HTTP 5xx. Worth retrying. */
  | 'server'
  /** The server answered, but not with what the contract says (not JSON, wrong fields, bad hash). */
  | 'invalid_response'
  /** The caller's own `AbortSignal` fired. */
  | 'aborted';

interface BenchErrorOptions {
  status?: number;
  cause?: unknown;
}

/**
 * A scoring API call that failed. `endpoint` is `METHOD /path` without the query; `message` is
 * `SpainBench <endpoint>: <detail>`.
 */
export class BenchError extends Error {
  readonly code: BenchErrorCode;
  readonly endpoint: string;
  /** The HTTP status, when the server answered. */
  readonly status?: number;

  constructor(
    code: BenchErrorCode,
    endpoint: string,
    detail: string,
    options: BenchErrorOptions = {},
  ) {
    super(
      `SpainBench ${endpoint}: ${detail}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'BenchError';
    this.code = code;
    this.endpoint = endpoint;
    if (options.status !== undefined) this.status = options.status;
  }

  /**
   * Whether asking again can help: the server was not reached, or it failed on its own. Every other
   * code is a mistake in the request, the setup or the server's contract that a retry repeats.
   */
  get retryable(): boolean {
    return this.code === 'unreachable' || this.code === 'server';
  }
}

export function isBenchError(error: unknown): error is BenchError {
  return error instanceof BenchError;
}

/** The server cannot be started, or never became ready (`startBench`). */
export class BenchLaunchError extends Error {
  /** The file the server's stdout and stderr go to, when it got that far. */
  readonly logFile?: string;
  /** The last lines of that file. */
  readonly logTail: string;
  /** The server could not bind one of the ports the launcher chose (another process took it). */
  readonly portConflict: boolean;

  constructor(
    message: string,
    options: { logFile?: string; logTail?: string; portConflict?: boolean; cause?: unknown } = {},
  ) {
    super(
      options.logTail ? `${message}\n--- last log lines ---\n${options.logTail}` : message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'BenchLaunchError';
    if (options.logFile !== undefined) this.logFile = options.logFile;
    this.logTail = options.logTail ?? '';
    this.portConflict = options.portConflict ?? false;
  }
}

/** `SPAINBENCH_*` settings that cannot be used (`resolveBenchTarget`, `connectBench`). */
export class BenchTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchTargetError';
  }
}

/** The server speaks another scoring API than this harness (`checkBenchVersion`). */
export class BenchVersionError extends Error {
  /** The server's `scoringApi`. */
  readonly serverApi: number;
  /** The one this harness supports. */
  readonly supportedApi: number;
  /** Which side has to be updated. */
  readonly older: 'server' | 'harness';

  constructor(options: { serverApi: number; supportedApi: number; message: string }) {
    super(options.message);
    this.name = 'BenchVersionError';
    this.serverApi = options.serverApi;
    this.supportedApi = options.supportedApi;
    this.older = options.serverApi < options.supportedApi ? 'server' : 'harness';
  }
}
