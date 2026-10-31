/**
 * An FNMT-like software certificate ("Certificado de persona física", prueba), with the same
 * hand-off as FNMT's sede (docs/research/fnmt.md §1–2):
 *  - GET  /fnmt/solicitud: NIF_SG, APELLIDO1_SG, EMAIL_XX (twice) and the terms; "Enviar
 *    petición" runs /js/fnmt-solicitud.js, which calls FnmtCertRequest.requestCert (the
 *    imitation /js/fnmtcertrq.js, which can't reach a Configurador; the app's shim answers
 *    instead) and posts the PKCS#10 it gets in the PKCS10 field;
 *  - POST /fnmt/solicitud: checks the PKCS#10's signature and registers the request under a
 *    9-digit code, which FNMT would email (the page shows it too);
 *  - the identity check happens offline: the test API (`accreditFnmt`, POST
 *    /__test/fnmt/accredit) marks a request as accredited;
 *  - GET/POST /fnmt/descarga: NIF_SG, APELLIDO1_SG and COD_SOLICITUD; an accredited request gets
 *    its certificate, issued by the mock client CA for the request's key, and the page calls
 *    FnmtCertRequest.installCert with it (/js/fnmt-descarga.js).
 */
import type { Hono } from 'hono';
import { type AppContext, type AppEnv, type Ctx, field, renderSede } from '../context';
import { checkCertificateRequest, installCertData, issueFromRequest } from '../fnmt-issuer';
import { html, jsonForScript } from '../html';
import type { FnmtRequestRecord } from '../state';
import { normalizeDocumentId, validateDocumentId } from '../validation';
import { alertBox, checkboxField, errorSummary, summaryList, textField } from '../views';

const BASE = '/fnmt';
const NAME = 'Certificado de persona física (prueba)';
const CRUMBS = [{ label: NAME, href: BASE }];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requestCode(ctx: AppContext): string {
  for (;;) {
    const code = String(100_000_000 + Math.floor(Math.random() * 900_000_000));
    if (!ctx.state.fnmtRequests.has(code)) return code;
  }
}

const sameSurname = (a: string, b: string) =>
  a.trim().localeCompare(b.trim(), 'es', { sensitivity: 'base' }) === 0;

function requestForm(
  c: Ctx,
  ctx: AppContext,
  values: Record<string, string> = {},
  errors: Record<string, string> = {},
): Response {
  return renderSede(
    c,
    ctx,
    {
      title: 'Solicitar certificado',
      breadcrumbs: [...CRUMBS, { label: 'Solicitar' }],
      scripts: ['/js/fnmtcertrq.js', '/js/fnmt-solicitud.js'],
      body: html`<h1>Solicitar certificado de persona física</h1>
        <p>Rellena tus datos. Al enviar la petición se generarán las claves de tu certificado en
        este equipo: después tendrás que acreditar tu identidad y descargarlo <strong>en el mismo
        equipo</strong>.</p>
        ${errorSummary(errors)}
        <div id="error-solicitud" hidden></div>
        <form name="formDatosUid" method="post" action="${BASE}/solicitud" novalidate>
          ${textField({ name: 'NIF_SG', label: 'Nº del documento de identificación', required: true, value: values.NIF_SG, error: errors.NIF_SG, maxlength: 9 })}
          ${textField({ name: 'APELLIDO1_SG', label: 'Primer apellido (tal y como aparece en tu documento de identificación)', required: true, value: values.APELLIDO1_SG, error: errors.APELLIDO1_SG })}
          ${textField({ name: 'EMAIL_XX', label: 'Correo electrónico', type: 'email', required: true, value: values.EMAIL_XX, error: errors.EMAIL_XX })}
          ${textField({ name: 'EMAIL_OBLIG_VERIFICADO_XX', label: 'Confirma tu correo electrónico', type: 'email', required: true, value: values.EMAIL_OBLIG_VERIFICADO_XX, error: errors.EMAIL_OBLIG_VERIFICADO_XX })}
          <input name="preP10" type="hidden">
          ${checkboxField({ name: 'aceptarCondiciones', label: 'He leído y acepto las condiciones de expedición del certificado', required: true, error: errors.aceptarCondiciones })}
          <p id="estado-solicitud" role="status"></p>
          <button id="botonEnviarFormulario" type="button" class="boton" onclick="enviarFormulario()">Enviar petición</button>
        </form>`,
    },
    Object.keys(errors).length ? 422 : 200,
  );
}

function downloadForm(
  c: Ctx,
  ctx: AppContext,
  values: Record<string, string> = {},
  errors: Record<string, string> = {},
  problem?: string,
): Response {
  return renderSede(
    c,
    ctx,
    {
      title: 'Descargar certificado',
      breadcrumbs: [...CRUMBS, { label: 'Descargar' }],
      body: html`<h1>Descargar certificado de persona física</h1>
        <p>Descarga tu certificado en el mismo equipo desde el que lo solicitaste, una vez
        acreditada tu identidad.</p>
        ${problem ? alertBox('error', problem) : ''}
        ${errorSummary(errors)}
        <form method="post" action="${BASE}/descarga" novalidate>
          ${textField({ name: 'NIF_SG', label: 'Nº del documento de identificación', required: true, value: values.NIF_SG, error: errors.NIF_SG, maxlength: 9 })}
          ${textField({ name: 'APELLIDO1_SG', label: 'Primer apellido', required: true, value: values.APELLIDO1_SG, error: errors.APELLIDO1_SG })}
          ${textField({ name: 'COD_SOLICITUD', label: 'Código de solicitud', required: true, value: values.COD_SOLICITUD, error: errors.COD_SOLICITUD, inputmode: 'numeric', maxlength: 9 })}
          ${checkboxField({ name: 'aceptarCondiciones', label: 'He leído y acepto los términos y condiciones de uso del certificado', required: true, error: errors.aceptarCondiciones })}
          <button type="submit" class="boton">Descargar certificado</button>
        </form>`,
    },
    problem || Object.keys(errors).length ? 422 : 200,
  );
}

function identityErrors(values: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  const problem = validateDocumentId(values.NIF_SG ?? '');
  if (!values.NIF_SG) errors.NIF_SG = 'Escribe el número de tu documento de identificación.';
  else if (problem) errors.NIF_SG = problem;
  if (!values.APELLIDO1_SG) errors.APELLIDO1_SG = 'Escribe tu primer apellido.';
  return errors;
}

export function registerFnmtRoutes(app: Hono<AppEnv>, ctx: AppContext): void {
  app.get(BASE, (c) =>
    renderSede(c, ctx, {
      title: NAME,
      breadcrumbs: [{ label: NAME }],
      body: html`<h1>${NAME}</h1>
        <p>El certificado de persona física te identifica en internet y te permite firmar.
        Se obtiene en tres pasos:</p>
        <ol>
          <li><a href="${BASE}/solicitud">Solicitar el certificado</a>. Recibirás un código de
          solicitud en tu correo.</li>
          <li>Acreditar tu identidad en una oficina de registro, con el código de solicitud.</li>
          <li><a href="${BASE}/descarga">Descargar el certificado</a>, en el mismo equipo.</li>
        </ol>`,
    }),
  );

  app.get(`${BASE}/solicitud`, (c) => requestForm(c, ctx));

  app.post(`${BASE}/solicitud`, async (c) => {
    const body = await c.req.parseBody();
    const values = {
      NIF_SG: normalizeDocumentId(field(body, 'NIF_SG')),
      APELLIDO1_SG: field(body, 'APELLIDO1_SG'),
      EMAIL_XX: field(body, 'EMAIL_XX'),
      EMAIL_OBLIG_VERIFICADO_XX: field(body, 'EMAIL_OBLIG_VERIFICADO_XX'),
    };
    const errors = identityErrors(values);
    if (!EMAIL.test(values.EMAIL_XX)) errors.EMAIL_XX = 'Escribe un correo electrónico válido.';
    else if (values.EMAIL_XX.toLowerCase() !== values.EMAIL_OBLIG_VERIFICADO_XX.toLowerCase()) {
      errors.EMAIL_OBLIG_VERIFICADO_XX = 'Los dos correos electrónicos no coinciden.';
    }
    if (!field(body, 'aceptarCondiciones')) {
      errors.aceptarCondiciones = 'Tienes que aceptar las condiciones de expedición.';
    }
    const pkcs10 = field(body, 'PKCS10');
    let checked: ReturnType<typeof checkCertificateRequest> | undefined;
    if (!Object.keys(errors).length) {
      if (!pkcs10) {
        errors.botonEnviarFormulario =
          'No se han generado las claves del certificado. Vuelve a enviar la petición.';
      } else {
        try {
          checked = checkCertificateRequest(pkcs10);
        } catch (e) {
          errors.botonEnviarFormulario = (e as Error).message;
        }
      }
    }
    if (!checked || Object.keys(errors).length) return requestForm(c, ctx, values, errors);
    const record: FnmtRequestRecord = {
      code: requestCode(ctx),
      dni: values.NIF_SG,
      surname1: values.APELLIDO1_SG,
      email: values.EMAIL_XX,
      spki: checked.spki,
      publicKeyHash: checked.publicKeyHash,
      createdAt: ctx.state.now(),
      accredited: false,
      downloads: 0,
    };
    ctx.state.fnmtRequests.set(record.code, record);
    ctx.log(`[FNMT] request ${record.code} for ${record.dni} (email to ${record.email})`);
    return renderSede(c, ctx, {
      title: 'Solicitud registrada',
      breadcrumbs: [...CRUMBS, { label: 'Solicitud registrada' }],
      body: html`<h1>Solicitud registrada</h1>
        ${alertBox('exito', html`Tu código de solicitud es <strong id="codigo-solicitud">${record.code}</strong>.`)}
        <p>Te lo hemos enviado también a ${record.email}. Con él tienes que acreditar tu
        identidad en una oficina de registro y, después, descargar el certificado en este mismo
        equipo.</p>
        ${summaryList([
          ['Documento de identificación', record.dni],
          ['Primer apellido', record.surname1],
          ['Código de solicitud', record.code],
        ])}
        <p><a href="${BASE}/descarga">Ir a la descarga del certificado</a></p>`,
    });
  });

  app.get(`${BASE}/descarga`, (c) => downloadForm(c, ctx));

  app.post(`${BASE}/descarga`, async (c) => {
    const body = await c.req.parseBody();
    const values = {
      NIF_SG: normalizeDocumentId(field(body, 'NIF_SG')),
      APELLIDO1_SG: field(body, 'APELLIDO1_SG'),
      COD_SOLICITUD: field(body, 'COD_SOLICITUD'),
    };
    const errors = identityErrors(values);
    if (!/^\d{9}$/.test(values.COD_SOLICITUD)) {
      errors.COD_SOLICITUD = 'El código de solicitud tiene 9 números.';
    }
    if (!field(body, 'aceptarCondiciones')) {
      errors.aceptarCondiciones = 'Tienes que aceptar los términos y condiciones de uso.';
    }
    if (Object.keys(errors).length) return downloadForm(c, ctx, values, errors);
    const record = ctx.state.fnmtRequests.get(values.COD_SOLICITUD);
    if (
      !record ||
      record.dni !== values.NIF_SG ||
      !sameSurname(record.surname1, values.APELLIDO1_SG)
    ) {
      return downloadForm(
        c,
        ctx,
        values,
        {},
        'Los datos introducidos no corresponden a ninguna solicitud. Revisa el documento, el primer apellido y el código de solicitud.',
      );
    }
    if (!record.accredited) {
      return downloadForm(
        c,
        ctx,
        values,
        {},
        'Tu solicitud todavía no está acreditada. Acredita tu identidad en una oficina de registro y vuelve a intentarlo.',
      );
    }
    const user = ctx.state.users.get(record.dni);
    record.certificate ??= issueFromRequest({
      spki: record.spki,
      dni: record.dni,
      givenName: user?.givenName ?? 'TITULAR',
      surname: user ? [user.surname1, user.surname2].filter(Boolean).join(' ') : record.surname1,
      email: record.email,
      now: new Date(ctx.state.now()),
    });
    record.downloads += 1;
    ctx.log(`[FNMT] download ${record.downloads} of request ${record.code}`);
    return renderSede(c, ctx, {
      title: 'Instalar certificado',
      breadcrumbs: [...CRUMBS, { label: 'Descargar' }],
      scripts: ['/js/fnmtcertrq.js', '/js/fnmt-descarga.js'],
      body: html`<h1>Instalación del certificado</h1>
        <p id="estado-instalacion" role="status">Instalando tu certificado…</p>
        <div id="error-instalacion" hidden></div>
        <script type="application/json" id="datos-certificado">${jsonForScript(installCertData(record.certificate))}</script>`,
    });
  });
}
