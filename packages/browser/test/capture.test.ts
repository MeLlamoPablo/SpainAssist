import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Sidecar } from '@sa/sidecar';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { captureVariants, Scrubber } from '../src/capture';
import { withCaptureTool } from '../src/index';
import type { BrowserService } from '../src/types';
import { readZip } from '../src/zip';
import { createTestService, page, refOf, sendHtml, startServer, type TestServer } from './helpers';

const PASSWORD = 'P4ss&W0rd+<Clave>"';
const SMS_CODE = 'k7Q9zX31';
const USER = 'usuario.prueba';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let server: TestServer;
let root: string;

beforeAll(async () => {
  server = await startServer({
    '/login': page(
      `<form method="post" action="/session">
        <label>Usuario <input name="user"></label>
        <label>Contraseña <input name="password" type="password"></label>
        <label>Código SMS <input name="code"></label>
        <button type="submit">Entrar</button>
      </form>`,
      'Acceso',
    ),
    '/session': (_req, res, body) => {
      const form = new URLSearchParams(body.toString());
      const password = form.get('password') ?? '';
      const code = form.get('code') ?? '';
      // A careless site: echoes the secrets in a cookie, the HTML, a frame URL and an API call.
      sendHtml(
        res,
        page(
          `<p>Hola ${escapeHtml(form.get('user') ?? '')}</p>
          <input type="hidden" name="echo" value="${escapeHtml(password)}">
          <iframe src="/frame?code=${encodeURIComponent(code)}"></iframe>
          <script>
            fetch('/api/check?code=${encodeURIComponent(code)}', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ password: ${JSON.stringify(password).replace(/</g, '\\u003c')} }),
            });
          </script>`,
          'Bienvenida',
        ),
        { 'set-cookie': `token=${encodeURIComponent(password)}; Path=/` },
      );
    },
    '/frame': (req, res) => {
      const code = new URL(req.url ?? '/', 'http://x').searchParams.get('code') ?? '';
      sendHtml(res, page(`<p>Código ${escapeHtml(code)} recibido</p>`, 'Marco'));
    },
    '/inline.pdf': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(
        '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
      );
    },
    '/api/check': (_req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: JSON.parse(body.toString() || '{}') }));
    },
  });
});

afterAll(async () => {
  await server?.close();
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function setup(capture: boolean) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-capture-test-'));
  const captures = path.join(root, 'procedures');
  const scratch = path.join(root, 'scratch');
  const t = createTestService(
    capture
      ? {
          capture: {
            dir: (id) => (id === 'gone' ? undefined : path.join(captures, id, 'capture')),
            scratchDir: scratch,
          },
        }
      : {},
  );
  return { ...t, captures, scratch };
}

/** Logs in through the fixture, typing the password and the SMS code as secrets. */
async function login(service: BrowserService, pid: string): Promise<void> {
  let obs = await service.open(pid, `${server.origin}/login`);
  await service.type(pid, refOf(obs.snapshot, 'Usuario'), USER);
  await withCaptureTool({ tool: 'browser_fill_from_vault', args: { ref: 'x' } }, () =>
    service.type(pid, refOf(obs.snapshot, 'Contraseña'), PASSWORD, { secret: true }),
  );
  await service.type(pid, refOf(obs.snapshot, 'Código SMS'), SMS_CODE, { secret: true });
  obs = await service.click(pid, refOf(obs.snapshot, /button "Entrar"/));
  expect(obs.snapshot).toContain('Hola usuario.prueba');
  await service.wait(pid, { seconds: 0.5 });
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

/** Every byte of every file (and of every entry of zips) under `dir`, with what it is. */
async function contents(dir: string): Promise<{ name: string; data: Buffer }[]> {
  const out: { name: string; data: Buffer }[] = [];
  for (const file of await filesUnder(dir)) {
    const data = await fs.readFile(file);
    out.push({ name: file, data });
    if (data.subarray(0, 4).toString('latin1') === 'PK\x03\x04')
      for (const e of readZip(data)) out.push({ name: `${file}!${e.name}`, data: e.data });
  }
  return out;
}

function leaks(files: { name: string; data: Buffer }[], secrets: string[]): string[] {
  const found: string[] = [];
  for (const secret of secrets)
    for (const variant of captureVariants(secret))
      for (const f of files)
        if (f.data.includes(Buffer.from(variant, 'utf8'))) found.push(`${variant} in ${f.name}`);
  return found;
}

const sidecarPassword = () =>
  (globalThis as { testSidecar?: Sidecar }).testSidecar?.credentials.password ?? '';

describe('browser capture', () => {
  it('writes nothing when capture is off', async () => {
    const t = await setup(false);
    try {
      await login(t.service, 'p1');
      await t.service.close('p1');
    } finally {
      await t.cleanup();
    }
    expect(await filesUnder(root)).toEqual([]);
  });

  it('records a HAR, numbered HTML, a trace and actions.jsonl, with secrets scrubbed', async () => {
    const t = await setup(true);
    try {
      await login(t.service, 'p1');
      // Unscrubbed material only ever lives in the scratch directory while the context is open.
      expect(await filesUnder(t.captures)).toEqual([]);
      await t.service.close('p1');

      const runs = await fs.readdir(path.join(t.captures, 'p1', 'capture'));
      expect(runs).toHaveLength(1);
      const run = path.join(t.captures, 'p1', 'capture', runs[0]!);
      const names = (await filesUnder(run))
        .map((f) => path.relative(run, f).split(path.sep).join('/'))
        .sort();
      expect(names).toEqual(
        expect.arrayContaining([
          'actions.jsonl',
          'capture.json',
          'network.har',
          'pages/0001-t0-f0.html',
          'trace.zip',
        ]),
      );

      const actions = (await fs.readFile(path.join(run, 'actions.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(actions.map((a) => a.action)).toEqual([
        'open',
        'type',
        'type',
        'type',
        'click',
        'wait',
      ]);
      expect(actions.map((a) => a.step)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(actions[1]).toMatchObject({
        args: { text: USER, secret: false },
        target: { role: 'textbox', name: 'Usuario' },
      });
      expect(actions[2]).toMatchObject({
        tool: { tool: 'browser_fill_from_vault' },
        args: { text: '«secret:1»', secret: true },
        target: { role: 'textbox', name: 'Contraseña' },
      });
      expect(actions[3].args.text).toBe('«secret:2»');
      expect(actions[4]).toMatchObject({ target: { role: 'button', name: 'Entrar' } });
      const last = actions[5].pages[0];
      expect(last).toMatchObject({ active: true, title: 'Bienvenida' });
      expect(last.frames.length).toBe(2);
      const welcome = await fs.readFile(path.join(run, last.frames[0].file), 'utf8');
      expect(welcome).toContain('Hola usuario.prueba');
      expect(welcome).toContain('value="«secret:1»"');

      const har = JSON.parse(await fs.readFile(path.join(run, 'network.har'), 'utf8'));
      const post = har.log.entries.find(
        (e: { request: { method: string; url: string } }) =>
          e.request.method === 'POST' && e.request.url.endsWith('/session'),
      );
      expect(post.request.postData.text).toContain('«secret:1»');
      expect(post.request.postData.text).toContain(`user=${USER}`);
      expect(
        har.log.entries.some((e: { request: { url: string } }) =>
          e.request.url.includes('/api/check?code=«secret:2»'),
        ),
      ).toBe(true);

      const trace = readZip(await fs.readFile(path.join(run, 'trace.zip')));
      expect(trace.map((e) => e.name)).toEqual(expect.arrayContaining(['trace.trace']));

      // Every byte written, zips unpacked: no secret, in any encoding, and no proxy password.
      const written = await contents(run);
      expect(leaks(written, [PASSWORD, SMS_CODE, sidecarPassword()].filter(Boolean))).toEqual([]);
      // Nothing unscrubbed is left behind once the procedure's context is closed.
      expect(leaks(await contents(t.scratch), [PASSWORD, SMS_CODE])).toEqual([]);
    } finally {
      await t.cleanup();
    }
    expect(await filesUnder(t.scratch)).toEqual([]);
  });

  it('keeps the typed values when scrub is off, and still redacts the proxy password', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-capture-test-'));
    const captures = path.join(root, 'procedures');
    const t = createTestService({
      capture: {
        dir: (id) => path.join(captures, id),
        scratchDir: path.join(root, 'scratch'),
        scrub: false,
      },
    });
    try {
      await login(t.service, 'p1');
      await t.service.close('p1');
      const [run] = await fs.readdir(path.join(captures, 'p1'));
      const dir = path.join(captures, 'p1', run!);
      const written = await contents(dir);
      // Typed secrets stay (HAR body, HTML, actions, URLs) ...
      for (const secret of [PASSWORD, SMS_CODE])
        expect(leaks(written, [secret]).length, secret).toBeGreaterThan(0);
      const actions = (await fs.readFile(path.join(dir, 'actions.jsonl'), 'utf8'))
        .trim()
        .split('\n');
      expect(JSON.parse(actions[2]!).args).toMatchObject({ text: PASSWORD, secret: true });
      const info = JSON.parse(await fs.readFile(path.join(dir, 'capture.json'), 'utf8'));
      expect(info).toMatchObject({ secrets: 0, scrubbed: expect.stringContaining('NOT scrubbed') });
      // ... the sidecar's password does not.
      expect(leaks(written, [sidecarPassword()].filter(Boolean))).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });

  it('saves the run when asked (procedure stopped) and starts a new one on the next action', async () => {
    const t = await setup(true);
    try {
      await login(t.service, 'p1');
      await t.service.finishCapture('p1');
      const dir = path.join(t.captures, 'p1', 'capture');
      expect(await fs.readdir(dir)).toHaveLength(1);
      // Same cookies, a new context and run.
      const obs = await t.service.snapshot('p1');
      expect(obs.url).toContain('/session');
      await t.service.closeAll();
      expect(await fs.readdir(dir)).toHaveLength(2);
    } finally {
      await t.cleanup();
    }
  });

  it('saves the run of a context that showed a PDF inline (its HAR used to keep it from closing)', async () => {
    const t = await setup(true);
    try {
      const obs = await t.service.open('p1', `${server.origin}/inline.pdf`);
      expect(obs.downloads.map((d) => d.name)).toEqual(['inline.pdf']);
      await t.service.finishCapture('p1');
      const dir = path.join(t.captures, 'p1', 'capture');
      const [run] = await fs.readdir(dir);
      const info = JSON.parse(await fs.readFile(path.join(dir, run!, 'capture.json'), 'utf8'));
      expect(info).toMatchObject({ har: true, trace: true });
      await t.service.open('p1', `${server.origin}/inline.pdf`);
      await t.service.closeAll();
      expect(await fs.readdir(dir)).toHaveLength(2);
    } finally {
      await t.cleanup();
    }
  }, 30_000);

  it('discards the run of a procedure without a capture folder, and old scratch files', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-capture-test-'));
    const scratch = path.join(root, 'scratch');
    // Left by a crashed run.
    await fs.mkdir(path.join(scratch, 'old', 'runs', 'x'), { recursive: true });
    await fs.writeFile(path.join(scratch, 'old', 'runs', 'x', 'network.har'), PASSWORD);
    const t = createTestService({
      capture: { dir: () => undefined, scratchDir: scratch },
    });
    try {
      await login(t.service, 'gone');
      expect(await filesUnder(path.join(scratch, 'old'))).toEqual([]);
      await t.service.close('gone');
      expect(leaks(await contents(scratch), [PASSWORD, SMS_CODE])).toEqual([]);
    } finally {
      await t.cleanup();
    }
    expect(await filesUnder(root)).toEqual([]);
  });
});

describe('Scrubber', () => {
  it('replaces secrets in text, bytes and HAR bodies', () => {
    const scrub = new Scrubber(['a&b c', 'zz9'], ['proxy-pass']);
    expect(scrub.text('x=a%26b+c&y=zz9')).toBe('x=«secret:1»&y=«secret:2»');
    expect(scrub.text('<input value="a&amp;b c">')).toBe('<input value="«secret:1»">');
    expect(String(scrub.buffer(Buffer.from('{"p":"zz9"}')))).toBe('{"p":"«secret:2»"}');
    const har = scrub.har({
      headers: [
        { name: 'Proxy-Authorization', value: 'Basic abc' },
        { name: 'x', value: 'proxy-pass' },
      ],
      content: { encoding: 'base64', text: Buffer.from('id=zz9').toString('base64') },
    }) as {
      headers: { value: string }[];
      content: { text: string };
    };
    expect(har.headers.map((h) => h.value)).toEqual(['«redacted»', '«redacted»']);
    expect(Buffer.from(har.content.text, 'base64').toString()).toBe('id=«secret:2»');
  });
});
