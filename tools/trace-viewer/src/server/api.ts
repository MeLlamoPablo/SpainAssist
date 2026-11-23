/**
 * The viewer's local API, as a Vite plugin (loopback only):
 *
 *   GET  /api/source            what was opened: { name, kind: 'dir' | 'file', files }
 *   GET  /api/file?path=<rel>   one of those files
 *   POST /api/upload            keeps a dropped trace.zip in memory, answers { url }
 *   GET  /api/upload/<id>       it, for the Playwright trace viewer
 *   POST /api/format            a codemode module laid out by Biome (422 when it does not parse)
 *   GET  /playwright/...        Playwright's own trace viewer, from playwright-core
 *
 * Folders are listed only as far as traces go: sessions, agent and procedure records, zips.
 * Media, vault, work folders and logs are never listed nor served.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

const LISTED =
  /(?:\.jsonl|(?:^|\/)agent\.json|(?:^|\/)procedure\.json|(?:^|\/)capture\.json|\.zip)$/;
const SKIPPED_DIRS = new Set([
  'work',
  'media',
  'vault',
  'downloads',
  'crlset',
  'logs',
  'pages',
  'node_modules',
]);
const MAX_DEPTH = 6;
const MAX_UPLOADS = 4;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.zip': 'application/zip',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
};

export interface OpenedSource {
  name: string;
  kind: 'dir' | 'file';
  root: string;
  files: string[];
}

export function openSource(input: string): OpenedSource {
  const path = resolve(input);
  const stat = statSync(path);
  if (stat.isFile())
    return { name: path, kind: 'file', root: dirname(path), files: [basename(path)] };
  const files: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIPPED_DIRS.has(entry.name)) visit(full, depth + 1);
      } else if (entry.isFile()) {
        const rel = relative(path, full).split(sep).join('/');
        if (LISTED.test(rel)) files.push(rel);
      }
    }
  };
  // An eval run (`tools/eval`): its app profile and browser captures. The sessions' other copies
  // (`transcripts/`, `checkpoints/`) would show each agent three times.
  if (existsSync(join(path, 'run.json')) && existsSync(join(path, 'profile')))
    for (const name of ['profile', 'browser']) visit(join(path, name), 1);
  else visit(path, 0);
  return { name: path, kind: 'dir', root: path, files: files.sort() };
}

/** A codemode module laid out by Biome, or undefined when it does not parse. */
export function formatModule(source: string): Promise<string | undefined> {
  const biome = createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome');
  return new Promise((done) => {
    // Outside the repository, so that no biome.json changes the layout.
    const child = spawn(
      process.execPath,
      [
        biome,
        'format',
        '--stdin-file-path=module.js',
        '--indent-style=space',
        '--line-width=80',
        '--javascript-formatter-quote-style=single',
      ],
      { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', () => done(undefined));
    child.on('close', (code) => done(code === 0 ? out : undefined));
    child.stdin.end(source);
  });
}

/** Playwright's trace viewer (static files), from the playwright-core this package installs. */
function playwrightViewerDir(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json');
    const dir = join(dirname(pkg), 'lib', 'vite', 'traceViewer');
    return existsSync(join(dir, 'index.html')) ? dir : undefined;
  } catch {
    return undefined;
  }
}

export function tracesApi(input: string | undefined): Plugin {
  let source: OpenedSource | undefined;
  let problem: string | undefined;
  if (input) {
    try {
      source = openSource(input);
    } catch (err) {
      problem = `Cannot open ${input}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const viewer = playwrightViewerDir();
  const uploads = new Map<string, Buffer>();
  let uploadCount = 0;

  const send = (res: ServerResponse, status: number, body: string | object) => {
    res.statusCode = status;
    res.setHeader(
      'content-type',
      typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    );
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const sendFile = (res: ServerResponse, file: string) => {
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('content-length', String(statSync(file).size));
    res.setHeader('cache-control', 'no-store');
    createReadStream(file).pipe(res);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/source') {
      if (problem) return send(res, 500, problem);
      return send(
        res,
        200,
        source ? { name: source.name, kind: source.kind, files: source.files } : { name: null },
      );
    }
    if (url.pathname === '/api/file') {
      const rel = url.searchParams.get('path') ?? '';
      // Only what the listing named: never a path outside it.
      if (!source?.files.includes(rel)) return send(res, 404, 'Not found');
      return sendFile(res, join(source!.root, ...rel.split('/')));
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const id = `${++uploadCount}`;
      uploads.set(id, Buffer.concat(chunks));
      for (const key of uploads.keys()) if (uploads.size > MAX_UPLOADS) uploads.delete(key);
      return send(res, 200, { url: `/api/upload/${id}/trace.zip` });
    }
    if (url.pathname === '/api/format' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const formatted = await formatModule(Buffer.concat(chunks).toString('utf8'));
      if (formatted === undefined) return send(res, 422, 'The module does not parse');
      return send(res, 200, formatted);
    }
    const upload = /^\/api\/upload\/(\d+)\/trace\.zip$/.exec(url.pathname);
    if (upload) {
      const data = uploads.get(upload[1]!);
      if (!data) return send(res, 404, 'Not found');
      res.setHeader('content-type', 'application/zip');
      return res.end(data);
    }
    if (url.pathname === '/playwright' || url.pathname.startsWith('/playwright/')) {
      if (!viewer) return send(res, 404, 'playwright-core has no trace viewer');
      const rel = url.pathname.slice('/playwright/'.length) || 'index.html';
      const file = resolve(viewer, rel);
      if (!file.startsWith(viewer + sep) || !existsSync(file) || !statSync(file).isFile())
        return send(res, 404, 'Not found');
      // The viewer's service worker must control /playwright/ (its own folder).
      if (rel === 'sw.bundle.js') res.setHeader('service-worker-allowed', '/playwright/');
      return sendFile(res, file);
    }
    next();
  };

  return {
    name: 'sa-traces-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        handle(req, res, next).catch((err) => send(res, 500, String(err)));
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        handle(req, res, next).catch((err) => send(res, 500, String(err)));
      });
    },
  };
}
