/**
 * "DNIe / Certificado electrónico" identity provider. Runs on its own HTTPS port that asks for a
 * TLS client certificate during the handshake (like pasarela-ident.clave.gob.es). Without a
 * certificate it shows the Cl@ve error "003002 - Authentication Failed (no certificate has been
 * submitted)".
 */
import type { TLSSocket } from 'node:tls';
import { Hono } from 'hono';
import type { Asset } from '../assets';
import { describeCertificate } from '../certinfo';
import { type AppContext, type AppEnv, type Ctx, field } from '../context';
import { html } from '../html';
import { randomId, type SedeIdentity } from '../state';
import { alertBox, autoPostPage, gatewayPage } from '../views';

/** Error codes shown by the mock. Only 003002 mirrors a message observed on the real gateway. */
export const CERT_ERRORS = {
  noCertificate: {
    code: '003002',
    english: 'Authentication Failed (no certificate has been submitted)',
    spanish:
      'No se ha presentado ningún certificado electrónico. Si tienes uno, comprueba que está instalado en tu navegador y que lo seleccionas cuando el navegador te lo pida.',
  },
  expired: {
    code: '003005',
    english: 'Authentication Failed (certificate expired or not yet valid)',
    spanish: 'El certificado que has presentado está caducado o todavía no es válido.',
  },
  untrusted: {
    code: '003006',
    english: 'Authentication Failed (certificate not trusted)',
    spanish:
      'El certificado que has presentado no lo ha emitido una autoridad de certificación reconocida.',
  },
  noDocumentId: {
    code: '003007',
    english: 'Authentication Failed (no identity document in certificate)',
    spanish: 'El certificado no contiene un DNI o NIE. Usa un certificado de persona física.',
  },
} as const;

function splitSurnames(surname: string | undefined): [string, string] {
  const words = (surname ?? '').split(/\s+/).filter(Boolean);
  return words.length === 2 ? [words[0]!, words[1]!] : [words.join(' '), ''];
}

export function createCertIdpApp(ctx: AppContext, assets: Map<string, Asset>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { state } = ctx;

  for (const [path, asset] of assets) {
    if (path.startsWith('/css/') || path === '/js/sede.js') {
      app.get(path, (c) => c.body(asset.body, 200, { 'content-type': asset.contentType }));
    }
  }

  const errorPage = (
    c: Ctx,
    requestId: string,
    error: (typeof CERT_ERRORS)[keyof typeof CERT_ERRORS],
  ) => {
    ctx.log(`[Certificado] Error ${error.code} - ${error.english}`);
    return c.html(
      gatewayPage({
        title: `Error ${error.code}`,
        body: html`<h1>Error en la identificación con certificado</h1>
          ${alertBox('error', html`<p>${error.spanish}</p>`, {
            title: `Error ${error.code} - ${error.english}`,
          })}
          <p><a class="boton" href="${ctx.urls.main}/pasarela?req=${requestId}">Volver a la selección de método</a></p>
          <p><a href="${ctx.urls.main}/">Volver a la sede</a></p>`,
      }),
      403,
    );
  };

  app.all('/IdP/AuthenticateCitizen', async (c) => {
    const requestId =
      c.req.method === 'POST' ? field(await c.req.parseBody(), 'req') : (c.req.query('req') ?? '');
    const request = state.gatewayRequests.get(requestId);
    if (!request || request.consumed || request.expiresAt < state.now()) {
      return c.html(
        gatewayPage({
          title: 'Solicitud no válida',
          body: html`<h1>No podemos continuar con la identificación</h1>
            ${alertBox('error', 'La solicitud de identificación no es válida o ha caducado. Vuelve a la sede e inicia de nuevo el acceso.')}
            <p><a class="boton" href="${ctx.urls.main}/">Volver a la sede</a></p>`,
        }),
        400,
      );
    }

    const socket = c.env.incoming.socket as TLSSocket;
    const peer = socket.getPeerCertificate(true);
    if (!peer?.raw) return errorPage(c, request.id, CERT_ERRORS.noCertificate);
    if (!socket.authorized) {
      const reason = String(socket.authorizationError ?? '');
      return errorPage(
        c,
        request.id,
        /EXPIRED|NOT_YET_VALID/.test(reason) ? CERT_ERRORS.expired : CERT_ERRORS.untrusted,
      );
    }
    const holder = describeCertificate(peer.raw);
    if (!holder.dni) return errorPage(c, request.id, CERT_ERRORS.noDocumentId);

    const [surname1, surname2] = splitSurnames(holder.surname);
    const knownUser = state.users.get(holder.dni);
    const identity: SedeIdentity = {
      dni: holder.dni,
      givenName: holder.givenName ?? knownUser?.givenName ?? '',
      surname1: knownUser?.surname1 ?? surname1,
      surname2: knownUser?.surname2 ?? surname2,
      fullName: [holder.givenName, holder.surname].filter(Boolean).join(' '),
      method: 'certificado',
      loa: 'high',
      email: knownUser?.email,
      phone: knownUser?.phone,
      certificateSha256: holder.sha256,
    };
    const assertion = {
      id: randomId(18),
      requestId: request.id,
      identity,
      createdAt: state.now(),
      used: false,
    };
    state.assertions.set(assertion.id, assertion);
    ctx.log(`[Certificado] Identificado ${holder.commonName} (emisor: ${holder.issuerCommonName})`);
    return c.html(
      autoPostPage({
        action: `${ctx.urls.main}/pasarela/ResponseRedirect`,
        fields: { SAMLResponse: assertion.id, RelayState: request.id },
        title: 'Volviendo a Cl@ve',
      }),
    );
  });

  // Diagnostic page: shows which certificate (if any) the browser presented.
  app.get('/', (c) => {
    const socket = c.env.incoming.socket as TLSSocket;
    const peer = socket.getPeerCertificate(true);
    const holder = peer?.raw ? describeCertificate(peer.raw) : undefined;
    return c.html(
      gatewayPage({
        title: 'Identificación con certificado',
        body: html`<h1>Servicio de identificación con certificado (simulado)</h1>
          <p>Esta dirección solo se usa durante el acceso con «DNIe / Certificado electrónico».</p>
          ${
            holder
              ? alertBox(
                  socket.authorized ? 'exito' : 'aviso',
                  html`Tu navegador ha presentado el certificado <strong>${holder.commonName ?? '(sin nombre)'}</strong>, emitido por ${holder.issuerCommonName ?? 'una entidad desconocida'}${socket.authorized ? '.' : html`, pero no es válido aquí (${String(socket.authorizationError)}).`}`,
                )
              : alertBox('info', 'Tu navegador no ha presentado ningún certificado.')
          }
          <p><a href="${ctx.urls.main}/">Ir a la sede</a></p>`,
      }),
    );
  });

  return app;
}
