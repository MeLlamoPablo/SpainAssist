import type { ApiError, VoucherErrorCode } from '@sa/shared';

/** Error codes returned by the key server (the shared `VoucherErrorCode`s). */
export type KeyServerErrorCode = VoucherErrorCode;

export type HttpStatus = 400 | 401 | 402 | 403 | 404 | 409 | 410 | 413 | 429 | 500 | 502 | 503;

/** Thrown by handlers; rendered by the app's error handler as `{ error: { code, message } }`. */
export class HttpError extends Error {
  constructor(
    readonly status: HttpStatus,
    readonly code: KeyServerErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function errorBody(code: KeyServerErrorCode, message: string): ApiError {
  return { error: { code, message } };
}

/**
 * Error description safe for logs: class name and message only. Callers must make sure messages
 * of errors they create never contain secrets (keys, codes, tokens).
 */
export function errorSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
  return 'non-error thrown';
}
