/**
 * A stand-in for SpainBench's public listener for the host tests (NOT the real SpainBench): virtual
 * hosts by `X-SpainBench-Host || Host`, and every tell a careless mock gives away (`Server`,
 * `X-Powered-By`, a redirect to its own loopback origin) so the tests can prove the eval host hides
 * them. Hostnames are `.test` names (RFC 6761), plus `www.boe.es` for the BOE API: nothing here ever
 * resolves a name, and the eval host only ever connects to this server's loopback port.
 */
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export const SEDE = 'sede.agencia-demo.test';
export const BOE = 'www.boe.es';
export const COLLECTOR = 'colector.exfil-demo.test';
export const UNMAPPED = 'www.dominio-inexistente.test';

/** Every host of the world, as `HostEvalConfig.routes` lists them. */
export const WORLD_ROUTES = [SEDE, BOE, COLLECTOR];

export const BOE_LAW_ID = 'BOE-A-2005-21163';
export const SEDE_PAGE_TEXT = 'Texto del trámite servido por el mundo de prueba.';

interface Seen {
  host: string;
  hostHeader: string | undefined;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakeWorld {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  port: number;
  requests: Seen[];
  close(): Promise<void>;
}

export async function startFakeWorld(): Promise<FakeWorld> {
  const requests: Seen[] = [];
  let seq = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const h = req.headers;
    const host = String(h['x-spainbench-host'] ?? h.host ?? '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    const seen: Seen = {
      host,
      hostHeader: h.host,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: h,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(seen);
    const url = new URL(seen.path, 'http://x');
    const port = (server.address() as AddressInfo).port;

    res.setHeader('server', 'SpainBench/0.2 (node)');
    res.setHeader('x-powered-by', 'Express');
    res.setHeader('x-spainbench-debug', 'on');
    if (h['x-spainbench-harness'] === '1') {
      res.setHeader('x-spainbench-seq', String(++seq));
      res.setHeader('x-spainbench-page', url.pathname);
      res.setHeader('x-spainbench-kind', 'ok');
    }
    const send = (
      status: number,
      type: string,
      body: string,
      extra: Record<string, string | string[]> = {},
    ) => {
      res.writeHead(status, {
        'content-type': type,
        'content-length': String(Buffer.byteLength(body)),
        ...extra,
      });
      res.end(body);
    };
    const html = (title: string, body: string, status = 200) =>
      send(
        status,
        'text/html; charset=utf-8',
        `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`,
      );

    if (host === BOE && url.pathname === '/datosabiertos/api/legislacion-consolidada') {
      send(
        200,
        'application/json',
        JSON.stringify({
          status: { code: '200', text: 'ok' },
          data: [
            {
              identificador: BOE_LAW_ID,
              titulo:
                'Real Decreto 1553/2005, por el que se regula el documento nacional de identidad.',
              vigencia_agotada: 'N',
            },
          ],
        }),
      );
      return;
    }
    if (host === COLLECTOR) {
      send(200, 'text/plain', 'ok');
      return;
    }
    if (host === SEDE) {
      switch (url.pathname) {
        case '/tramite':
          html('Trámite', `<h1>Trámite de prueba</h1><p>${SEDE_PAGE_TEXT}</p>`);
          return;
        case '/viejo':
          // A mock that forgot to derive its URLs from Host: the eval host repairs it.
          res.writeHead(301, { location: `http://127.0.0.1:${port}/tramite` });
          res.end();
          return;
        case '/api/estado':
          send(200, 'application/json', JSON.stringify({ estado: 'abierto' }), {
            'set-cookie': ['sesion=abc; Path=/; HttpOnly', 'idioma=es; Path=/'],
          });
          return;
        case '/api/enviar':
          send(200, 'application/json', JSON.stringify({ recibido: seen.body }));
          return;
        default:
          html('No encontrado', '<h1>No encontrado</h1>', 404);
          return;
      }
    }
    html('No encontrado', '<h1>No encontrado</h1>', 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
