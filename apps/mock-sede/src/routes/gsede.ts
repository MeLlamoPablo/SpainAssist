/**
 * A gsede-like certificate login ("Acceder" with AutoFirma), as some municipal sedes run it.
 *
 * It is NOT a TLS client-certificate login: the page signs a challenge through AutoFirma's
 * legacy XML batch (`AutoScript.signBatch`) driven by clientSigner.js (public/js/clientsigner.js):
 *  - GET  /gsede/acceso: sets a readable JSESSIONID cookie and a challenge ("hashToSign");
 *  - POST /gsede/clientsigner/BatchPresigner[/service/<jsessionid>]: `xml` (the `<signbatch>`),
 *    `certs` → TriphaseData XML with the CAdES signed attributes of each singlesign (PRE);
 *  - POST /gsede/clientsigner/BatchPostsigner[/service/<jsessionid>]: `xml`, `certs`, `tridata`
 *    (with PK1) → checks PK1, builds the CAdES and stores "<b64u cert>|<b64u signature>" under
 *    the singlesign Id; answers `<signs><signresult id result description/></signs>`;
 *  - GET  /gsede/clientsigner/RetrieveService?op=get&id=<Id>: the stored result, once;
 *  - POST /gsede/acceso: `clientSignerResult` = JSON [{signature, transactionId}, {certificate}]
 *    → verifies the implicit CAdES of the challenge against the mock client CA and opens a sede
 *    session ("certificado electrónico", high level).
 */
import { type createPublicKey, verify as cryptoVerify, X509Certificate } from 'node:crypto';
import type { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { GSEDE_CLIENT_SIGNER } from '../assets';
import { decodeBase64, verifyCadesSignature } from '../cades';
import { assembleCades, cadesSignedAttributes } from '../cades-build';
import {
  type AppContext,
  type AppEnv,
  type Ctx,
  field,
  renderSede,
  setSessionCookie,
} from '../context';
import { html, jsonForScript } from '../html';
import { randomCode, randomId, type SedeIdentity, type Session } from '../state';
import { alertBox, summaryList } from '../views';

const JSESSIONID = 'JSESSIONID';
const BASE = '/gsede';
const TTL_MS = 10 * 60_000;

const resultSchema = z
  .array(
    z.union([
      z.object({ signature: z.string().min(1).max(200_000), transactionId: z.string().max(200) }),
      z.object({ certificate: z.string().min(1).max(200_000) }),
    ]),
  )
  .min(2)
  .max(10);

function b64u(data: Uint8Array): string {
  return Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function tryDecode(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  try {
    return decodeBase64(value);
  } catch {
    return undefined;
  }
}

function xmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function servletParams(c: Ctx): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...c.req.query() };
  if (c.req.method === 'POST') {
    const body = await c.req.parseBody().catch(() => ({}));
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

interface BatchSign {
  id: string;
  datasource: string;
  format: string;
  suboperation: string;
}

/** The `<signbatch>` the page's clientSigner.js builds (a mock: regular expressions suffice). */
function parseSignBatch(xml: string): { algorithm: string; signs: BatchSign[] } | undefined {
  const root = /<signbatch\b([^>]*)>/.exec(xml);
  const algorithm = root ? /\balgorithm="([^"]*)"/.exec(root[1] ?? '')?.[1] : undefined;
  if (!algorithm) return undefined;
  const signs: BatchSign[] = [];
  for (const m of xml.matchAll(/<singlesign\b[^>]*\bId="([^"]+)"[^>]*>([\s\S]*?)<\/singlesign>/g)) {
    const body = m[2] ?? '';
    const text = (tag: string) =>
      new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)?.[1]?.trim() ?? '';
    signs.push({
      id: m[1]!,
      datasource: text('datasource'),
      format: text('format'),
      suboperation: text('suboperation'),
    });
  }
  return signs.length ? { algorithm, signs } : undefined;
}

/** `<firma Id=".."><param n="PK1">..</param>…` of the TriphaseData the client sends back. */
function parseTridata(xml: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const m of xml.matchAll(/<firma\b[^>]*\bId="([^"]+)"[^>]*>([\s\S]*?)<\/firma>/g)) {
    const params = new Map<string, string>();
    for (const p of (m[2] ?? '').matchAll(/<param n="([^"]+)">([\s\S]*?)<\/param>/g)) {
      params.set(p[1]!, p[2]!.trim());
    }
    out.set(m[1]!, params);
  }
  return out;
}

function splitSurnames(surname: string | undefined): [string, string] {
  const words = (surname ?? '').split(/\s+/).filter(Boolean);
  return words.length === 2 ? [words[0]!, words[1]!] : [words.join(' '), ''];
}

export function registerGsedeRoutes(app: Hono<AppEnv>, ctx: AppContext): void {
  const { state } = ctx;
  const crumbs = [{ label: 'Acceder (gsede)' }];

  const loginError = (c: Ctx, message: string) =>
    renderSede(
      c,
      ctx,
      {
        title: 'Error de acceso',
        breadcrumbs: crumbs,
        body: html`<h1>No se ha podido acceder con tu certificado</h1>
          ${alertBox('error', message)}
          <p><a class="boton" href="${BASE}/acceso">Volver a intentarlo</a></p>`,
      },
      403,
    );

  app.get(`${BASE}/acceso`, (c) => {
    let sessionId = getCookie(c, JSESSIONID);
    if (!sessionId || !/^[A-F0-9]{32}$/.test(sessionId)) {
      sessionId = randomCode(32, '0123456789ABCDEF');
      // Readable by the page: clientSigner.js puts it in the batch servlet URLs (multinode).
      setCookie(c, JSESSIONID, sessionId, { path: BASE, secure: true, sameSite: 'Lax' });
    }
    const challenge = {
      hashToSign: Buffer.from(randomCode(32, '0123456789ABCDEF'), 'ascii').toString('base64'),
      transactionId: String(Date.now()) + randomCode(4, '0123456789'),
      createdAt: state.now(),
    };
    state.gsedeChallenges.set(sessionId, challenge);
    const signConfig = [
      {
        mode: 'implicit',
        signData: 'signature',
        useManifest: 'false',
        certificateData: 'certificate',
        format: 'CAdES',
        hashToSign: challenge.hashToSign,
        applicationId: 'sede',
        transactionId: challenge.transactionId,
        algorithm: 'SHA256withRSA',
        policy: 'false',
      },
    ];
    return renderSede(c, ctx, {
      title: 'Acceder',
      breadcrumbs: crumbs,
      scripts: [GSEDE_CLIENT_SIGNER],
      body: html`<h1>Acceder</h1>
        <script>
          var signerClientBase = '${BASE}';
          var signerClientLocale = 'es_ES';
          var signerClientForceWSMode = true;
          var forceAutofirma = true;
          var signerClientForceAutofirma = true;
          var signerClientMultiNode = true;
        </script>
        <form action="${BASE}/acceso" id="formCert" name="formCert" method="post">
          <input type="hidden" id="clientSignerResult" name="clientSignerResult">
          <input type="hidden" id="actionLogin" name="action">
        </form>
        <h2>Acceso mediante certificado digital</h2>
        <p>Pulsa el botón para acceder a la aplicación con tu certificado digital. AutoFirma te pedirá que elijas el certificado.</p>
        <button id="autButton" class="boton" onclick="waiting(); chargeClient();" type="button">Acceder</button>
        <div id="espera" class="estado-firma" role="status" hidden>Por favor, espere...</div>
        <script>
          function waiting() {
            document.getElementById('espera').hidden = false;
          }
          function chargeClient() {
            authenticate(${jsonForScript(signConfig)}, 'loginCert');
          }
          function loginCert(certificate) {
            var form = document.getElementById('formCert');
            form.clientSignerResult.value = certificate;
            form.actionLogin.value = 'authenticateCert';
            form.submit();
          }
        </script>`,
    });
  });

  app.post(`${BASE}/acceso`, async (c) => {
    const body = await c.req.parseBody();
    const sessionId = getCookie(c, JSESSIONID);
    const challenge = sessionId ? state.gsedeChallenges.get(sessionId) : undefined;
    if (!sessionId || !challenge || state.now() - challenge.createdAt > TTL_MS) {
      return loginError(c, 'La sesión de acceso ha caducado. Vuelve a pulsar «Acceder».');
    }
    if (field(body, 'action') !== 'authenticateCert') {
      return loginError(c, 'Petición de acceso no válida.');
    }
    let entries: z.infer<typeof resultSchema>;
    try {
      entries = resultSchema.parse(JSON.parse(field(body, 'clientSignerResult')));
    } catch {
      return loginError(c, 'No se ha recibido la firma de acceso.');
    }
    const signed = entries.find(
      (e): e is { signature: string; transactionId: string } =>
        'signature' in e && e.transactionId === challenge.transactionId,
    );
    const certificate = entries.find((e): e is { certificate: string } => 'certificate' in e);
    if (!signed || !certificate) return loginError(c, 'No se ha recibido la firma de acceso.');
    const result = verifyCadesSignature({
      signature: signed.signature,
      expectedContent: decodeBase64(challenge.hashToSign),
      certificateArgument: certificate.certificate,
      now: new Date(state.now()),
    });
    if (!result.valid || !result.signer) {
      ctx.log(`[gsede] Firma de acceso rechazada: ${result.error ?? 'sin firmante'}`);
      return loginError(c, result.error ?? 'La firma de acceso no es válida.');
    }
    const holder = result.signer;
    if (!holder.dni) return loginError(c, 'El certificado no contiene un DNI o NIE.');
    state.gsedeChallenges.delete(sessionId);

    const [surname1, surname2] = splitSurnames(holder.surname);
    const known = state.users.get(holder.dni);
    const identity: SedeIdentity = {
      dni: holder.dni,
      givenName: holder.givenName ?? known?.givenName ?? '',
      surname1: known?.surname1 ?? surname1,
      surname2: known?.surname2 ?? surname2,
      fullName: [holder.givenName, holder.surname].filter(Boolean).join(' '),
      method: 'certificado',
      loa: 'high',
      email: known?.email,
      phone: known?.phone,
      certificateSha256: holder.sha256,
    };
    const previous = c.get('session');
    if (previous) state.sessions.delete(previous.id);
    const now = state.now();
    const session: Session = {
      id: randomId(18),
      identity,
      createdAt: now,
      lastSeen: now,
      residencia: {},
      cita: {},
      captchaPassed: false,
    };
    state.sessions.set(session.id, session);
    setSessionCookie(c, session.id);
    ctx.log(`[gsede] Acceso con certificado (AutoFirma): ${identity.fullName} (${identity.dni})`);
    return c.redirect(`${BASE}/carpeta`, 303);
  });

  app.get(`${BASE}/carpeta`, (c) => {
    const session = c.get('session');
    if (!session) return c.redirect(`${BASE}/acceso`, 303);
    return renderSede(c, ctx, {
      title: 'Mi carpeta',
      breadcrumbs: [{ label: 'Mi carpeta' }],
      body: html`<h1>Mi carpeta</h1>
        ${alertBox('exito', `Has accedido con tu certificado electrónico, ${session.identity.fullName}.`)}
        ${summaryList([
          ['Nombre', session.identity.fullName],
          ['DNI o NIE', session.identity.dni],
        ])}`,
    });
  });

  // --- AutoFirma batch servers ------------------------------------------------------------------

  const presigner = async (c: Ctx) => {
    const p = await servletParams(c);
    const xml = tryDecode(p.xml)?.toString('utf8');
    const certs = (p.certs ?? '').split(';').map(tryDecode);
    const certDer = certs[0];
    if (!xml || !certDer) return c.text('ERR-01: Parametros no validos');
    const batch = parseSignBatch(xml);
    if (!batch) return c.text('ERR-02: Lote no valido');
    if (batch.algorithm !== 'SHA256withRSA') return c.text('ERR-03: Algoritmo no soportado');
    let firmas = '';
    for (const s of batch.signs) {
      const data = tryDecode(s.datasource);
      if (!data || s.format !== 'CAdES' || s.suboperation !== 'sign') {
        return c.text(`ERR-04: Firma no soportada (${s.id})`);
      }
      const signingTime = new Date(state.now());
      const { toBeSigned } = cadesSignedAttributes({ data, certDer, signingTime });
      state.gsedePresigns.set(s.id, {
        data,
        certDer,
        chainDer: certs.slice(1).filter((d): d is Buffer => !!d),
        toBeSigned,
        signingTime,
        createdAt: state.now(),
      });
      firmas += `<firma Id="${xmlAttr(s.id)}"><param n="PRE">${toBeSigned.toString('base64')}</param><param n="NEED_PRE">true</param></firma>`;
    }
    return c.body(`<xml><firmas format="CAdES">${firmas}</firmas></xml>`, 200, {
      'content-type': 'text/xml; charset=utf-8',
    });
  };

  const postsigner = async (c: Ctx) => {
    const p = await servletParams(c);
    const xml = tryDecode(p.xml)?.toString('utf8');
    const tridata = tryDecode(p.tridata)?.toString('utf8');
    const certDer = tryDecode((p.certs ?? '').split(';')[0]);
    const batch = xml ? parseSignBatch(xml) : undefined;
    if (!batch || !tridata || !certDer) return c.text('ERR-01: Parametros no validos');
    const pk1s = parseTridata(tridata);
    let publicKey: ReturnType<typeof createPublicKey>;
    try {
      publicKey = new X509Certificate(certDer).publicKey;
    } catch {
      return c.text('ERR-05: Certificado no valido');
    }
    let results = '';
    for (const s of batch.signs) {
      const presign = state.gsedePresigns.get(s.id);
      const pk1 = tryDecode(pk1s.get(s.id)?.get('PK1'));
      let outcome = 'DONE_AND_SAVED';
      let description = '';
      if (
        !presign ||
        state.now() - presign.createdAt > TTL_MS ||
        !presign.certDer.equals(certDer)
      ) {
        outcome = 'ERROR_POST';
        description = 'No hay prefirma para esta firma';
      } else if (!pk1 || !cryptoVerify('sha256', presign.toBeSigned, publicKey, pk1)) {
        outcome = 'ERROR_POST';
        description = 'La firma PKCS#1 no es valida';
      } else {
        const { attributes } = cadesSignedAttributes({
          data: presign.data,
          certDer: presign.certDer,
          signingTime: presign.signingTime,
        });
        const cms = assembleCades({
          data: presign.data,
          certDer: presign.certDer,
          chainDer: presign.chainDer,
          attributes,
          signature: pk1,
        });
        state.afirmaStorage.set(s.id, `${b64u(presign.certDer)}|${b64u(cms)}`);
      }
      state.gsedePresigns.delete(s.id);
      results += `<signresult id="${xmlAttr(s.id)}" result="${outcome}" description="${xmlAttr(description)}"/>`;
    }
    return c.body(`<signs>${results}</signs>`, 200, { 'content-type': 'text/xml; charset=utf-8' });
  };

  const retriever = async (c: Ctx) => {
    const p = await servletParams(c);
    if (p.op === 'check') return c.text('OK');
    if (p.op === 'get' && p.id) {
      const data = state.afirmaStorage.get(p.id);
      if (data !== undefined) {
        state.afirmaStorage.delete(p.id);
        return c.text(data);
      }
      return c.text('err-06:= El fichero no existe o ha caducado');
    }
    return c.text('err-00:= Operacion no soportada');
  };

  const storage = async (c: Ctx) => {
    const p = await servletParams(c);
    if (p.op === 'check') return c.text('OK');
    if (p.op === 'put' && p.id && p.dat) {
      state.afirmaStorage.set(p.id, p.dat);
      return c.text('OK');
    }
    return c.text('err-00:= Operacion no soportada');
  };

  for (const suffix of ['', '/service/:sid']) {
    app.post(`${BASE}/clientsigner/BatchPresigner${suffix}`, presigner);
    app.post(`${BASE}/clientsigner/BatchPostsigner${suffix}`, postsigner);
    app.all(`${BASE}/clientsigner/RetrieveService${suffix}`, retriever);
    app.all(`${BASE}/clientsigner/StorageService${suffix}`, storage);
  }
}
