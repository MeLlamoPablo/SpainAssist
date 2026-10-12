/** Sede pages: home, procedure list, info pages, cookies, identification start/return, logout. */
import type { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Asset } from '../assets';
import {
  type AppContext,
  type AppEnv,
  CONSENT_COOKIE,
  field,
  PROCEDURES,
  renderSede,
  SESSION_COOKIE,
  safePath,
  setSessionCookie,
} from '../context';
import { html } from '../html';
import { type ProcedureId, randomId, type Session } from '../state';
import { alertBox, autoPostPage } from '../views';

const procedureCards = html`<ul class="tarjetas">
  <li class="tarjeta">
    <h3><a href="/tramites/residencia">${PROCEDURES.residencia.name}</a></h3>
    <p>Pide un certificado que acredita dónde vives. Tienes que identificarte y firmar la solicitud con tu certificado electrónico.</p>
    <p class="requisitos">Identificación: Cl@ve o certificado electrónico. Firma: certificado electrónico con AutoFirma.</p>
  </li>
  <li class="tarjeta">
    <h3><a href="/tramites/cita">${PROCEDURES.cita.name}</a></h3>
    <p>Reserva día y hora para que te atiendan en una oficina.</p>
    <p class="requisitos">Identificación: Cl@ve o certificado electrónico.</p>
  </li>
</ul>`;

const INFO_PAGES: Record<string, { title: string; paragraphs: string[] }> = {
  accesibilidad: {
    title: 'Accesibilidad',
    paragraphs: [
      'Esta sede de pruebas intenta cumplir las pautas de accesibilidad WCAG 2.1 (nivel AA).',
      'Si encuentras algún problema de accesibilidad, recuerda que este sitio es ficticio y solo sirve para pruebas.',
    ],
  },
  'aviso-legal': {
    title: 'Aviso legal',
    paragraphs: [
      'Este sitio es una simulación para desarrollar y probar Spain Assist. No pertenece a ninguna Administración real.',
      'Los trámites, registros y justificantes que genera no tienen validez legal.',
    ],
  },
  'proteccion-datos': {
    title: 'Protección de datos',
    paragraphs: [
      'Los datos que introduces se guardan solo en la memoria de este servidor de pruebas y se borran al reiniciarlo.',
      'No introduzcas datos personales reales.',
    ],
  },
  cookies: {
    title: 'Política de cookies',
    paragraphs: [
      'Usamos una cookie técnica para mantener tu sesión (SEDE_SESION) y otra para recordar tu decisión sobre las cookies (sede_cookies).',
      'Las cookies de análisis son ficticias: esta sede de pruebas no recoge estadísticas.',
    ],
  },
};

export function registerSedeRoutes(
  app: Hono<AppEnv>,
  ctx: AppContext,
  assets: Map<string, Asset>,
): void {
  const { state } = ctx;

  for (const [path, asset] of assets) {
    app.get(path, (c) =>
      c.body(asset.body, 200, { 'content-type': asset.contentType, 'cache-control': 'no-store' }),
    );
  }

  app.get('/', (c) =>
    renderSede(c, ctx, {
      title: 'Inicio',
      body: html`<h1>Sede electrónica del Ministerio de Trámites Simulados</h1>
        ${c.req.query('sesion') === 'cerrada' ? alertBox('exito', 'Has cerrado la sesión correctamente.') : ''}
        <p class="intro">Haz tus trámites en línea, a cualquier hora y sin desplazarte. Para la mayoría necesitas identificarte con Cl@ve o con un certificado electrónico.</p>
        <section aria-labelledby="destacados">
          <h2 id="destacados">Trámites destacados</h2>
          ${procedureCards}
        </section>
        <section aria-labelledby="otros">
          <h2 id="otros">Otros servicios</h2>
          <ul>
            <li><a href="/ayuda/autofirma">Requisitos técnicos y comprobación de AutoFirma</a></li>
            <li><a href="/gsede/acceso">Mi carpeta (acceso con certificado y AutoFirma)</a></li>
            <li><a href="/verificacion?continuar=/">Verificación de seguridad («No soy un robot»)</a></li>
          </ul>
        </section>`,
    }),
  );

  app.get('/tramites', (c) =>
    renderSede(c, ctx, {
      title: 'Trámites',
      breadcrumbs: [{ label: 'Trámites' }],
      body: html`<h1>Catálogo de trámites</h1>
        <p>Estos son los trámites disponibles en esta sede de pruebas.</p>
        ${procedureCards}`,
    }),
  );

  app.get('/info/:slug', (c) => {
    const page = INFO_PAGES[c.req.param('slug')];
    if (!page) return c.notFound();
    return renderSede(c, ctx, {
      title: page.title,
      breadcrumbs: [{ label: page.title }],
      body: html`<h1>${page.title}</h1>${page.paragraphs.map((p) => html`<p>${p}</p>`)}`,
    });
  });

  // Cookie banner: fetch() from sede.js (204) or plain form POST (redirect back).
  app.post('/cookies', async (c) => {
    const body = await c.req.parseBody();
    const decision = field(body, 'decision') === 'aceptadas' ? 'aceptadas' : 'rechazadas';
    setCookie(c, CONSENT_COOKIE, decision, {
      path: '/',
      secure: true,
      sameSite: 'Lax',
      maxAge: 365 * 86_400,
    });
    if (c.req.header('x-requested-with') === 'fetch') return c.body(null, 204);
    return c.redirect(safePath(field(body, 'volver')), 303);
  });

  // ------------------------------------------------------------------------------------------
  // Identification: the sede acts as a SAML-like service provider of the Cl@ve gateway.
  // ------------------------------------------------------------------------------------------
  app.get('/acceso', (c) => {
    const procedureParam = c.req.query('procedimiento');
    const procedure =
      procedureParam && procedureParam in PROCEDURES ? (procedureParam as ProcedureId) : undefined;
    const info = procedure ? PROCEDURES[procedure] : undefined;
    const request = {
      id: randomId(),
      issuer: 'sede-tramites-simulados',
      procedure: procedure ?? 'general',
      loa: info?.loa ?? 'low',
      returnTo: safePath(c.req.query('volver'), info?.startPath ?? '/'),
      issueInstant: new Date(state.now()).toISOString(),
    };
    return c.html(
      autoPostPage({
        action: '/pasarela/ServiceProvider',
        fields: {
          SAMLRequest: Buffer.from(JSON.stringify(request)).toString('base64'),
          RelayState: randomId(8),
        },
        title: 'Redirigiendo a Cl@ve',
      }),
    );
  });

  const acsBody = z.object({ SAMLResponse: z.string().min(1).max(200) });
  app.post('/acceso/respuesta', async (c) => {
    const parsed = acsBody.safeParse(await c.req.parseBody());
    const assertion = parsed.success ? state.assertions.get(parsed.data.SAMLResponse) : undefined;
    const request = assertion ? state.gatewayRequests.get(assertion.requestId) : undefined;
    if (
      !assertion ||
      !request ||
      assertion.used ||
      state.now() - assertion.createdAt > 5 * 60_000
    ) {
      return renderSede(
        c,
        ctx,
        {
          title: 'Error de identificación',
          body: html`<h1>No se ha podido completar la identificación</h1>
            ${alertBox('error', 'La respuesta de Cl@ve no es válida o ha caducado. Vuelve a intentarlo desde el trámite.')}
            <p><a href="/" class="boton">Volver al inicio</a></p>`,
        },
        400,
      );
    }
    assertion.used = true;
    request.consumed = true;
    const previous = c.get('session');
    if (previous) state.sessions.delete(previous.id);
    const now = state.now();
    const session: Session = {
      id: randomId(18),
      identity: assertion.identity,
      createdAt: now,
      lastSeen: now,
      residencia: previous?.identity.dni === assertion.identity.dni ? previous.residencia : {},
      cita: previous?.identity.dni === assertion.identity.dni ? previous.cita : {},
      captchaPassed: false,
    };
    state.sessions.set(session.id, session);
    setSessionCookie(c, session.id);
    ctx.log(
      `[Sede] Sesión iniciada: ${session.identity.fullName} (${session.identity.dni}) con ${session.identity.method}, nivel ${session.identity.loa}`,
    );
    return c.redirect(request.returnTo, 303);
  });

  app.get('/salir', (c) => {
    const session = c.get('session');
    if (session) state.sessions.delete(session.id);
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return c.redirect('/?sesion=cerrada', 303);
  });

  app.post('/sesion/renovar', (c) => (c.get('session') ? c.body(null, 204) : c.body(null, 401)));

  app.get('/sesion-caducada', (c) => {
    const procedureParam = c.req.query('procedimiento');
    const procedure =
      procedureParam && procedureParam in PROCEDURES ? (procedureParam as ProcedureId) : undefined;
    const again = procedure ? `/acceso?procedimiento=${procedure}` : '/acceso';
    return renderSede(c, ctx, {
      title: 'Sesión caducada',
      body: html`<h1>Tu sesión ha caducado</h1>
        ${alertBox('aviso', 'Por seguridad, cerramos la sesión tras un tiempo sin actividad. Los datos que no hubieras enviado se han perdido.')}
        <p><a href="${again}" class="boton">Volver a identificarme</a></p>`,
    });
  });
}
