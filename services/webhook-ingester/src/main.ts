// SpainAssist webhook ingester: the only public way into Coolify, whose dashboard and API are
// on the tailnet. Accepts GitHub's signed push webhooks on POST /github and forwards a rebuilt,
// re-signed copy to Coolify (see ingester.ts). Everything else gets a 404.
//
// Runs with Node's built-in TypeScript support and no dependencies (`node src/main.ts`), so the
// server needs no build or install: infra/terraform/webhook_ingester.tf uploads these files.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { type IngesterConfig, ingest } from './ingester.ts';

export interface ServerConfig extends IngesterConfig {
  /** Coolify's manual GitHub webhook endpoint. */
  coolifyUrl: string;
  /** GitHub's own cap on a delivery is 25 MB. */
  maxBodyBytes: number;
  forwardTimeoutMs: number;
}

const DELIVERY_ID = /^[0-9a-f-]{36}$/;
const MAX_REPLY_BYTES = 64 * 1024;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const secret = env.GITHUB_WEBHOOK_SECRET ?? '';
  const repository = env.GITHUB_REPOSITORY ?? '';
  if (secret.length < 16) throw new Error('GITHUB_WEBHOOK_SECRET must be at least 16 characters');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be owner/name');
  }
  return {
    secret,
    repository,
    coolifyUrl:
      env.COOLIFY_WEBHOOK_URL ?? 'http://coolify:8080/webhooks/source/github/events/manual',
    maxBodyBytes: 25 * 1024 * 1024,
    forwardTimeoutMs: 30_000,
  };
}

function send(res: ServerResponse, status: number, body: string, contentType = 'text/plain') {
  res.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  if (Number(req.headers['content-length'] ?? 0) > limit) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const header = (req: IncomingMessage, name: string) => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
};

/** Coolify's answer, for GitHub's delivery log (status and up to 64 KB of its body). */
async function forward(config: ServerConfig, body: string, signature: string) {
  const response = await fetch(config.coolifyUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-hub-signature-256': signature,
    },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(config.forwardTimeoutMs),
  });
  const text = (await response.text()).slice(0, MAX_REPLY_BYTES);
  const json = response.headers.get('content-type')?.startsWith('application/json') ?? false;
  return { status: response.status, text, json };
}

async function handle(config: ServerConfig, req: IncomingMessage, res: ServerResponse) {
  const path = req.url?.split('?')[0];
  if (req.method === 'GET' && path === '/health') return send(res, 200, 'ok');
  if (req.method !== 'POST' || path !== '/github') return send(res, 404, 'Not found');

  const body = await readBody(req, config.maxBodyBytes);
  if (body === null) return send(res, 413, 'Payload too large');
  const delivery = header(req, 'x-github-delivery') ?? '';
  const outcome = ingest(config, {
    event: header(req, 'x-github-event'),
    signature: header(req, 'x-hub-signature-256'),
    contentType: header(req, 'content-type'),
    body,
  });
  const log = (result: string) =>
    console.log(
      `delivery=${DELIVERY_ID.test(delivery) ? delivery : '-'} ${result} bytes=${body.length}`,
    );

  if (outcome.kind === 'reply') {
    log(`reply=${outcome.status}`);
    return send(res, outcome.status, outcome.message);
  }
  try {
    const coolify = await forward(config, outcome.body, outcome.signature);
    log(`forwarded coolify=${coolify.status}`);
    send(res, coolify.status, coolify.text, coolify.json ? 'application/json' : 'text/plain');
  } catch (error) {
    log(`forward-failed (${error instanceof Error ? error.name : 'error'})`);
    send(res, 502, 'Coolify unreachable');
  }
}

export function createIngester(config: ServerConfig): Server {
  const server = createServer((req, res) => {
    handle(config, req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'Internal error');
      else res.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8795);
  const server = createIngester(loadConfig());
  server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
    console.log(`webhook-ingester listening on :${port}`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
