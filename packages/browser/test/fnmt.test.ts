import { FNMT_BINDING, FNMT_ERROR, type FnmtCall, type FnmtReply } from '@sa/shared';
import { FNMT_SHIM_SOURCE } from '@sa/signer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestService, page, refOf, startServer, type TestServer } from './helpers';

/** Stand-in for FNMT's fnmtcertrq.js: same global, same public members (no FNMT code). */
const FAKE_FNMT_SCRIPT = `<script>
var FnmtCertRequest = (function (win) {
  return {
    VERSION: '1.6.4',
    setServlets: function () {},
    requestCert: function () { document.title = 'CONFIGURADOR LANZADO'; },
    installCert: function () { document.title = 'CONFIGURADOR LANZADO'; },
    getErrorMessage: function () { return ''; },
    getErrorType: function () { return ''; }
  };
})(window);
function out(text) { document.getElementById('out').textContent = text; }
</script>`;

let server: TestServer;
let t: ReturnType<typeof createTestService>;
const calls: { call: FnmtCall; procedureId: string }[] = [];
let reply: () => Promise<FnmtReply>;

beforeAll(async () => {
  server = await startServer({
    '/solicitud': page(
      `${FAKE_FNMT_SCRIPT}
       <form><input type="hidden" name="PKCS10"></form>
       <button onclick="FnmtCertRequest.setServlets('a', 'b'); FnmtCertRequest.requestCert(
         function (b64) { out('PKCS10: ' + b64); },
         function (t, m) { out('Error: ' + t + ' ' + m); }, 'RSA', null, null, false)">Enviar petición</button>
       <button onclick="FnmtCertRequest.installCert(
         function () { out('Instalado'); },
         function (t, m) { out('Error: ' + t + ' ' + m); }, 'Q0VSVA==')">Descargar certificado</button>
       <button onclick="window.${FNMT_BINDING}({ method: 'borrarTodo', args: [] }).then(function (r) { out('Respuesta: ' + r.errorType); })">Llamada rara</button>
       <p id=out></p>`,
      'Solicitud',
    ),
  });
  t = createTestService({
    fnmt: {
      shimSource: FNMT_SHIM_SOURCE,
      handler: async (call, procedureId) => {
        calls.push({ call, procedureId });
        return reply();
      },
    },
  });
});

beforeEach(() => {
  calls.length = 0;
  reply = async () => ({ ok: true, result: 'UEtDUzEw' });
});

afterAll(async () => {
  await t?.cleanup();
  await server?.close();
});

describe('FNMT Configurador replacement plumbing', () => {
  it('answers requestCert through the app, with the calling frame origin, and tells the agent', async () => {
    let obs = await t.service.open('fnmt', `${server.origin}/solicitud`);
    expect(obs.notes).toEqual([expect.stringContaining("replaces FNMT's Configurador")]);
    obs = await t.service.click('fnmt', refOf(obs.snapshot, 'button "Enviar petición"'));
    expect(obs.snapshot).toContain('PKCS10: UEtDUzEw');
    expect(obs.title).toBe('Solicitud'); // the page's own object never ran
    expect(calls).toEqual([
      {
        procedureId: 'fnmt',
        call: {
          method: 'requestCert',
          args: ['RSA', null, null, false],
          origin: server.origin,
          url: `${server.origin}/solicitud`,
        },
      },
    ]);
    expect(obs.notes).toEqual([expect.stringContaining('generated the certificate request')]);
  });

  it('waits for a slow approval and reports refusals', async () => {
    reply = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 1_500));
    let obs = await t.service.open('fnmt-slow', `${server.origin}/solicitud`);
    obs = await t.service.click('fnmt-slow', refOf(obs.snapshot, 'button "Descargar certificado"'));
    expect(obs.snapshot).toContain('Instalado');
    expect(obs.notes).toEqual([expect.stringContaining("is now in the user's vault")]);

    reply = async () => ({ ok: false, errorType: FNMT_ERROR.cancelled, errorMessage: 'No' });
    obs = await t.service.click('fnmt-slow', refOf(obs.snapshot, 'button "Enviar petición"'));
    expect(obs.snapshot).toContain(`Error: ${FNMT_ERROR.cancelled} No`);
    expect(obs.notes).toEqual([expect.stringContaining('did not approve the certificate request')]);
  });

  it('turns handler crashes and unknown methods into errors', async () => {
    reply = async () => {
      throw new Error('boom: private key details');
    };
    let obs = await t.service.open('fnmt-err', `${server.origin}/solicitud`);
    obs = await t.service.click('fnmt-err', refOf(obs.snapshot, 'button "Enviar petición"'));
    expect(obs.snapshot).toContain(`Error: ${FNMT_ERROR.generic} Error interno`);
    expect(JSON.stringify(obs)).not.toContain('private key details');

    obs = await t.service.click('fnmt-err', refOf(obs.snapshot, 'button "Llamada rara"'));
    expect(obs.snapshot).toContain('Respuesta: java.lang.IllegalArgumentException');
    expect(calls).toHaveLength(1);
  });
});
