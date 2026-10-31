import { existsSync } from 'node:fs';
import { FNMT_ERROR, FNMT_NOTICE, type FnmtCall, type FnmtReply } from '@sa/shared';
import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { FNMT_SHIM_SOURCE } from '../src/shim';

const installed = existsSync(chromium.executablePath());

/**
 * Stand-in for FNMT's fnmtcertrq.js (not in the repository): the same global, built the same
 * way (a top-level `var` assigned from an IIFE taking `window`), with the same public members.
 * Without the shim, requestCert launches `fnmtcr://` and its callbacks never run.
 */
const FAKE_FNMT_SCRIPT = `
var FnmtCertRequest = (function (win, undef) {
  var launched = [];
  return {
    VERSION: '1.6.4',
    cargarAppFnmt: function () {},
    setServlets: function () {},
    requestCert: function (ok, ko) { launched.push('fnmtcr://request'); },
    installCert: function (ok, ko, cert) { launched.push('fnmtcr://install'); },
    getBase64FromText: function (text) { return win.btoa(text); },
    getTextFromBase64: function (b64) { return win.atob(b64); },
    downloadRemoteData: function () {},
    getErrorMessage: function () { return ''; },
    getErrorType: function () { return ''; },
    isAndroid: function () { return false; },
    isIOS: function () { return false; },
    pingApp: function () { launched.push('fnmtcr://ping'); },
    launched: launched
  };
})(window, undefined);
`;

const PAGE = `<!doctype html><form><input name="PKCS10" value=""></form>
<script src="/fnmtcertrq.js"></script>`;

describe.skipIf(!installed)('real Chromium FnmtCertRequest interception', () => {
  it('forwards requestCert and installCert, refuses cards and keeps the page helpers', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const calls: FnmtCall[] = [];
      let next: FnmtReply = { ok: true, result: 'TUlJQ1BLQ1MxMA==' };
      await context.exposeBinding('__saFnmt', async (_source, call: FnmtCall) => {
        calls.push(call);
        return call.method === FNMT_NOTICE ? { ok: true } : next;
      });
      await context.addInitScript({ content: FNMT_SHIM_SOURCE });
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.endsWith('/fnmtcertrq.js')) {
          await route.fulfill({ contentType: 'application/javascript', body: FAKE_FNMT_SCRIPT });
        } else {
          await route.fulfill({ contentType: 'text/html', body: PAGE });
        }
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('https://apus20.sede.fnmt.gob.es/SolicitudWebCert/presolicitar.do');

      const run = (script: string) =>
        page.evaluate(
          (body) =>
            new Promise((resolve) => {
              const w = window as unknown as Record<string, unknown>;
              w.__done = resolve;
              new Function(body)();
            }),
          script,
        );

      // requestCert → ok(base64 PKCS#10), as the page's successCallback expects.
      expect(
        await run(`FnmtCertRequest.requestCert(
          function (b64) { window.__done({ ok: b64 }); },
          function (t, m) { window.__done({ ko: [t, m] }); },
          'RSA', null, null, false);`),
      ).toEqual({ ok: 'TUlJQ1BLQ1MxMA==' });
      const request = calls.find((c) => c.method === 'requestCert');
      expect(request?.args).toEqual(['RSA', null, null, false]);
      expect(request?.origin).toBe('https://apus20.sede.fnmt.gob.es');

      // A refusal reaches ko with the app's type and message, and getError* report it.
      next = { ok: false, errorType: FNMT_ERROR.cancelled, errorMessage: 'Cancelado' };
      expect(
        await run(`FnmtCertRequest.installCert(
          function () { window.__done({ ok: true }); },
          function (t, m) { window.__done({ ko: [t, m, FnmtCertRequest.getErrorType()] }); },
          'Y2VydA==');`),
      ).toEqual({ ko: [FNMT_ERROR.cancelled, 'Cancelado', FNMT_ERROR.cancelled] });
      expect(calls.find((c) => c.method === 'installCert')?.args).toEqual(['Y2VydA==']);

      // forceCard: refused in the page, never sent to the app.
      const before = calls.length;
      const card = (await run(`FnmtCertRequest.requestCert(
          function () { window.__done({ ok: true }); },
          function (t) { window.__done({ ko: t }); },
          'RSA', null, null, true);`)) as { ko: string };
      expect(card.ko).toBe(FNMT_ERROR.cardNotSupported);
      expect(calls.filter((c) => c.method !== FNMT_NOTICE).length).toBe(
        calls.slice(0, before).filter((c) => c.method !== FNMT_NOTICE).length,
      );

      const state = await page.evaluate(() => {
        const f = (window as unknown as { FnmtCertRequest: Record<string, unknown> })
          .FnmtCertRequest;
        (f.pingApp as () => void)();
        return {
          version: f.VERSION,
          b64: (f.getBase64FromText as (t: string) => string)('hola'),
          // The page's own object never launched the Configurador.
          launched: (f.launched as string[] | undefined)?.length ?? 0,
        };
      });
      expect(state).toEqual({ version: '1.6.4', b64: 'aG9sYQ==', launched: 0 });
      await expect
        .poll(() => calls.filter((c) => c.method === FNMT_NOTICE).map((c) => c.args))
        .toEqual([
          ['loaded', '1.6.4'],
          ['ignored', 'pingApp'],
        ]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('leaves pages without FNMT script alone', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addInitScript({ content: FNMT_SHIM_SOURCE });
      const page = await context.newPage();
      await page.setContent('<p>hola</p>');
      expect(
        await page.evaluate(() => [
          typeof (window as unknown as { FnmtCertRequest?: unknown }).FnmtCertRequest,
          'FnmtCertRequest' in window,
        ]),
      ).toEqual(['undefined', true]);
    } finally {
      await browser.close();
    }
  });
});
