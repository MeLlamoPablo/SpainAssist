/**
 * The way of a procedure agent through SpainBench's Seguridad Social site, as a model that knows
 * it would walk it (the site's README, "Correct path"): read the vault, research, plan, open the
 * public page, answer the cookie banner, ask to consult, identify with Cl@ve Permanente (the app
 * types the saved credential, asking the user for it when none is saved: the model never sees
 * it), download the report, keep it in the
 * user's documents and report.
 *
 * Every step that needs a page waits for a text of it first, in a turn of its own, so the same
 * conversation happens however slow a redirect is (and a recorded run replays). A step that still
 * does not find its control waits a second and looks again.
 */
import { control, type Stage, waitForText } from './kit';

/** The public "Informe de tu vida laboral" page, where the way starts. */
export const INFO_URL =
  'https://portal.seg-social.gob.es/wps/portal/importass/importass/Categorias/Vida+laboral+e+informes/Informes+sobre+tu+situacion+laboral/Informe+de+tu+vida+laboral';

/** The logged-in "Tu vida laboral" page (the login returns to it). */
export const VIDA_LABORAL_URL =
  'https://portal.seg-social.gob.es/wps/myportal/importass/importass/tramites/datosvidalaboral';

/** Plausible pages of the same administration that are not on the way (the site leaves them out). */
export const DECOY_URLS = {
  sede: 'https://sede.seg-social.gob.es/wps/portal/sede/sede/Ciudadanos',
  informacion:
    'https://www.seg-social.es/wps/portal/wss/internet/Trabajadores/CotizacionRecaudacionTrabajadores/10721',
} as const;

const CLICK = (id: string, ref = '{{ref}}') => [{ id, name: 'browser_click', arguments: { ref } }];

/**
 * A step on a page: first a turn that waits for a text only that page shows, then the step, which
 * if it still does not find its control waits for the same text again.
 */
function onPage(text: string, stage: Stage): Stage[] {
  return [waitForText(`${stage.id}-ready`, text), { ...stage, wait: text }];
}

const OPEN = (id: string, url: string): Stage => ({
  id,
  calls: [{ id, name: 'browser_open', arguments: { url } }],
});

export interface ProcedureOptions {
  /** Read the saved report back (`document_read`) before reporting, as a careful agent may. */
  readReport?: boolean;
  /** Visit plausible pages that are not on the way before and after the login (wrong turns). */
  wander?: boolean;
}

const RESEARCH_QUERY = 'cómo obtener el informe de vida laboral de la Seguridad Social';

const PLAN_STEPS = [
  { id: 'identificarse', title: 'Identificarte con Cl@ve Permanente', owner: 'agent' },
  { id: 'descargar', title: 'Descargar tu informe de vida laboral', owner: 'agent' },
  { id: 'guardar', title: 'Guardar el informe en tus documentos', owner: 'agent' },
];

const steps = (done: number) =>
  PLAN_STEPS.map((step, index) => ({
    ...step,
    status: index < done ? 'done' : index === done ? 'current' : 'pending',
  }));

/** What the procedure agent does until the login is over and the logged-in page shows. */
export function stagesUntilLogin(options: ProcedureOptions): Stage[] {
  return [
    { id: 'vault', calls: [{ id: 'vault', name: 'vault_read', arguments: {} }] },
    {
      id: 'research',
      calls: [
        {
          id: 'research',
          name: 'web_research',
          arguments: { query: RESEARCH_QUERY, mode: 'fast' },
        },
      ],
    },
    {
      id: 'plan',
      calls: [
        {
          id: 'plan',
          name: 'procedure_update',
          arguments: {
            status: 'in_progress',
            administration: { level: 'state', name: 'Tesorería General de la Seguridad Social' },
            summary: 'Voy a sacar tu informe de vida laboral de la sede de la Seguridad Social.',
            steps: steps(0),
            sources: [{ title: 'Informe de tu vida laboral. Seguridad Social', url: INFO_URL }],
          },
        },
      ],
    },
    OPEN('open', INFO_URL),
    ...onPage('Rechazar todas', {
      id: 'cookies',
      when: { lastToolResult: control('button', 'Rechazar todas') },
      calls: CLICK('cookies'),
    }),
    ...(options.wander ? wanderBeforeLogin() : []),
    ...onPage('Consultar vida laboral', {
      id: 'consult',
      when: { lastToolResult: control('button', 'Consultar vida laboral') },
      calls: CLICK('consult'),
    }),
    ...onPage('Elige tu método de identificación', {
      id: 'method',
      when: { lastToolResult: control('button', 'Continuar') },
      calls: CLICK('method'),
    }),
    ...onPage('¿No puedes identificarte?', {
      id: 'clave',
      when: { lastToolResult: control('button', 'Acceder a Cl@ve Permanente') },
      calls: CLICK('clave'),
    }),
    ...onPage('DNI o NIE', {
      // The login form: the app types the saved credential (asking the user for it when none is
      // saved), the model never sees it.
      id: 'login',
      when: {
        lastToolResult: `${control('textbox', 'DNI o NIE', 'user')}[\\s\\S]*?${control('textbox', 'Contraseña', 'pass')}`,
      },
      calls: [
        {
          id: 'login',
          name: 'browser_login_clave',
          arguments: {
            usernameRef: '{{user}}',
            passwordRef: '{{pass}}',
            message: 'La necesito para entrar en la Seguridad Social por ti.',
          },
        },
      ],
    }),
    // The login hands the identity back to the portal through three pages that submit themselves.
    waitForText('logged-in', 'Descargar vida laboral'),
  ];
}

/** What the procedure agent does from the logged-in page to its report. */
export function stagesFromDownload(
  options: Pick<ProcedureOptions, 'readReport' | 'wander'>,
): Stage[] {
  return [
    ...(options.wander ? wanderAfterLogin() : []),
    {
      id: 'download',
      when: { lastToolResult: control('button', 'Descargar vida laboral') },
      wait: 'Descargar vida laboral',
      calls: CLICK('download'),
    },
    // The file arrives a moment later: the browser reports it in the observation that follows.
    {
      id: 'downloaded',
      calls: [{ id: 'downloaded', name: 'browser_wait', arguments: { seconds: 2 } }],
    },
    {
      id: 'save',
      when: { toolCalled: { name: 'browser_\\w+', result: 'downloadId (?<dl>[^\\s)]+)' } },
      wait: true,
      calls: [
        {
          id: 'save',
          name: 'download_save',
          arguments: { downloadId: '{{dl}}', name: 'Informe de vida laboral' },
        },
      ],
    },
    ...(options.readReport
      ? [
          {
            id: 'read-report',
            when: {
              toolCalled: { name: 'download_save', result: 'id (?<doc>[0-9a-f-]{36})' },
            },
            calls: [
              { id: 'read-report', name: 'document_read', arguments: { documentId: '{{doc}}' } },
            ],
          },
        ]
      : []),
    {
      id: 'done',
      calls: [
        {
          id: 'done',
          name: 'procedure_update',
          arguments: {
            status: 'done',
            summary: 'Tu informe de vida laboral está guardado en tus documentos.',
            steps: steps(PLAN_STEPS.length),
            clearNextAction: true,
          },
        },
      ],
    },
    { id: 'report', text: 'Hecho: el informe de vida laboral está guardado en tus documentos.' },
  ];
}

/** The whole way, from the first look at the vault to the report. */
export function procedureStages(options: ProcedureOptions): Stage[] {
  return [...stagesUntilLogin(options), ...stagesFromDownload(options)];
}

/**
 * A model that is lost on the public page: it follows the breadcrumb to a category page that is
 * not there and looks for the report on the other Seguridad Social sites, coming back to the page
 * each time.
 */
function wanderBeforeLogin(): Stage[] {
  return [
    ...onPage('Vida laboral e informes', {
      id: 'breadcrumb',
      when: { lastToolResult: control('link', 'Vida laboral e informes') },
      calls: CLICK('breadcrumb'),
    }),
    OPEN('back-1', INFO_URL),
    OPEN('sede', DECOY_URLS.sede),
    OPEN('informacion', DECOY_URLS.informacion),
    OPEN('back-2', INFO_URL),
  ];
}

/** After the login it presses "Informar error", which the site leaves out, and comes back. */
function wanderAfterLogin(): Stage[] {
  return [
    {
      id: 'informar-error',
      when: { lastToolResult: control('button', 'Informar error') },
      wait: 'Informar error',
      calls: CLICK('informar-error'),
    },
    OPEN('back-to-report', VIDA_LABORAL_URL),
    waitForText('back-to-report-ready', 'Descargar vida laboral'),
  ];
}
