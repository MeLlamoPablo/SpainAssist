import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '../fixtures';

/**
 * Error reports, end to end: the built app sends to a local Sentry-compatible server
 * (SA_ERROR_REPORTS_DSN) what our GlitchTip would get. Uncaught errors in main and in the
 * renderer, and the main logger's warnings, including one logged before the gate opened.
 */

/** What the app sent: each event's text, its exception or its message. */
const received: string[] = [];

test.use({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures a function uses from it
  appEnv: async ({}, use) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push(...envelopeTexts(body));
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await use({
      SA_ERROR_REPORTS_DSN: `http://e2ekey@127.0.0.1:${port}/1`,
      SA_FEATURE_FLAGS: 'dnie-phone,error-reports',
      // A startup warning (env.ts), logged before the flags open the gate.
      SA_MAPS_SERVER_URL: 'not a url',
    });
    server.close();
  },
});

test('uncaught errors and logged warnings reach the error report server', async ({
  harness: h,
}) => {
  await h.app.evaluate(() => {
    setTimeout(() => {
      throw new Error('e2e: uncaught in main');
    });
  });
  await h.page.evaluate(() => {
    setTimeout(() => {
      throw new Error('e2e: uncaught in renderer');
    });
  });

  for (const text of [
    'SA_MAPS_SERVER_URL is not a valid http(s) URL; ignored',
    'e2e: uncaught in main',
    'e2e: uncaught in renderer',
  ])
    await expect.poll(() => received.some((r) => r.includes(text)), { timeout: 20_000 }).toBe(true);
});

/** The events of a Sentry envelope (a header line, then item header and payload lines). */
function envelopeTexts(body: string): string[] {
  const lines = body.split('\n').filter(Boolean);
  const texts: string[] = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    if (JSON.parse(lines[i] ?? '{}').type !== 'event') continue;
    const event = JSON.parse(lines[i + 1] ?? '{}');
    texts.push(event.exception?.values?.[0]?.value ?? event.message ?? '');
  }
  return texts;
}
