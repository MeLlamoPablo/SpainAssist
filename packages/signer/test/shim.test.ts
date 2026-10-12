import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AfirmaCall, AfirmaReply } from '@sa/shared';
import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { CANCELLED_TYPE } from '../src/errors';
import { AUTOSCRIPT_SHIM_SOURCE } from '../src/shim';

const executable = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
);
const realScript = readFileSync(new URL('./fixtures/autoscript.min.js', import.meta.url), 'utf8');

describe.skipIf(!existsSync(executable))('real Chromium AutoScript interception', () => {
  it('preserves globals through double loads, callbacks, cancellation, iframes and strict CSP', async () => {
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      const context = await browser.newContext();
      const calls: AfirmaCall[] = [];
      const requests: string[] = [];
      let cancelled = false;
      await context.exposeBinding(
        '__saAfirma',
        async (_source, call: AfirmaCall): Promise<AfirmaReply> => {
          calls.push(call);
          return cancelled
            ? { ok: false, errorType: CANCELLED_TYPE, errorMessage: 'Cancelled' }
            : { ok: true, callbackArgs: ['c2ln', 'Y2VydA=='] };
        },
      );
      await context.addInitScript({ content: AUTOSCRIPT_SHIM_SOURCE });
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        requests.push(url);
        if (url.endsWith('/autoscript.js')) {
          await route.fulfill({ contentType: 'application/javascript', body: realScript });
        } else {
          await route.fulfill({
            contentType: 'text/html',
            headers: {
              'Content-Security-Policy': "default-src 'none'; script-src 'self'; frame-src 'self'",
            },
            body:
              '<script src="/autoscript.js"></script><script src="/autoscript.js"></script>' +
              (url.endsWith('/main') ? '<iframe src="/frame"></iframe>' : ''),
          });
        }
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('http://mock.invalid/main');
      // Avoid nested frame fixtures: the first iframe is sufficient.
      const outcome = await page.evaluate(async () => {
        const w = window as unknown as {
          AutoScript: Record<string, (...args: unknown[]) => unknown>;
          MiniApplet: unknown;
          Base64: unknown;
        };
        w.AutoScript.cargarAppAfirma();
        w.AutoScript.setForceWSMode(true);
        w.AutoScript.setServlets('/storage', '/retrieve');
        w.AutoScript.checkTime('CT_OBLIGATORY', 1);
        const globals = w.AutoScript === w.MiniApplet && !!w.Base64;
        const args = await new Promise<unknown[]>((resolve, reject) =>
          w.AutoScript.sign(
            'ZGF0YQ==',
            'SHA256withRSA',
            'CAdES',
            null,
            (...a: unknown[]) => resolve(a),
            (...a: unknown[]) => reject(a),
          ),
        );
        return { globals, args };
      });
      expect(outcome).toEqual({ globals: true, args: ['c2ln', 'Y2VydA=='] });
      cancelled = true;
      const error = await page.evaluate(async () => {
        const w = window as unknown as { AutoScript: { sign(...args: unknown[]): unknown } };
        return new Promise<unknown[]>((resolve) =>
          w.AutoScript.sign(
            'ZGF0YQ==',
            'SHA256',
            'CAdES',
            null,
            () => resolve(['unexpected']),
            (...args: unknown[]) => resolve(args),
          ),
        );
      });
      expect(error).toEqual([CANCELLED_TYPE, 'Cancelled', 'AS500001']);
      cancelled = false;
      const frame = page.frames().find((f) => f !== page.mainFrame());
      expect(frame).toBeDefined();
      await frame!.evaluate(async () => {
        const w = window as unknown as {
          MiniApplet: { selectCertificate(...args: unknown[]): unknown };
        };
        return new Promise((resolve, reject) =>
          w.MiniApplet.selectCertificate(null, resolve, reject),
        );
      });
      expect(calls.map((c) => c.method)).toEqual(['sign', 'sign', 'selectCertificate']);
      expect(
        requests.every((u) => /^http:\/\/mock.invalid\/(?:main|frame|autoscript.js)$/.test(u)),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 20000);
});
