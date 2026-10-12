import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The renderer is served from a privileged `app://bundle/` origin (not file://), with the CSP as
 * a response header on every file (tested setup: docs/research/mrz-ocr.md §8.1.5).
 */
export const APP_SCHEME = 'app';
export const APP_HOST = 'bundle';
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

/** Same policy as the <meta> tag in src/renderer/index.html. */
export const RENDERER_CSP =
  "default-src 'self'; script-src 'self'; worker-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; font-src 'self' data:; connect-src 'self'";

export const APP_SCHEME_PRIVILEGES = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeTypeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Maps an app:// URL to a file inside `root`, or null (other host, traversal, missing). */
export function resolveAppFile(root: string, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname === '' || pathname === '/') pathname = '/index.html';
  const base = normalize(root);
  const file = normalize(join(base, pathname));
  if (!file.startsWith(base + sep)) return null;
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return file;
}

/** True for the app's own pages: app://bundle/... (prod) or the Vite dev server origin. */
export function isAppUrl(url: string | undefined, devUrl?: string): boolean {
  if (!url) return false;
  if (url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) return true;
  if (!devUrl) return false;
  try {
    return new URL(url).origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
}

/** Handler for protocol.handle(APP_SCHEME, ...), given Electron's net.fetch. */
export function createAppProtocolHandler(
  root: string,
  fetchFile: (fileUrl: string) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const file = resolveAppFile(root, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    const res = await fetchFile(pathToFileURL(file).toString());
    return new Response(res.body, {
      status: res.status,
      headers: {
        'content-type': mimeTypeOf(file),
        'content-security-policy': RENDERER_CSP,
        'x-content-type-options': 'nosniff',
      },
    });
  };
}
