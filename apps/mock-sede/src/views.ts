/** Page layouts and accessible form components (Spanish copy). */
import type { Option } from './data';
import { type HtmlValue, html, raw, type SafeHtml } from './html';
import type { AuthMethod, Session } from './state';

export const MINISTRY = 'Ministerio de Trámites Simulados';
export const SEDE_NAME = 'Sede electrónica';
export const TEST_NOTICE =
  'Entorno de pruebas: sitio ficticio para el desarrollo de Spain Assist. No introduzcas datos reales.';

export const AUTH_METHOD_LABELS: Record<AuthMethod, string> = {
  'clave-permanente': 'Cl@ve Permanente',
  'clave-movil': 'Cl@ve Móvil',
  certificado: 'certificado electrónico',
};

export interface Crumb {
  label: string;
  href?: string;
}

export interface SedePageOptions {
  title: string;
  body: HtmlValue;
  breadcrumbs?: Crumb[];
  session?: Session;
  /** Show the cookie banner (no consent cookie yet). */
  cookieBanner: boolean;
  /** Current path, used by the no-JS cookie form to come back. */
  path: string;
  scripts?: string[];
  sessionTimeouts: { timeoutSeconds: number; warningSeconds: number };
}

function header(session: Session | undefined): SafeHtml {
  const user = session
    ? html`<div class="usuario">
        <span class="usuario-nombre">${session.identity.fullName}</span>
        <span class="usuario-metodo">Identificado con ${AUTH_METHOD_LABELS[session.identity.method]}</span>
        <a href="/salir" class="enlace-salir">Cerrar sesión</a>
      </div>`
    : html`<div class="usuario"><a href="/acceso" class="enlace-acceder">Acceder</a></div>`;
  return html`<header class="cabecera">
    <div class="marca">
      <div class="escudo" aria-hidden="true"></div>
      <div>
        <p class="ministerio">${MINISTRY}</p>
        <p class="sede-nombre"><a href="/">${SEDE_NAME}</a></p>
      </div>
    </div>
    ${user}
  </header>
  <nav class="menu" aria-label="Menú principal">
    <ul>
      <li><a href="/">Inicio</a></li>
      <li><a href="/tramites">Trámites</a></li>
      <li><a href="/ayuda/autofirma">Ayuda y requisitos</a></li>
    </ul>
  </nav>`;
}

function breadcrumbs(crumbs: Crumb[] | undefined): SafeHtml {
  if (!crumbs?.length) return html``;
  const all: Crumb[] = [{ label: 'Inicio', href: '/' }, ...crumbs];
  return html`<nav class="migas" aria-label="Migas de pan">
    <ol>
      ${all.map((c, i) =>
        i === all.length - 1 || !c.href
          ? html`<li aria-current="page">${c.label}</li>`
          : html`<li><a href="${c.href}">${c.label}</a></li>`,
      )}
    </ol>
  </nav>`;
}

function cookieBanner(path: string): SafeHtml {
  return html`<section class="cookies" id="aviso-cookies" role="dialog" aria-modal="false" aria-labelledby="cookies-titulo">
    <h2 id="cookies-titulo">Esta sede utiliza cookies</h2>
    <p>
      Usamos cookies técnicas, necesarias para que la sede funcione, y cookies de análisis para
      mejorar el servicio. Puedes aceptarlas todas o rechazar las opcionales.
      <a href="/info/cookies">Más información</a>
    </p>
    <form method="post" action="/cookies" class="cookies-acciones" data-cookies-form>
      <input type="hidden" name="volver" value="${path}">
      <button type="submit" name="decision" value="aceptadas" class="boton">Aceptar todas</button>
      <button type="submit" name="decision" value="rechazadas" class="boton secundario">Rechazar opcionales</button>
    </form>
  </section>`;
}

const sessionDialog = html`<div class="modal-fondo" id="aviso-sesion" hidden>
  <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="sesion-titulo" aria-describedby="sesion-texto">
    <h2 id="sesion-titulo">Tu sesión va a caducar</h2>
    <p id="sesion-texto">
      Por seguridad, tu sesión se cerrará en <strong id="sesion-cuenta">2:00</strong> si no haces nada.
      Si se cierra, perderás los datos que no hayas guardado.
    </p>
    <div class="acciones">
      <button type="button" class="boton" id="sesion-continuar">Seguir conectado</button>
      <a href="/salir" class="boton secundario">Cerrar sesión</a>
    </div>
  </div>
</div>`;

export function sedePage(opts: SedePageOptions): string {
  const loggedIn = Boolean(opts.session);
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · ${SEDE_NAME} · ${MINISTRY}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/css/sede.css">
<script src="/js/sede.js" defer></script>
${(opts.scripts ?? []).map((src) => html`<script src="${src}"></script>`)}
</head>
<body class="sede"${
    loggedIn
      ? raw(
          ` data-session-timeout="${opts.sessionTimeouts.timeoutSeconds}" data-session-warning="${opts.sessionTimeouts.warningSeconds}"`,
        )
      : ''
  }>
<a class="saltar" href="#contenido">Ir al contenido principal</a>
<div class="aviso-pruebas" role="note">${TEST_NOTICE}</div>
${header(opts.session)}
${breadcrumbs(opts.breadcrumbs)}
<main id="contenido" class="contenido">
${opts.body}
</main>
<footer class="pie">
  <ul>
    <li><a href="/info/accesibilidad">Accesibilidad</a></li>
    <li><a href="/info/aviso-legal">Aviso legal</a></li>
    <li><a href="/info/proteccion-datos">Protección de datos</a></li>
    <li><a href="/info/cookies">Política de cookies</a></li>
  </ul>
  <p>${MINISTRY} (ficticio). Sede electrónica de pruebas.</p>
</footer>
${opts.cookieBanner ? cookieBanner(opts.path) : ''}
${loggedIn ? sessionDialog : ''}
</body>
</html>`.value;
}

/** Layout of the Cl@ve-like identification gateway (different branding from the sede). */
export function gatewayPage(opts: { title: string; body: HtmlValue; scripts?: string[] }): string {
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · Cl@ve (simulada)</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/css/sede.css">
<script src="/js/sede.js" defer></script>
${(opts.scripts ?? []).map((src) => html`<script src="${src}"></script>`)}
</head>
<body class="pasarela">
<a class="saltar" href="#contenido">Ir al contenido principal</a>
<div class="aviso-pruebas" role="note">${TEST_NOTICE}</div>
<header class="clave-cabecera">
  <p class="clave-logo" aria-label="Cl@ve">Cl@ve</p>
  <p class="clave-lema">Identificación electrónica para las Administraciones (simulada)</p>
</header>
<main id="contenido" class="contenido">
${opts.body}
</main>
<footer class="pie pie-clave"><p>Cl@ve v2.8.4 (simulada). Entorno de pruebas.</p></footer>
</body>
</html>`.value;
}

/**
 * Self-submitting POST form, like the SAML hops between a sede, Cl@ve and the identity
 * providers. Works without JavaScript through the "Continuar" button.
 */
export function autoPostPage(opts: {
  action: string;
  fields: Record<string, string>;
  title?: string;
}): string {
  return html`<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>${opts.title ?? 'Redirigiendo'}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/css/sede.css"></head>
<body class="redirigiendo">
<main class="contenido">
<form method="post" action="${opts.action}" id="saml-form">
  ${Object.entries(opts.fields).map(
    ([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`,
  )}
  <p>Redirigiendo… Si no ocurre nada, pulsa «Continuar».</p>
  <button type="submit" class="boton">Continuar</button>
</form>
</main>
<script>document.getElementById('saml-form').submit();</script>
</body>
</html>`.value;
}

// -------------------------------------------------------------------------------------------
// Form components
// -------------------------------------------------------------------------------------------

interface FieldBase {
  name: string;
  label: string;
  error?: string;
  help?: HtmlValue;
  required?: boolean;
  id?: string;
}

function labelText(label: string, required?: boolean): SafeHtml {
  return required
    ? html`${label}<span class="req" aria-hidden="true"> *</span><span class="visualmente-oculto"> (obligatorio)</span>`
    : html`${label} <span class="opcional">(opcional)</span>`;
}

function describedBy(id: string, f: FieldBase): string | undefined {
  const ids = [f.help ? `${id}-ayuda` : '', f.error ? `${id}-error` : ''].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

function attr(name: string, value: string | number | undefined | boolean): SafeHtml {
  if (value === undefined || value === false) return html``;
  if (value === true) return raw(` ${name}`);
  return html` ${raw(name)}="${String(value)}"`;
}

function helpAndError(id: string, f: FieldBase): SafeHtml {
  return html`${f.help ? html`<p class="ayuda" id="${id}-ayuda">${f.help}</p>` : ''}
    ${f.error ? html`<p class="error-campo" id="${id}-error"><span class="visualmente-oculto">Error: </span>${f.error}</p>` : ''}`;
}

export function textField(
  f: FieldBase & {
    value?: string;
    type?: string;
    autocomplete?: string;
    inputmode?: string;
    placeholder?: string;
    maxlength?: number;
    readonly?: boolean;
  },
): SafeHtml {
  const id = f.id ?? f.name;
  return html`<div class="campo${f.error ? ' con-error' : ''}">
    <label for="${id}">${labelText(f.label, f.required)}</label>
    ${helpAndError(id, f)}
    <input id="${id}" name="${f.name}" type="${f.type ?? 'text'}" value="${f.value ?? ''}"${attr(
      'required',
      f.required,
    )}${attr('aria-required', f.required ? 'true' : undefined)}${attr(
      'aria-invalid',
      f.error ? 'true' : undefined,
    )}${attr('aria-describedby', describedBy(id, f))}${attr('autocomplete', f.autocomplete)}${attr(
      'inputmode',
      f.inputmode,
    )}${attr('placeholder', f.placeholder)}${attr('maxlength', f.maxlength)}${attr(
      'readonly',
      f.readonly,
    )}>
  </div>`;
}

export function textareaField(f: FieldBase & { value?: string; rows?: number }): SafeHtml {
  const id = f.id ?? f.name;
  return html`<div class="campo${f.error ? ' con-error' : ''}">
    <label for="${id}">${labelText(f.label, f.required)}</label>
    ${helpAndError(id, f)}
    <textarea id="${id}" name="${f.name}" rows="${f.rows ?? 3}"${attr('required', f.required)}${attr(
      'aria-invalid',
      f.error ? 'true' : undefined,
    )}${attr('aria-describedby', describedBy(id, f))}>${f.value ?? ''}</textarea>
  </div>`;
}

export function selectField(
  f: FieldBase & { value?: string; options: Option[]; placeholder?: string },
): SafeHtml {
  const id = f.id ?? f.name;
  return html`<div class="campo${f.error ? ' con-error' : ''}">
    <label for="${id}">${labelText(f.label, f.required)}</label>
    ${helpAndError(id, f)}
    <select id="${id}" name="${f.name}"${attr('required', f.required)}${attr(
      'aria-invalid',
      f.error ? 'true' : undefined,
    )}${attr('aria-describedby', describedBy(id, f))}>
      <option value="">${f.placeholder ?? 'Selecciona una opción'}</option>
      ${f.options.map(
        (o) =>
          html`<option value="${o.value}"${attr('selected', o.value === f.value)}>${o.label}</option>`,
      )}
    </select>
  </div>`;
}

export function radioGroup(f: FieldBase & { value?: string; options: Option[] }): SafeHtml {
  const id = f.id ?? f.name;
  return html`<fieldset class="campo grupo${f.error ? ' con-error' : ''}" id="${id}"${attr(
    'aria-describedby',
    describedBy(id, f),
  )}>
    <legend>${labelText(f.label, f.required)}</legend>
    ${helpAndError(id, f)}
    ${f.options.map(
      (o, i) => html`<div class="opcion">
        <input type="radio" id="${id}-${i}" name="${f.name}" value="${o.value}"${attr(
          'checked',
          o.value === f.value,
        )}${attr('required', f.required && i === 0)}>
        <label for="${id}-${i}">${o.label}</label>
      </div>`,
    )}
  </fieldset>`;
}

export function checkboxField(
  f: FieldBase & { checked?: boolean; value?: string; labelHtml?: HtmlValue },
): SafeHtml {
  const id = f.id ?? f.name;
  return html`<div class="campo casilla${f.error ? ' con-error' : ''}">
    ${f.error ? html`<p class="error-campo" id="${id}-error"><span class="visualmente-oculto">Error: </span>${f.error}</p>` : ''}
    <input type="checkbox" id="${id}" name="${f.name}" value="${f.value ?? 'si'}"${attr(
      'checked',
      f.checked,
    )}${attr('required', f.required)}${attr('aria-invalid', f.error ? 'true' : undefined)}${attr(
      'aria-describedby',
      describedBy(id, f),
    )}>
    <label for="${id}">${f.labelHtml ?? f.label}${f.required ? html`<span class="req" aria-hidden="true"> *</span>` : ''}</label>
    ${f.help ? html`<p class="ayuda" id="${id}-ayuda">${f.help}</p>` : ''}
  </div>`;
}

export function fileField(f: FieldBase & { accept: string; current?: string }): SafeHtml {
  const id = f.id ?? f.name;
  return html`<div class="campo${f.error ? ' con-error' : ''}">
    <label for="${id}">${labelText(f.label, f.required && !f.current)}</label>
    ${helpAndError(id, f)}
    ${f.current ? html`<p class="adjunto-actual" id="${id}-actual">Documento adjuntado: <strong>${f.current}</strong>. Si eliges otro archivo, sustituirá al actual.</p>` : ''}
    <input type="file" id="${id}" name="${f.name}" accept="${f.accept}"${attr(
      'aria-invalid',
      f.error ? 'true' : undefined,
    )}${attr('aria-describedby', describedBy(id, f))}>
  </div>`;
}

/** Error summary shown at the top of a form; links point to the fields. */
export function errorSummary(errors: Record<string, string>): SafeHtml {
  const entries = Object.entries(errors);
  if (!entries.length) return html``;
  return html`<div class="resumen-errores" role="alert" aria-labelledby="resumen-errores-titulo" tabindex="-1">
    <h2 id="resumen-errores-titulo">Revisa los datos del formulario</h2>
    <ul>
      ${entries.map(([field, message]) => html`<li><a href="#${field}">${message}</a></li>`)}
    </ul>
  </div>`;
}

export function alertBox(
  kind: 'info' | 'error' | 'exito' | 'aviso',
  content: HtmlValue,
  opts: { id?: string; title?: string } = {},
): SafeHtml {
  const role = kind === 'error' ? 'alert' : 'status';
  return html`<div class="alerta alerta-${kind}" role="${role}"${attr('id', opts.id)}>
    ${opts.title ? html`<p class="alerta-titulo">${opts.title}</p>` : ''}
    <div>${content}</div>
  </div>`;
}

export function stepIndicator(steps: string[], current: number): SafeHtml {
  return html`<ol class="pasos" aria-label="Pasos de la solicitud">
    ${steps.map(
      (s, i) =>
        html`<li class="${i < current ? 'hecho' : i === current ? 'actual' : ''}"${attr(
          'aria-current',
          i === current ? 'step' : undefined,
        )}><span class="paso-num">${i + 1}</span> ${s}</li>`,
    )}
  </ol>
  <p class="paso-texto">Paso ${current + 1} de ${steps.length}</p>`;
}

/** Definition list used on review pages and receipts. */
export function summaryList(rows: [string, HtmlValue][]): SafeHtml {
  return html`<dl class="resumen">
    ${rows.map(([k, v]) => html`<div class="fila"><dt>${k}</dt><dd>${v || '—'}</dd></div>`)}
  </dl>`;
}
