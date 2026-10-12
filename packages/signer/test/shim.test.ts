import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AFIRMA_NOTICE, type AfirmaCall, type AfirmaReply } from '@sa/shared';
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
      expect(calls.filter((c) => c.method !== AFIRMA_NOTICE).map((c) => c.method)).toEqual([
        'sign',
        'sign',
        'selectCertificate',
      ]);
      // The official 1.10.1 surface needs no stand-ins; the page's AutoScript is reported once.
      expect(
        await page.evaluate(
          () =>
            (window as unknown as Record<symbol, { diagnostics(): { stubbed: string[] } }>)[
              Symbol.for('sa.afirma.shim')
            ]!.diagnostics().stubbed,
        ),
      ).toEqual([]);
      expect(
        calls.filter((c) => c.method === AFIRMA_NOTICE && c.url === 'http://mock.invalid/main'),
      ).toEqual([
        {
          method: AFIRMA_NOTICE,
          args: ['loaded', '1.10.1'],
          origin: 'http://mock.invalid',
          url: 'http://mock.invalid/main',
        },
      ]);
      expect(
        requests.every((u) => /^http:\/\/mock.invalid\/(?:main|frame|autoscript.js)$/.test(u)),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 20000);

  it('answers every call of a platform copy of autoscript (gsede 1.8.0) and stands in for unknown ones', async () => {
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      const context = await browser.newContext();
      const calls: AfirmaCall[] = [];
      await context.exposeBinding(
        '__saAfirma',
        async (_source, call: AfirmaCall): Promise<AfirmaReply> => {
          calls.push(call);
          return { ok: true, callbackArgs: [] };
        },
      );
      await context.addInitScript({ content: AUTOSCRIPT_SHIM_SOURCE });
      // A platform's own copy: the real methods would launch AutoFirma; they must never run.
      const platformCopy = `var AutoScript = (function () {
        var fail = function () { document.title = 'REAL AUTOSCRIPT RAN'; };
        return {
          VERSION: '1.8.0', CHECKTIME_RECOMMENDED: 'CT_RECOMMENDED', SITE_FLAG: 'x',
          setWaitCertMaxLoops: fail, setWaitCertTimeout: fail, setForceWSMode: fail,
          checkTime: fail, setLocale: fail, cargarAppAfirma: fail, setServlets: fail,
          signBatch: fail, setSiteOption: fail, isSiteReady: fail
        };
      })();
      var MiniApplet = AutoScript;`;
      await context.route('**/*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<title>Acceso</title><script>${platformCopy}</script>`,
        }),
      );
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('http://mock.invalid/acceso');
      const outcome = await page.evaluate(async () => {
        const w = window as unknown as {
          AutoScript: Record<string, unknown> & Record<string, (...args: unknown[]) => unknown>;
        };
        const a = w.AutoScript;
        a.setForceWSMode(true);
        a.checkTime(a.CHECKTIME_RECOMMENDED, 60000, '/checktimeurl');
        a.setLocale('es_ES');
        a.setWaitCertMaxLoops(15);
        a.setWaitCertTimeout(4000);
        a.cargarAppAfirma('/base');
        a.setServlets('/storage', '/retrieve');
        const unknown = [a.setSiteOption(1), a.isSiteReady(), a.setSiteOption(2)];
        await new Promise((resolve, reject) =>
          a.signBatch('PHNpZ25iYXRjaC8+', '/pre', '/post', 'mode=implicit', resolve, reject),
        );
        return { version: a.VERSION, flag: a.SITE_FLAG, unknown, title: document.title };
      });
      expect(outcome).toEqual({
        version: '1.8.0',
        flag: 'x',
        unknown: [undefined, undefined, undefined],
        title: 'Acceso',
      });
      expect(errors).toEqual([]);
      const notices = calls.filter((c) => c.method === AFIRMA_NOTICE).map((c) => c.args);
      expect(notices).toEqual([
        ['loaded', '1.8.0'],
        ['ignored', 'setSiteOption'],
        ['ignored', 'isSiteReady'],
      ]);
      expect(calls.filter((c) => c.method !== AFIRMA_NOTICE).map((c) => c.method)).toEqual([
        'signBatch',
      ]);
      const stubbed = await page.evaluate(
        () =>
          (window as unknown as Record<symbol, { diagnostics(): { stubbed: string[] } }>)[
            Symbol.for('sa.afirma.shim')
          ]!.diagnostics().stubbed,
      );
      expect(stubbed).toEqual(['setSiteOption', 'isSiteReady']);
    } finally {
      await browser.close();
    }
  }, 20000);
});
