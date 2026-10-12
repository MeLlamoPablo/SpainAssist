import type { AfirmaCall, AfirmaHandler, SigningKey } from '@sa/shared';
import { AFIRMA_BINDING, AFIRMA_NOTICE } from '@sa/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestService, page, refOf, startServer, type TestServer } from './helpers';

/**
 * Minimal stand-in for the real AutoScript shim (@sa/signer): it replaces the site's AutoScript
 * with an object that forwards calls to the binding. It deliberately sends a fake origin/url:
 * the browser must ignore them and use the calling frame's.
 */
const FAKE_SHIM = `(() => {
  const forward = (method, args, ok, ko) =>
    window.${AFIRMA_BINDING}({ method, args, origin: 'https://evil.example', url: 'https://evil.example/x' })
      .then((r) => (r.ok ? ok && ok(...r.callbackArgs) : ko && ko(r.errorType, r.errorMessage)));
  const AutoScript = {
    cargarAppAfirma() {},
    sign(data, algorithm, format, params, ok, ko) { forward('sign', [data, algorithm, format, params], ok, ko); },
  };
  Object.defineProperty(window, 'AutoScript', { get: () => AutoScript, set: () => {}, configurable: false });
})();`;

const SIGN_BUTTON = (label: string, data: string, format: string) =>
  `<button onclick="AutoScript.sign('${data}', 'SHA256withRSA', '${format}', null,
     (sig, cert) => { document.getElementById('out').textContent = 'Firmado: ' + sig + ' ' + cert; },
     (type, msg) => { document.getElementById('out').textContent = 'Error: ' + type; })">${label}</button>
   <p id=out></p>`;

let a: TestServer;
let b: TestServer;
let t: ReturnType<typeof createTestService>;
const calls: { call: AfirmaCall; procedureId: string }[] = [];
let approve: () => Promise<SigningKey | null>;
let failHandler = false;
const logs: { level: string; msg: string; data?: unknown }[] = [];
const logger = {
  debug: () => {},
  info: (msg: string, data?: unknown) => logs.push({ level: 'info', msg, data }),
  warn: (msg: string, data?: unknown) => logs.push({ level: 'warn', msg, data }),
  error: (msg: string, data?: unknown) => logs.push({ level: 'error', msg, data }),
};

const handler: AfirmaHandler = async (call, ctx) => {
  calls.push({ call, procedureId: ctx.procedureId });
  if (failHandler) throw new Error('boom: secret details');
  if (call.method === 'saveDataToFile') {
    return {
      ok: false,
      errorType: 'java.lang.UnsupportedOperationException',
      errorMessage: 'El guardado de ficheros no está disponible',
    };
  }
  const format = String(call.args[2]);
  const cert = await ctx.approveSignature({
    method: call.method,
    format,
    algorithm: String(call.args[1]),
    origin: call.origin,
    description: 'prueba',
    documents: [],
    verifiable: false,
  });
  if (!cert) {
    ctx.report({ status: 'rejected', format, origin: call.origin });
    return {
      ok: false,
      errorType: 'es.gob.afirma.core.AOCancelledOperationException',
      errorMessage: 'Cancelado',
    };
  }
  ctx.report({ status: 'signed', format, origin: call.origin });
  return { ok: true, callbackArgs: ['U0lHTkFUVVJF', 'Q0VSVA=='] };
};

const CERT: SigningKey = { kind: 'p12', credentialId: 'c1', p12: new Uint8Array(), passphrase: '' };

beforeAll(async () => {
  b = await startServer(
    { '/firma-frame': page(SIGN_BUTTON('Firmar en iframe', 'ZnJhbWU=', 'XAdES'), 'Marco') },
    { host: '127.0.0.1' },
  );
  a = await startServer({
    '/firma': page(
      `<script>var AutoScript = { sign: function () { document.title = 'ORIGINAL AUTOSCRIPT'; } };</script>
       ${SIGN_BUTTON('Firmar', 'SGVsbG8=', 'CAdES')}
       <button onclick="window.${AFIRMA_BINDING}('basura').then((r) => { document.getElementById('raw').textContent = 'Respuesta: ' + r.errorType; })">Llamada rara</button>
       <p id=raw></p>
       <a href="/firma" target="_blank">Abrir en ventana nueva</a>
       <iframe title="Marco de firma" src="${b.origin}/firma-frame" width=400 height=120></iframe>`,
      'Firma',
    ),
    '/errores': page(
      `<button onclick="setTimeout(() => { AutoScript.setWaitCertMaxLoops(15); }, 0)">Fallo de script</button>
       <button onclick="Promise.reject(new Error('Sin respuesta del servidor'))">Promesa rechazada</button>
       <button onclick="window.${AFIRMA_BINDING}({ method: '${AFIRMA_NOTICE}', args: ['loaded', '1.8.0'] }); window.${AFIRMA_BINDING}({ method: '${AFIRMA_NOTICE}', args: ['ignored', 'setSiteOption'] })">Avisos</button>
       <button onclick="window.${AFIRMA_BINDING}({ method: 'saveDataToFile', args: [] }).then((r) => { document.getElementById('out').textContent = 'Guardado: ' + r.ok; })">Guardar</button>
       <p id=out></p>`,
      'Errores',
    ),
  });
  t = createTestService({
    afirma: {
      shimSource: FAKE_SHIM,
      handler,
      context: () => ({ approveSignature: () => approve() }),
    },
    logger,
  });
});

beforeEach(() => {
  calls.length = 0;
  logs.length = 0;
  failHandler = false;
  approve = async () => CERT;
});

afterAll(async () => {
  await t?.cleanup();
  await a?.close();
  await b?.close();
});

describe('AutoFirma replacement plumbing', () => {
  it('injects the shim before page scripts and fills origin/url from the calling frame', async () => {
    let obs = await t.service.open('af', `${a.origin}/firma`);
    obs = await t.service.click('af', refOf(obs.snapshot, 'button "Firmar"'));
    expect(obs.snapshot).toContain('Firmado: U0lHTkFUVVJF Q0VSVA==');
    expect(obs.title).toBe('Firma'); // the site's own AutoScript never ran
    expect(obs.signatures).toEqual([{ status: 'signed', format: 'CAdES', origin: a.origin }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      procedureId: 'af',
      call: {
        method: 'sign',
        args: ['SGVsbG8=', 'SHA256withRSA', 'CAdES', null],
        origin: a.origin,
        url: `${a.origin}/firma`,
      },
    });
  });

  it('works inside cross-site iframes (origin of the iframe)', async () => {
    let obs = await t.service.open('af-frame', `${a.origin}/firma`);
    obs = await t.service.click('af-frame', refOf(obs.snapshot, 'button "Firmar en iframe"'));
    expect(obs.snapshot).toContain('Firmado: U0lHTkFUVVJF');
    expect(calls[0]?.call).toMatchObject({ origin: b.origin, url: `${b.origin}/firma-frame` });
    expect(obs.signatures).toEqual([{ status: 'signed', format: 'XAdES', origin: b.origin }]);
  });

  it('waits for a slow approval and reports rejections', async () => {
    approve = () => new Promise((resolve) => setTimeout(() => resolve(CERT), 1_500));
    let obs = await t.service.open('af-slow', `${a.origin}/firma`);
    obs = await t.service.click('af-slow', refOf(obs.snapshot, 'button "Firmar"'));
    expect(obs.snapshot).toContain('Firmado: U0lHTkFUVVJF');
    expect(obs.signatures).toHaveLength(1);

    approve = async () => null;
    obs = await t.service.click('af-slow', refOf(obs.snapshot, 'button "Firmar"'));
    expect(obs.snapshot).toContain('Error: es.gob.afirma.core.AOCancelledOperationException');
    expect(obs.signatures).toEqual([{ status: 'rejected', format: 'CAdES', origin: a.origin }]);
  });

  it('turns handler crashes and malformed calls into AutoFirma-style errors', async () => {
    failHandler = true;
    let obs = await t.service.open('af-err', `${a.origin}/firma`);
    obs = await t.service.click('af-err', refOf(obs.snapshot, 'button "Firmar"'));
    expect(obs.snapshot).toContain('Error: java.lang.Exception');
    expect(obs.signatures).toEqual([
      { status: 'failed', format: '', origin: a.origin, message: 'Internal error while signing' },
    ]);
    expect(JSON.stringify(obs)).not.toContain('secret details');

    obs = await t.service.click('af-err', refOf(obs.snapshot, 'button "Llamada rara"'));
    expect(obs.snapshot).toContain('Respuesta: java.lang.IllegalArgumentException');
  });

  it('injects the shim into popups too', async () => {
    let obs = await t.service.open('af-pop', `${a.origin}/firma`);
    obs = await t.service.click('af-pop', refOf(obs.snapshot, 'link "Abrir en ventana nueva"'));
    expect(obs.tabs.map((x) => x.active)).toEqual([false, true]);
    obs = await t.service.click('af-pop', refOf(obs.snapshot, 'button "Firmar"'));
    expect(obs.snapshot).toContain('Firmado: U0lHTkFUVVJF');
    expect(calls.at(-1)?.call.origin).toBe(a.origin);
  });

  it('passes page script errors and unhandled rejections to the agent and the log', async () => {
    let obs = await t.service.open('af-js', `${a.origin}/errores`);
    obs = await t.service.click('af-js', refOf(obs.snapshot, 'button "Fallo de script"'));
    expect(obs.pageErrors).toEqual([
      expect.stringMatching(
        /^TypeError: .*setWaitCertMaxLoops is not a function \(\/errores:\d+\)$/,
      ),
    ]);
    obs = await t.service.click('af-js', refOf(obs.snapshot, 'button "Promesa rechazada"'));
    expect(obs.pageErrors).toEqual([expect.stringContaining('Sin respuesta del servidor')]);
    // Reported once per observation.
    obs = await t.service.snapshot('af-js');
    expect(obs.pageErrors).toEqual([]);
    expect(logs.filter((l) => l.msg === 'page script error')).toEqual([
      {
        level: 'warn',
        msg: 'page script error',
        data: {
          procedureId: 'af-js',
          host: new URL(a.origin).host,
          error: expect.stringContaining('TypeError'),
        },
      },
      {
        level: 'warn',
        msg: 'page script error',
        data: expect.objectContaining({ error: expect.stringContaining('Sin respuesta') }),
      },
    ]);
  });

  it('turns shim notices and failed AutoFirma calls into notes, without the handler', async () => {
    let obs = await t.service.open('af-notice', `${a.origin}/errores`);
    obs = await t.service.click('af-notice', refOf(obs.snapshot, 'button "Avisos"'));
    expect(calls).toEqual([]);
    expect(obs.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${new URL(a.origin).host} uses AutoFirma. The app replaces it`),
        expect.stringContaining('AutoScript.setSiteOption, which the app'),
      ]),
    );
    // The AutoFirma note comes once per origin.
    obs = await t.service.click('af-notice', refOf(obs.snapshot, 'button "Avisos"'));
    expect(obs.notes.filter((n) => n.includes('uses AutoFirma'))).toEqual([]);

    obs = await t.service.click('af-notice', refOf(obs.snapshot, 'button "Guardar"'));
    expect(obs.snapshot).toContain('Guardado: false');
    expect(obs.notes).toContain(
      "The page's AutoFirma call saveDataToFile failed: El guardado de ficheros no está disponible.",
    );
    expect(logs).toContainEqual({
      level: 'info',
      msg: 'AutoFirma call failed',
      data: expect.objectContaining({
        method: 'saveDataToFile',
        host: new URL(a.origin).host,
        errorType: 'java.lang.UnsupportedOperationException',
      }),
    });
  });
});
