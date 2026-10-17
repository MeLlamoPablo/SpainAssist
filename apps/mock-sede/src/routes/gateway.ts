/**
 * Cl@ve-like identification gateway ("pasarela"), mirroring the real flow:
 *   sede --SAMLRequest--> /pasarela/ServiceProvider --> /pasarela (method selection)
 *   --SelectedIdP--> Cl@ve Móvil | DNIe/Certificado (client-cert port) | Cl@ve Permanente (+SMS)
 *   --assertion--> /acceso/respuesta (sede) --> session.
 */
import { randomInt } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { type AppContext, type AppEnv, type Ctx, field, PROCEDURES, safePath } from '../context';
import { html, type SafeHtml } from '../html';
import { fakeQrSvg } from '../qr';
import {
  type AuthMethod,
  type ClaveUser,
  DEMO_USER,
  fullNameOf,
  type GatewayRequest,
  type Loa,
  type MovilRequest,
  randomCode,
  randomId,
  type SedeIdentity,
  type SmsRecord,
} from '../state';
import { maskPhone, normalizeDocumentId, validateDocumentId } from '../validation';
import { alertBox, autoPostPage, errorSummary, gatewayPage, textField } from '../views';

const MAX_PASSWORD_FAILURES = 5;
const LOCKOUT_MS = 30 * 60_000;
const MAX_SMS_ATTEMPTS = 3;
const MAX_SMS_RESENDS = 3;

function identityFromUser(user: ClaveUser, method: AuthMethod, loa: Loa): SedeIdentity {
  return {
    dni: user.dni,
    givenName: user.givenName,
    surname1: user.surname1,
    surname2: user.surname2,
    fullName: fullNameOf(user),
    method,
    loa,
    email: user.email,
    phone: user.phone,
  };
}

const samlRequestSchema = z.object({
  id: z.string().min(8).max(64),
  issuer: z.string().max(100),
  procedure: z.enum(['residencia', 'cita', 'general']),
  loa: z.enum(['low', 'substantial', 'high']),
  returnTo: z.string().max(400),
  issueInstant: z.string().max(40),
});

export function registerGatewayRoutes(app: Hono<AppEnv>, ctx: AppContext): void {
  const { state, config } = ctx;

  const invalidRequest = (c: Ctx) =>
    c.html(
      gatewayPage({
        title: 'Solicitud no válida',
        body: html`<h1>No podemos continuar con la identificación</h1>
          ${alertBox('error', 'La solicitud de identificación no es válida, ya se ha usado o ha caducado. Vuelve a la sede e inicia de nuevo el acceso.')}
          <p><a class="boton" href="/">Volver a la sede</a></p>`,
      }),
      400,
    );

  const findRequest = (id: string | undefined): GatewayRequest | undefined => {
    const request = id ? state.gatewayRequests.get(id) : undefined;
    if (!request || request.consumed || request.expiresAt < state.now()) return undefined;
    return request;
  };

  /** Ends a successful identification: assertion + POST back to the sede's ACS. */
  const complete = (c: Ctx, request: GatewayRequest, identity: SedeIdentity) => {
    const assertion = {
      id: randomId(18),
      requestId: request.id,
      identity,
      createdAt: state.now(),
      used: false,
    };
    state.assertions.set(assertion.id, assertion);
    return c.html(
      autoPostPage({
        action: '/acceso/respuesta',
        fields: { SAMLResponse: assertion.id, RelayState: request.id },
        title: 'Volviendo a la sede',
      }),
    );
  };

  app.post('/pasarela/ServiceProvider', async (c) => {
    const body = await c.req.parseBody();
    let parsed: z.infer<typeof samlRequestSchema>;
    try {
      parsed = samlRequestSchema.parse(
        JSON.parse(Buffer.from(field(body, 'SAMLRequest'), 'base64').toString('utf8')),
      );
    } catch {
      return invalidRequest(c);
    }
    const now = state.now();
    const request: GatewayRequest = {
      id: randomId(),
      procedure: parsed.procedure,
      loa: parsed.loa,
      returnTo: safePath(parsed.returnTo),
      createdAt: now,
      expiresAt: now + config.gatewayRequestTtlSeconds * 1000,
      consumed: false,
    };
    state.gatewayRequests.set(request.id, request);
    return c.redirect(`/pasarela?req=${request.id}`, 303);
  });

  // ------------------------------------------------------------------------------------------
  // Method selection
  // ------------------------------------------------------------------------------------------
  const selectionPage = (c: Ctx, request: GatewayRequest, error?: string) => {
    const procedureName =
      request.procedure === 'general' ? 'la sede electrónica' : PROCEDURES[request.procedure].name;
    const high = request.loa === 'high';
    const method = (
      idp: string,
      title: string,
      buttonLabel: string,
      description: SafeHtml,
      opts: { disabled?: string; badge?: string } = {},
    ) => html`<article class="metodo${opts.disabled ? ' deshabilitado' : ''}">
      <h2>${title}</h2>
      ${opts.badge ? html`<p class="novedad">${opts.badge}</p>` : ''}
      ${description}
      ${
        opts.disabled
          ? html`<p class="no-disponible">${opts.disabled}</p>
            <button type="button" class="boton" disabled aria-label="${buttonLabel}">Acceder</button>`
          : html`<form method="post" action="/pasarela/ServiceRedirect">
            <input type="hidden" name="req" value="${request.id}">
            <input type="hidden" name="SelectedIdP" value="${idp}">
            <button type="submit" class="boton" aria-label="${buttonLabel}">Acceder</button>
          </form>`
      }
    </article>`;
    return c.html(
      gatewayPage({
        title: 'Elige cómo identificarte',
        body: html`<h1>Plataforma de identificación para las Administraciones</h1>
          <p>Vas a acceder a: <strong>${procedureName}</strong>. Elige cómo quieres identificarte.</p>
          ${error ? alertBox('error', error) : ''}
          <div class="metodos">
            ${
              high
                ? ''
                : method(
                    'IDP_MOVIL',
                    'Cl@ve Móvil',
                    'Acceso Cl@ve Móvil',
                    html`<p>Escanea un código QR y confirma el acceso en la app Cl@ve de tu móvil.</p>`,
                    { badge: 'Novedad · Incluye Cl@ve PIN' },
                  )
            }
            ${method(
              'AFIRMA',
              'DNIe / Certificado electrónico',
              'Acceso DNIe / Certificado electrónico',
              html`<p>Cualquier certificado electrónico cualificado, incluido el del DNI electrónico.</p>`,
            )}
            ${method(
              'EIDAS',
              'Ciudadanos UE',
              'Acceso Ciudadanos UE',
              html`<p>Identificación con un medio reconocido de otro país de la Unión Europea.</p>`,
              { disabled: 'No disponible temporalmente.' },
            )}
            ${
              high
                ? ''
                : method(
                    'SEGSOC',
                    'Cl@ve Permanente',
                    'Acceso Cl@ve Permanente',
                    html`<p>Usuario (DNI o NIE) y contraseña.</p>`,
                  )
            }
          </div>
          <p class="volver"><a href="/">Cancelar y volver a la sede</a></p>`,
      }),
      error ? 400 : 200,
    );
  };

  app.get('/pasarela', (c) => {
    const request = findRequest(c.req.query('req'));
    return request ? selectionPage(c, request) : invalidRequest(c);
  });

  app.post('/pasarela/ServiceRedirect', async (c) => {
    const body = await c.req.parseBody();
    const request = findRequest(field(body, 'req'));
    if (!request) return invalidRequest(c);
    const idp = field(body, 'SelectedIdP');
    const high = request.loa === 'high';
    if (idp === 'IDP_MOVIL' && !high) return c.redirect(`/pasarela/movil?req=${request.id}`, 303);
    if (idp === 'SEGSOC' && !high) return c.redirect(`/pasarela/permanente?req=${request.id}`, 303);
    if (idp === 'AFIRMA') {
      return c.html(
        autoPostPage({
          action: `${ctx.urls.cert}/IdP/AuthenticateCitizen`,
          fields: { req: request.id },
          title: 'Identificación con certificado',
        }),
      );
    }
    return selectionPage(c, request, 'Ese método de identificación no está disponible.');
  });

  // Return hop from the certificate identity provider (other origin).
  app.post('/pasarela/ResponseRedirect', async (c) => {
    const body = await c.req.parseBody();
    const assertion = state.assertions.get(field(body, 'SAMLResponse'));
    if (!assertion || assertion.used || !findRequest(assertion.requestId)) return invalidRequest(c);
    return c.html(
      autoPostPage({
        action: '/acceso/respuesta',
        fields: { SAMLResponse: assertion.id, RelayState: assertion.requestId },
        title: 'Volviendo a la sede',
      }),
    );
  });

  // ------------------------------------------------------------------------------------------
  // Cl@ve Permanente (user + password, SMS code for nivel sustancial)
  // ------------------------------------------------------------------------------------------
  const permanentePage = (
    c: Ctx,
    request: GatewayRequest,
    opts: { dni?: string; errors?: Record<string, string>; error?: string } = {},
  ) =>
    c.html(
      gatewayPage({
        title: 'Cl@ve Permanente',
        body: html`<h1>Cl@ve Permanente</h1>
          <p>Escribe tu DNI o NIE y tu contraseña de Cl@ve Permanente.</p>
          ${opts.error ? alertBox('error', opts.error) : ''}
          ${errorSummary(opts.errors ?? {})}
          <form method="post" action="/pasarela/permanente" class="formulario" novalidate>
            <input type="hidden" name="req" value="${request.id}">
            ${textField({
              name: 'dni',
              label: 'DNI o NIE',
              value: opts.dni,
              required: true,
              autocomplete: 'username',
              help: 'Ejemplo: 12345678Z',
              error: opts.errors?.dni,
            })}
            ${textField({
              name: 'password',
              label: 'Contraseña',
              type: 'password',
              required: true,
              autocomplete: 'current-password',
              error: opts.errors?.password,
            })}
            <button type="submit" class="boton">Entrar</button>
          </form>
          <p class="volver"><a href="/pasarela?req=${request.id}">Volver a la selección de método</a></p>`,
      }),
      opts.error || opts.errors ? 400 : 200,
    );

  app.get('/pasarela/permanente', (c) => {
    const request = findRequest(c.req.query('req'));
    return request ? permanentePage(c, request) : invalidRequest(c);
  });

  const sendSms = (request: GatewayRequest, user: ClaveUser): SmsRecord => {
    const now = state.now();
    for (const old of state.sms) if (old.requestId === request.id) old.used = true;
    const sms: SmsRecord = {
      id: randomId(),
      requestId: request.id,
      dni: user.dni,
      phone: user.phone,
      code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
      sentAt: now,
      expiresAt: now + config.smsTtlSeconds * 1000,
      used: false,
    };
    state.sms.push(sms);
    ctx.log(
      `[SMS simulado] Para ${user.dni} (${maskPhone(user.phone)}): tu código Cl@ve es ${sms.code}. Caduca en ${Math.round(config.smsTtlSeconds / 60)} min.`,
    );
    return sms;
  };

  app.post('/pasarela/permanente', async (c) => {
    const body = await c.req.parseBody();
    const request = findRequest(field(body, 'req'));
    if (!request) return invalidRequest(c);
    const dni = normalizeDocumentId(field(body, 'dni'));
    const password = typeof body.password === 'string' ? body.password : '';
    const errors: Record<string, string> = {};
    if (!dni) errors.dni = 'Escribe tu DNI o NIE.';
    else if (validateDocumentId(dni)) errors.dni = 'El DNI o NIE no es válido.';
    if (!password) errors.password = 'Escribe tu contraseña.';
    if (Object.keys(errors).length) return permanentePage(c, request, { dni, errors });

    const now = state.now();
    const failures = state.failedLogins.get(dni) ?? { failures: 0 };
    if (failures.lockedUntil && failures.lockedUntil > now) {
      return permanentePage(c, request, {
        dni,
        error:
          'Tu usuario está bloqueado temporalmente porque has superado el número máximo de intentos. Inténtalo de nuevo dentro de 30 minutos.',
      });
    }
    const user = state.users.get(dni);
    if (!user || user.password !== password) {
      failures.failures += 1;
      if (failures.failures >= MAX_PASSWORD_FAILURES) {
        failures.lockedUntil = now + LOCKOUT_MS;
        failures.failures = 0;
      }
      state.failedLogins.set(dni, failures);
      const left = MAX_PASSWORD_FAILURES - failures.failures;
      return permanentePage(c, request, {
        dni,
        error: failures.lockedUntil
          ? 'Has superado el número máximo de intentos. Tu usuario queda bloqueado durante 30 minutos.'
          : `El usuario o la contraseña no son correctos. Te quedan ${left} ${left === 1 ? 'intento' : 'intentos'}.`,
      });
    }
    state.failedLogins.delete(dni);

    if (request.loa === 'low')
      return complete(c, request, identityFromUser(user, 'clave-permanente', 'low'));
    if (user.level === 'basico') {
      return permanentePage(c, request, {
        dni,
        error:
          'Tu registro en Cl@ve es de nivel básico y este trámite exige nivel avanzado. Puedes subir de nivel registrándote con tu certificado electrónico o en una oficina.',
      });
    }
    const sms = sendSms(request, user);
    request.permanente = { dni, codeAttempts: 0, resends: 0, smsId: sms.id };
    return c.redirect(`/pasarela/permanente/sms?req=${request.id}`, 303);
  });

  const smsPage = (
    c: Ctx,
    request: GatewayRequest,
    opts: { error?: string; info?: string; fieldError?: string } = {},
  ) => {
    const user = state.users.get(request.permanente!.dni)!;
    return c.html(
      gatewayPage({
        title: 'Verificación por SMS',
        body: html`<h1>Verificación por SMS</h1>
          <p>Este trámite exige un nivel de seguridad sustancial. Te hemos enviado un SMS con un código de 6 cifras al móvil terminado en <strong>${maskPhone(user.phone).slice(-3)}</strong>.</p>
          <p>El código caduca a los ${Math.round(config.smsTtlSeconds / 60)} minutos.</p>
          ${opts.info ? alertBox('info', opts.info) : ''}
          ${opts.error ? alertBox('error', opts.error) : ''}
          <form method="post" action="/pasarela/permanente/sms" class="formulario" novalidate>
            <input type="hidden" name="req" value="${request.id}">
            ${textField({
              name: 'codigo',
              label: 'Código recibido por SMS',
              required: true,
              inputmode: 'numeric',
              autocomplete: 'one-time-code',
              maxlength: 6,
              help: '6 cifras, sin espacios.',
              error: opts.fieldError,
            })}
            <div class="acciones">
              <button type="submit" name="accion" value="validar" class="boton">Validar código</button>
              <button type="submit" name="accion" value="reenviar" class="boton secundario">Reenviar SMS</button>
            </div>
          </form>
          <p class="volver"><a href="/pasarela?req=${request.id}">Cancelar y elegir otro método</a></p>`,
      }),
      opts.error || opts.fieldError ? 400 : 200,
    );
  };

  app.get('/pasarela/permanente/sms', (c) => {
    const request = findRequest(c.req.query('req'));
    if (!request?.permanente) return invalidRequest(c);
    return smsPage(c, request);
  });

  app.post('/pasarela/permanente/sms', async (c) => {
    const body = await c.req.parseBody();
    const request = findRequest(field(body, 'req'));
    if (!request?.permanente) return invalidRequest(c);
    const progress = request.permanente;
    const user = state.users.get(progress.dni);
    if (!user) return invalidRequest(c);

    if (field(body, 'accion') === 'reenviar') {
      if (progress.resends >= MAX_SMS_RESENDS) {
        return smsPage(c, request, {
          error: 'Has pedido demasiados códigos. Espera unos minutos y vuelve a empezar.',
        });
      }
      progress.resends += 1;
      progress.smsId = sendSms(request, user).id;
      return smsPage(c, request, {
        info: 'Te hemos enviado un código nuevo. El anterior ya no sirve.',
      });
    }

    const code = field(body, 'codigo').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) {
      return smsPage(c, request, { fieldError: 'Escribe el código de 6 cifras que has recibido.' });
    }
    const sms = state.sms.find((s) => s.id === progress.smsId);
    if (!sms || sms.used || sms.expiresAt < state.now()) {
      return smsPage(c, request, {
        error: 'El código ha caducado. Pide uno nuevo con «Reenviar SMS».',
      });
    }
    if (sms.code !== code) {
      progress.codeAttempts += 1;
      if (progress.codeAttempts >= MAX_SMS_ATTEMPTS) {
        request.consumed = true;
        sms.used = true;
        return c.html(
          gatewayPage({
            title: 'Demasiados intentos',
            body: html`<h1>Has superado el número de intentos</h1>
              ${alertBox('error', 'Has escrito mal el código demasiadas veces. Por seguridad, vuelve a empezar el acceso desde la sede.')}
              <p><a class="boton" href="/">Volver a la sede</a></p>`,
          }),
          400,
        );
      }
      const left = MAX_SMS_ATTEMPTS - progress.codeAttempts;
      return smsPage(c, request, {
        error: `El código no es correcto. Te ${left === 1 ? 'queda 1 intento' : `quedan ${left} intentos`}.`,
      });
    }
    sms.used = true;
    return complete(c, request, identityFromUser(user, 'clave-permanente', 'substantial'));
  });

  // ------------------------------------------------------------------------------------------
  // Cl@ve Móvil (QR + verification code + countdown; approved via the test API = "the phone")
  // ------------------------------------------------------------------------------------------
  const newMovil = (request: GatewayRequest): MovilRequest => {
    const now = state.now();
    for (const m of state.movil.values()) {
      if (m.requestId === request.id && m.status === 'pending') m.status = 'expired';
    }
    const movil: MovilRequest = {
      id: randomId(),
      requestId: request.id,
      verificationCode: randomCode(3),
      status: 'pending',
      createdAt: now,
      expiresAt: now + config.movilTtlSeconds * 1000,
    };
    state.movil.set(movil.id, movil);
    ctx.log(
      `[Cl@ve Móvil simulado] Acceso pendiente con código ${movil.verificationCode}. Apruébalo con: curl -sk -X POST ${ctx.urls.main}/__test/approve-movil`,
    );
    return movil;
  };

  const refreshMovil = (movil: MovilRequest) => {
    if (movil.status === 'pending' && movil.expiresAt <= state.now()) movil.status = 'expired';
    return movil;
  };

  const movilPage = (c: Ctx, request: GatewayRequest, movil: MovilRequest, message?: SafeHtml) => {
    const secondsLeft = Math.max(0, Math.round((movil.expiresAt - state.now()) / 1000));
    const finished = movil.status !== 'pending';
    return c.html(
      gatewayPage({
        title: 'Cl@ve Móvil',
        body: html`<h1>Cl@ve Móvil</h1>
          ${message ?? ''}
          <div class="movil" id="movil" data-estado-url="/pasarela/movil/estado?id=${movil.id}" data-segundos="${secondsLeft}" data-estado="${movil.status}">
            <div class="movil-qr">${fakeQrSvg(movil.id, 'Código QR para identificarte con Cl@ve Móvil')}</div>
            <div class="movil-pasos">
              <ol>
                <li>Abre la app Cl@ve en tu móvil y escanea este código QR.</li>
                <li>Comprueba que la app muestra este código de verificación: <strong class="codigo-verificacion" id="codigo-verificacion">${movil.verificationCode}</strong></li>
                <li>Confirma el acceso en la APP.</li>
              </ol>
              <p>Tiempo restante: <strong id="movil-cuenta" role="timer" aria-live="off">${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}</strong></p>
              <p id="movil-estado" role="status" aria-live="polite">${
                finished
                  ? movil.status === 'approved'
                    ? 'Acceso confirmado.'
                    : 'El código ya no es válido. Genera uno nuevo.'
                  : 'Esperando a que confirmes el acceso en la app…'
              }</p>
            </div>
          </div>
          <p class="aviso-seguridad">Escanea el código solo si la dirección de esta página empieza por <strong>${ctx.urls.main}</strong>.</p>
          <form method="post" action="/pasarela/movil/completar" id="movil-completar"${finished && movil.status !== 'approved' ? html` hidden` : ''}>
            <input type="hidden" name="req" value="${request.id}">
            <input type="hidden" name="id" value="${movil.id}">
            <button type="submit" class="boton secundario">Ya he confirmado el acceso en la app</button>
          </form>
          <form method="post" action="/pasarela/movil/nuevo" id="movil-nuevo"${finished && movil.status !== 'approved' ? '' : html` hidden`}>
            <input type="hidden" name="req" value="${request.id}">
            <button type="submit" class="boton">Generar un código nuevo</button>
          </form>
          <p class="volver"><a href="/pasarela?req=${request.id}">Volver a la selección de método</a></p>`,
      }),
    );
  };

  app.get('/pasarela/movil', (c) => {
    const request = findRequest(c.req.query('req'));
    if (!request) return invalidRequest(c);
    const existing = [...state.movil.values()]
      .map(refreshMovil)
      .find((m) => m.requestId === request.id && m.status === 'pending');
    return movilPage(c, request, existing ?? newMovil(request));
  });

  app.get('/pasarela/movil/estado', (c) => {
    const movil = state.movil.get(c.req.query('id') ?? '');
    if (!movil) return c.json({ status: 'unknown' }, 404);
    refreshMovil(movil);
    return c.json({
      status: movil.status,
      secondsLeft: Math.max(0, Math.round((movil.expiresAt - state.now()) / 1000)),
    });
  });

  app.post('/pasarela/movil/completar', async (c) => {
    const body = await c.req.parseBody();
    const request = findRequest(field(body, 'req'));
    const movil = state.movil.get(field(body, 'id'));
    if (!request || !movil || movil.requestId !== request.id) return invalidRequest(c);
    refreshMovil(movil);
    if (movil.status === 'approved') {
      const user = state.users.get(movil.dni ?? '') ?? DEMO_USER;
      return complete(c, request, identityFromUser(user, 'clave-movil', 'substantial'));
    }
    const message =
      movil.status === 'pending'
        ? alertBox(
            'aviso',
            'Todavía no has confirmado el acceso en la app. Confírmalo y vuelve a intentarlo.',
          )
        : movil.status === 'rejected'
          ? alertBox('error', 'Has rechazado el acceso en la app.')
          : alertBox('error', 'El código ha caducado. Genera uno nuevo.');
    return movilPage(c, request, movil, message);
  });

  app.post('/pasarela/movil/nuevo', async (c) => {
    const body = await c.req.parseBody();
    const request = findRequest(field(body, 'req'));
    if (!request) return invalidRequest(c);
    newMovil(request);
    return c.redirect(`/pasarela/movil?req=${request.id}`, 303);
  });
}
