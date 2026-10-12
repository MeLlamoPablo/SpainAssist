import { request } from 'node:https';

/**
 * A minimal fetch() over node:https that trusts `ca`: for Node-side clients of the mock in tests
 * (e.g. the signer's triphase and batch calls, which the app makes with net.fetch).
 */
export function trustingFetch(ca: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const body = typeof init?.body === 'string' ? init.body : '';
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        {
          method: init?.method ?? 'GET',
          headers: init?.headers as Record<string, string>,
          ca,
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 500,
                headers: Object.entries(res.headers).flatMap(([k, v]) =>
                  (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => [k, x]),
                ) as [string, string][],
              }),
            ),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }) as typeof fetch;
}
