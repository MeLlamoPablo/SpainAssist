/**
 * The way of an agent through SpainBench's Seguridad Social site, as a model that knows it would
 * write it (the site's README, "Correct path"), in two runs of one workflow (`vida-laboral`):
 *
 * 1. the card, the research, the way to the logged-in page: the public page, the cookie banner,
 *    "Consultar", the method, Cl@ve Permanente (the app types the saved credential, asking the user
 *    for it when none is saved: the model never sees it). When nothing is saved it first asks the
 *    user how they identify themselves, in an interface. It returns what the logged-in page shows
 *    (`URL:`, `Title:`, the snapshot), so the model reads the page before the next step;
 * 2. the same workflow again (its procedure and its browser are kept): the download, kept in the
 *    user's documents, read back when the model is careful, and the card done.
 *
 * Then the agent reports. Locators wait for their element, so a slow redirect needs no turn of
 * its own; a page that never shows one fails the workflow, and the agent ends.
 */
import { type Stage, workflow } from './kit';

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

/** How the second run's result starts: the id of the saved report follows. */
export const SAVED = 'Guardado en tus documentos:';

/** The workflow's id: both of its runs. */
export const WORKFLOW_ID = 'vida-laboral';

export interface AgentOptions {
  /** Nothing is saved: ask the user how they identify themselves first, in an interface. */
  askMethod?: boolean;
  /** Read the saved report back (`api.documents.read`) before reporting, as a careful agent may. */
  readReport?: boolean;
  /** Visit plausible pages that are not on the way before and after the login (wrong turns). */
  wander?: boolean;
}

const RESEARCH_QUERY = 'cómo obtener el informe de vida laboral de la Seguridad Social';

const STEPS = `[
    { id: 'identificarse', title: 'Identificarte con Cl@ve Permanente', owner: 'agent' },
    { id: 'descargar', title: 'Descargar tu informe de vida laboral', owner: 'agent' },
    { id: 'guardar', title: 'Guardar el informe en tus documentos', owner: 'agent' },
  ]`;

/** The way a person identifies themselves to the Seguridad Social: what the question offers. */
const METHOD_FORM = `function MethodForm({ api }) {
  const [metodo, setMetodo] = api.ui.useDurableState('metodo', '');
  const options = [
    { value: 'clave_permanente', label: 'Cl@ve Permanente' },
    { value: 'clave_movil', label: 'Cl@ve Móvil' },
    { value: 'sms', label: 'Vía SMS' },
    { value: 'certificado', label: 'Certificado digital o DNIe' },
  ];
  return (
    <Form title="¿Cómo te identificas?" description="Para sacar tu vida laboral la Seguridad Social te pide identificarte.">
      <Select label="Método de identificación" options={options} value={metodo} onChange={setMetodo} />
      <Actions>
        <Button type="primary" disabled={!metodo} onClick={() => api.ui.close(metodo)}>Seguir</Button>
      </Actions>
    </Form>
  );
}`;

const button = (name: string) => `page.getByRole('button', { name: '${name}' })`;

/** Wrong turns before the login: a breadcrumb the site leaves out, and two other sites. */
const WANDER_BEFORE = `
  await page.getByRole('link', { name: 'Vida laboral e informes' }).first().click();
  await page.goto(INFO_URL);
  for (const url of ['${DECOY_URLS.sede}', '${DECOY_URLS.informacion}']) {
    try { await page.goto(url); } catch (e) { console.log('No se abre ' + url + ': ' + e.message); }
  }
  await page.goto(INFO_URL);`;

/** A wrong turn after it: "Informar error", which the site leaves out, and back. */
const WANDER_AFTER = `
  await ${button('Informar error')}.click();
  await page.goto('${VIDA_LABORAL_URL}');
  await page.waitForText('Descargar vida laboral', { timeout: 30000 });`;

/** The first run: the card, the research, the method when nothing is saved, the login. */
export function untilLogin(options: AgentOptions = {}) {
  const ask = options.askMethod
    ? `
  const vault = await api.vault.read();
  if (!vault.credentials.some((c) => c.kind === 'clave_permanente')) {
    const metodo = await api.ui.present('metodo', () => <MethodForm api={api} />);
    if (metodo !== 'clave_permanente') return 'El usuario se identifica con ' + metodo + '.';
  }`
    : '';
  return workflow(
    WORKFLOW_ID,
    `  const INFO_URL = '${INFO_URL}';
  const procedure = await api.procedures.getOrCreate({
    id: 'vida-laboral',
    title: 'Vida laboral',
    status: 'in_progress',
    administration: { level: 'state', name: 'Tesorería General de la Seguridad Social' },
    summary: 'Voy a sacar tu informe de vida laboral de la sede de la Seguridad Social.',
    steps: ${STEPS}.map((s, i) => ({ ...s, status: i === 0 ? 'current' : 'pending' })),
    sources: [{ title: 'Informe de tu vida laboral. Seguridad Social', url: INFO_URL }],
  });${ask}
  await api.state.memo('research', () => api.search({ prompt: '${RESEARCH_QUERY}', mode: 'fast' }));
  const page = await api.browser.currentPage();
  await page.goto(INFO_URL);
  await ${button('Rechazar todas')}.click();${options.wander ? WANDER_BEFORE : ''}
  await ${button('Consultar vida laboral')}.click();
  await ${button('Continuar')}.click();
  await ${button('Acceder a Cl@ve Permanente')}.click();
  // The app types into the fields as they are: wait for the form first.
  await page.getByRole('textbox', { name: 'Contraseña' }).waitFor();
  await page.loginClave({
    username: page.getByRole('textbox', { name: 'DNI o NIE' }),
    password: page.getByRole('textbox', { name: 'Contraseña' }),
    message: 'La necesito para entrar en la Seguridad Social por ti.',
  });
  const logged = await page.waitForText('Descargar vida laboral', { timeout: 30000 });
  return 'URL: ' + logged.url + '\\nTitle: ' + logged.title + '\\n\\n' + logged.snapshot;`,
    {
      title: 'Sacar tu vida laboral',
      ...(options.askMethod ? { components: METHOD_FORM } : {}),
    },
  );
}

/** Opens the logged-in page again (a run that carries on later): the login must still hold. */
const REOPEN = `
  await page.goto('${VIDA_LABORAL_URL}');
  await page.waitForText('Descargar vida laboral', { timeout: 30000 });`;

/**
 * The second run: from the logged-in page to the report in the user's documents. `reopen`: the
 * page is opened again first (the app was restarted in between).
 */
export function fromDownload(
  options: Pick<AgentOptions, 'readReport' | 'wander'> & { reopen?: boolean } = {},
) {
  return workflow(
    WORKFLOW_ID,
    `  const procedure = await api.procedures.getOrCreate({ id: 'vida-laboral', title: 'Vida laboral' });
  const page = await api.browser.currentPage();${options.reopen ? REOPEN : ''}${options.wander ? WANDER_AFTER : ''}
  const clicked = await ${button('Descargar vida laboral')}.click();
  let downloads = clicked.downloads;
  for (let i = 0; i < 40 && downloads.length === 0; i++) {
    await page.waitForTimeout(500);
    downloads = await page.downloads();
  }
  if (downloads.length === 0) throw new Error('No ha llegado el informe.');
  const saved = await api.documents.saveDownload(downloads[0].downloadId, 'Informe de vida laboral');${
    options.readReport
      ? `
  const report = await api.documents.read(saved.documentId);`
      : ''
  }
  await procedure.update({
    status: 'done',
    summary: 'Tu informe de vida laboral está guardado en tus documentos.',
    steps: ${STEPS}.map((s) => ({ ...s, status: 'done' })),
    nextAction: null,
  });
  return '${SAVED} ' + saved.documentId${options.readReport ? " + '\\n\\n' + report.text" : ''};`,
    { title: 'Sacar tu vida laboral' },
  );
}

/** What the agent says last: its report to the coordinator. */
export const REPORT_TEXT = 'Hecho: el informe de vida laboral está guardado en tus documentos.';

/** The stages until the logged-in page shows. */
export function stagesUntilLogin(options: AgentOptions = {}): Stage[] {
  return [{ id: 'login', call: untilLogin(options) }];
}

/** The stages from the logged-in page to the report. */
export function stagesFromDownload(
  options: Pick<AgentOptions, 'readReport' | 'wander'> = {},
): Stage[] {
  return [
    { id: 'download', call: fromDownload(options) },
    { id: 'report', text: REPORT_TEXT },
  ];
}

/** The whole way, from the card to the report. */
export function agentStages(options: AgentOptions = {}): Stage[] {
  return [...stagesUntilLogin(options), ...stagesFromDownload(options)];
}
