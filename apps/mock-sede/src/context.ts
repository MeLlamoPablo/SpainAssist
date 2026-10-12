/** Shared types and helpers for the route modules. */
import type { HttpBindings } from '@hono/node-server';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { LOA_RANK, type Loa, type MockSedeState, type ProcedureId, type Session } from './state';
import { type SedePageOptions, sedePage } from './views';

export interface MockSedeConfig {
  sessionTimeoutSeconds: number;
  sessionWarningSeconds: number;
  smsTtlSeconds: number;
  movilTtlSeconds: number;
  gatewayRequestTtlSeconds: number;
  /** "No soy un robot" step in the cita previa flow. */
  captchaInCita: boolean;
  testApi: boolean;
  /** How long the imitation autoscript.js keeps trying to reach AutoFirma. */
  autofirma: { launchingTimeMs: number; retries: number; retryIntervalMs: number };
  maxUploadBytes: number;
}

export interface AppContext {
  state: MockSedeState;
  config: MockSedeConfig;
  /** Filled in once both servers listen. */
  urls: { main: string; cert: string };
  log(message: string): void;
}

export type AppEnv = {
  Bindings: HttpBindings;
  Variables: { session?: Session; sessionExpired?: boolean };
};
export type Ctx = Context<AppEnv>;

export const SESSION_COOKIE = 'SEDE_SESION';
export const CONSENT_COOKIE = 'sede_cookies';

export interface ProcedureInfo {
  id: ProcedureId;
  name: string;
  loa: Loa;
  infoPath: string;
  startPath: string;
}

export const PROCEDURES: Record<ProcedureId, ProcedureInfo> = {
  residencia: {
    id: 'residencia',
    name: 'Solicitud de certificado de residencia (prueba)',
    loa: 'substantial',
    infoPath: '/tramites/residencia',
    startPath: '/tramites/residencia/solicitud/datos-personales',
  },
  cita: {
    id: 'cita',
    name: 'Cita previa (prueba)',
    loa: 'low',
    infoPath: '/tramites/cita',
    startPath: '/tramites/cita/solicitud/oficina',
  },
};

/** Loads the session from the cookie, expiring it after the configured inactivity time. */
export function sessionMiddleware(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id) {
      const session = ctx.state.sessions.get(id);
      const now = ctx.state.now();
      if (session && now - session.lastSeen <= ctx.config.sessionTimeoutSeconds * 1000) {
        session.lastSeen = now;
        c.set('session', session);
      } else {
        if (session) ctx.state.sessions.delete(id);
        c.set('sessionExpired', true);
        deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
      }
    }
    await next();
  };
}

export function setSessionCookie(c: Ctx, id: string): void {
  setCookie(c, SESSION_COOKIE, id, { path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
}

/** Redirects to the identification flow unless the session has the procedure's level. */
export function requireLogin(procedure: ProcedureId): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = c.get('session');
    const info = PROCEDURES[procedure];
    if (!session) {
      if (c.get('sessionExpired')) {
        return c.redirect(`/sesion-caducada?procedimiento=${procedure}`, 303);
      }
      const back = c.req.method === 'GET' ? c.req.path : info.startPath;
      return c.redirect(
        `/acceso?procedimiento=${procedure}&volver=${encodeURIComponent(back)}`,
        303,
      );
    }
    if (LOA_RANK[session.identity.loa] < LOA_RANK[info.loa]) {
      return c.redirect(
        `/acceso?procedimiento=${procedure}&volver=${encodeURIComponent(info.startPath)}&motivo=nivel`,
        303,
      );
    }
    await next();
  };
}

/** Only same-origin absolute paths are accepted as return targets. */
export function safePath(value: string | undefined | null, fallback = '/'): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return fallback;
  }
  return value;
}

export function renderSede(
  c: Ctx,
  ctx: AppContext,
  opts: Omit<SedePageOptions, 'cookieBanner' | 'path' | 'session' | 'sessionTimeouts'>,
  status: 200 | 400 | 403 | 404 | 409 | 410 | 413 | 422 | 500 = 200,
): Response {
  return c.html(
    sedePage({
      ...opts,
      session: c.get('session'),
      cookieBanner: !getCookie(c, CONSENT_COOKIE),
      path: c.req.path,
      sessionTimeouts: {
        timeoutSeconds: ctx.config.sessionTimeoutSeconds,
        warningSeconds: ctx.config.sessionWarningSeconds,
      },
    }),
    status,
  );
}

/** Reads a text field from a parsed form body (files and missing fields become ""). */
export function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0].trim() : '';
  return typeof value === 'string' ? value.trim() : '';
}
