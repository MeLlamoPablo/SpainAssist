import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestService, page, startServer, type TestServer } from './helpers';

/**
 * `initScripts` run in every frame of every context before the page's own scripts: an embedder
 * (the eval suite removes WebRTC with one) changes what pages can see without touching the page.
 */

const READ = `document.title = 'marker=' + String(window.__marker) + ' second=' + String(window.__second);`;

let a: TestServer;
let b: TestServer;
let t: ReturnType<typeof createTestService>;

beforeAll(async () => {
  b = await startServer({
    '/frame': page(
      `<script>document.write('<p>el marco vio ' + window.__marker + '</p>');</script>`,
    ),
  });
  a = await startServer({
    '/page': page(
      `<script>${READ}</script><iframe title="marco" src="${b.origin}/frame"></iframe>
       <iframe title="vacio"></iframe>`,
      'unset',
    ),
  });
  t = createTestService({
    initScripts: [
      "window.__marker = 'set before the page';",
      "window.__second = 'and a second one';",
    ],
  });
});

afterAll(async () => {
  await t?.cleanup();
  await a?.close();
  await b?.close();
});

describe('initScripts', () => {
  it('run before the scripts of the page, all of them, in order', async () => {
    const obs = await t.service.open('init', `${a.origin}/page`);
    expect(obs.title).toBe('marker=set before the page second=and a second one');
  });

  it('run in the frames of the page too, other origins included', async () => {
    const obs = await t.service.open('init-frames', `${a.origin}/page`);
    // The frame is another origin: its own script wrote what it found into its body.
    expect(obs.snapshot).toContain('el marco vio set before the page');
  });
});
