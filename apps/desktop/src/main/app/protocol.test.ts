import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveAgentHostScript, withHostScript } from '../agents/host';
import {
  createAppProtocolHandler,
  isAppUrl,
  mimeTypeOf,
  RENDERER_CSP,
  resolveAppFile,
} from './protocol';

let root: string;
let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'sa-proto-'));
  root = join(base, 'renderer');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(join(base, 'secret.txt'), 'nope');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** The CSP of the `<meta>` tag in src/renderer/index.html (dev server and web build). */
async function rendererMetaCsp(): Promise<string | undefined> {
  const html = await readFile(new URL('../../renderer/index.html', import.meta.url), 'utf8');
  return /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1];
}

describe('app:// protocol', () => {
  it('maps app://bundle URLs to files inside the renderer root only', () => {
    expect(resolveAppFile(root, 'app://bundle/index.html')).toBe(join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://bundle/')).toBe(join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://bundle/assets/app.js')).toBe(join(root, 'assets', 'app.js'));
    expect(resolveAppFile(root, 'app://bundle/../secret.txt')).toBeNull();
    expect(resolveAppFile(root, 'app://bundle/%2e%2e/secret.txt')).toBeNull();
    expect(resolveAppFile(root, 'app://bundle/..%2fsecret.txt')).toBeNull();
    expect(resolveAppFile(root, 'app://other/index.html')).toBeNull();
    expect(resolveAppFile(root, 'app://bundle/missing.js')).toBeNull();
    expect(resolveAppFile(root, 'file:///etc/passwd')).toBeNull();
  });

  it('serves files with the CSP header and a JS MIME type', async () => {
    const handler = createAppProtocolHandler(root, async () => new Response('console.log(1)'));
    const res = await handler(new Request('app://bundle/assets/app.js'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(RENDERER_CSP);
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/);
    const missing = await handler(new Request('app://bundle/nope.js'));
    expect(missing.status).toBe(404);
    expect(mimeTypeOf('x.woff2')).toBe('font/woff2');
  });

  it('uses the same CSP as the <meta> tag of index.html (both apply)', async () => {
    expect(await rendererMetaCsp()).toBe(RENDERER_CSP);
  });

  it('recognizes the app origin (prod and dev server)', () => {
    expect(isAppUrl('app://bundle/index.html')).toBe(true);
    expect(isAppUrl('app://bundle.evil/index.html')).toBe(false);
    expect(isAppUrl('https://evil.example/')).toBe(false);
    expect(isAppUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(true);
    expect(isAppUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false);
    expect(isAppUrl(undefined)).toBe(false);
  });
});

describe('agent host script', () => {
  it('honors SA_AGENT_HOST and fails clearly when missing', async () => {
    const script = join(base, 'host.js');
    await writeFile(script, '');
    expect(resolveAgentHostScript({ override: script, fromUrl: import.meta.url })).toBe(script);
    expect(() =>
      resolveAgentHostScript({ override: join(base, 'missing.js'), fromUrl: import.meta.url }),
    ).toThrow(/SA_AGENT_HOST/);
  });

  it('prefers the host that packaging copies into the app', async () => {
    // Like app.asar: out/main/index.js, and agent-host/host.js next to it.
    const script = join(base, 'app', 'agent-host', 'host.js');
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, '');
    const fromUrl = pathToFileURL(join(base, 'app', 'out', 'main', 'index.js')).href;
    expect(resolveAgentHostScript({ fromUrl, appPath: join(base, 'app') })).toBe(script);
  });

  it('replaces the script argument of a launch', () => {
    const launch = { command: '/electron', args: ['/old/host.js', '--x'], env: {}, cwd: '/w' };
    expect(withHostScript(launch, '/new/host.js').args).toEqual(['/new/host.js', '--x']);
    expect(withHostScript({ ...launch, args: ['--x'] }, '/new/host.js').args).toEqual([
      '/new/host.js',
      '--x',
    ]);
  });
});
