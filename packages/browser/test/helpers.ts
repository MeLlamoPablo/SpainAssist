import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Sidecar } from '@sa/sidecar';
import { createBrowserService } from '../src/index';
import type { BrowserService, BrowserServiceOptions } from '../src/types';

// --- HTTP(S) fixture servers -------------------------------------------------------------------

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
) => void | Promise<void>;

export interface TestServer {
  /** e.g. http://localhost:51234 */
  origin: string;
  port: number;
  /** Paths requested, in order. */
  requests: string[];
  close(): Promise<void>;
}

export function page(body: string, title = 'Prueba'): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

export function sendHtml(
  res: ServerResponse,
  html: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

export async function startServer(
  routes: Record<string, Handler | string>,
  opts: {
    https?: https.ServerOptions;
    /** Hostname used in `origin` (the server listens on all loopback families). */
    host?: string;
  } = {},
): Promise<TestServer> {
  const requests: string[] = [];
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? '/', 'http://x');
    requests.push(url.pathname);
    const route = routes[url.pathname];
    try {
      if (typeof route === 'string') sendHtml(res, route);
      else if (route) await route(req, res, Buffer.concat(chunks));
      else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  };
  const server = opts.https ? https.createServer(opts.https, handler) : http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const scheme = opts.https ? 'https' : 'http';
  return {
    origin: `${scheme}://${opts.host ?? 'localhost'}:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// --- Service factory ---------------------------------------------------------------------------

export interface StoredDocument {
  procedureId: string;
  name: string;
  mimeType: string;
  data: Buffer;
  stagedPath: string;
}

export function createTestService(overrides: Partial<BrowserServiceOptions> = {}): {
  service: BrowserService;
  stored: StoredDocument[];
  media: Buffer[];
  downloadsDir: string;
  cleanup(): Promise<void>;
} {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-browser-test-'));
  const stored: StoredDocument[] = [];
  const media: Buffer[] = [];
  const service = createBrowserService({
    headless: true,
    downloadsDir,
    settleTimeoutMs: 5_000,
    onDownload: async (procedureId, file) => {
      const data = await fsp.readFile(file.path);
      stored.push({
        procedureId,
        name: file.suggestedName,
        mimeType: file.mimeType,
        data,
        stagedPath: file.path,
      });
      return {
        downloadId: `dl-${stored.length}`,
        name: file.suggestedName,
        mimeType: file.mimeType,
      };
    },
    saveMedia: async (_procedureId, jpeg) => {
      media.push(jpeg);
      return `img-${media.length}`;
    },
    // Like the app: every context goes through the TLS sidecar (test/sidecar.ts).
    certificates: (globalThis as { testSidecar?: Sidecar }).testSidecar,
    ...overrides,
  });
  return {
    service,
    stored,
    media,
    downloadsDir,
    cleanup: async () => {
      await service.closeAll();
      await fsp.rm(downloadsDir, { recursive: true, force: true });
    },
  };
}

/** Finds the ref of the first snapshot line matching `pattern`, e.g. /button "Entrar"/. */
export function refOf(snapshot: string, pattern: RegExp | string): string {
  for (const line of snapshot.split('\n')) {
    const matches = typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line);
    if (!matches) continue;
    const m = /\[ref=((?:f\d+)?e\d+)\]/.exec(line);
    if (m?.[1]) return m[1];
  }
  throw new Error(`No ref for ${pattern} in snapshot:\n${snapshot}`);
}
