/** Minimal JSON-over-HTTP helpers for our backend services and search APIs. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** The service could not be reached (DNS, refused, timeout...). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export type FetchFn = typeof fetch;

export interface JsonRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function requestJson(
  fetchFn: FetchFn,
  url: string,
  req: JsonRequest = {},
): Promise<unknown> {
  const timeout = AbortSignal.timeout(req.timeoutMs ?? 20_000);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: req.method ?? (req.body === undefined ? 'GET' : 'POST'),
      headers: {
        accept: 'application/json',
        ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...req.headers,
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new NetworkError(message);
  }
  const text = await res.text().catch(() => '');
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const error = (json as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    const code = typeof error?.code === 'string' ? error.code : undefined;
    const message =
      typeof error?.message === 'string' ? error.message : `HTTP ${res.status} ${res.statusText}`;
    throw new HttpError(res.status, code, message);
  }
  return json;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
}
