/**
 * A demo profile for the viewer (`corepack pnpm traces --demo`): a real browser capture of the
 * mock sede's cita previa (Playwright tracing, as SA_BROWSER_CAPTURE records it) and the pi
 * sessions of a coordinator and a background agent around it, in the format the agent host
 * writes, whose run traces hold the browser calls. Synthetic people and data only.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startMockSede } from '@sa/mock-sede';
import { chromium, type Page } from 'playwright-core';

type Line = Record<string, unknown>;
interface Op {
  op: string;
  label?: string;
  start: number;
  ms: number;
  error?: string;
}

const AGENT = 'a_d3m0c1t4dn1r3n0v';
const PROCEDURE = 'p_c1t4dn1r3n0v4r0';
const RUN_TRACE = 'spainassist.run_trace';

export async function makeDemo(dir: string): Promise<string> {
  await rm(dir, { recursive: true, force: true });
  const ops: Op[] = [];
  const captureDir = join(dir, 'procedures', PROCEDURE, 'capture');
  const browserStart = Date.now();
  const stamp = new Date(browserStart).toISOString().replace(/[:.]/g, '-');
  await mkdir(join(captureDir, stamp), { recursive: true });

  // --- The browser: the agent's run, step by step, each step one api.browser call. ----------
  const sede = await startMockSede({ publicHost: '127.0.0.1', captchaInCita: false });
  // The app's Chromium (`corepack pnpm --filter @sa/desktop install:chromium`), or another.
  const browser = await chromium.launch({
    executablePath: process.env.SA_BROWSER_EXECUTABLE || chromium.executablePath(),
  });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      locale: 'es-ES',
      viewport: { width: 1280, height: 800 },
    });
    await context.tracing.start({ screenshots: true, snapshots: true, title: PROCEDURE });
    const page = await context.newPage();
    const step = async (op: string, fn: (page: Page) => Promise<unknown>, label?: string) => {
      const start = Date.now();
      try {
        await fn(page);
        ops.push({ op, start, ms: Date.now() - start, ...(label ? { label } : {}) });
      } catch (err) {
        const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
        ops.push({
          op,
          start,
          ms: Date.now() - start,
          error: `browser_error: ${message}`,
          ...(label ? { label } : {}),
        });
      }
      await sleep(120);
    };
    const url = `${sede.url}/tramites/cita/solicitud/oficina`;
    await step('browser.goto', (p) => p.goto(url), url);
    await step('browser.snapshot', (p) => p.locator('body').ariaSnapshot());
    await step('browser.loginClave', async (p) => {
      await p.getByRole('button', { name: 'Acceso Cl@ve Permanente', exact: true }).click();
      await p.getByLabel('DNI o NIE', { exact: false }).fill('99999999R');
      await p.getByLabel('Contraseña', { exact: false }).fill('clave-demo-1234');
      await p.getByRole('button', { name: 'Entrar', exact: true }).click();
      await p.waitForURL(url);
    });
    await step('browser.selectOption', (p) =>
      p.locator('[name="oficina"]').selectOption({ index: 1 }),
    );
    await step('browser.selectOption', (p) =>
      p.locator('[name="servicio"]').selectOption({ index: 1 }),
    );
    await step('browser.click', (p) =>
      p.getByRole('button', { name: 'Continuar', exact: true }).click(),
    );
    await step('browser.snapshot', (p) => p.locator('body').ariaSnapshot());
    // The run shows the free slots to the user and waits for their pick.
    const uiStart = Date.now();
    await sleep(3_500);
    ops.push({ op: 'ui', label: 'elegir-hueco', start: uiStart, ms: Date.now() - uiStart });
    await step('browser.check', (p) => p.locator('input[type="radio"]:enabled').nth(2).check());
    await step('browser.click', (p) =>
      p.getByRole('button', { name: 'Continuar', exact: true }).click(),
    );
    await step('browser.fill', (p) => p.locator('[name="telefono"]').fill('612345678'));
    // A first try at a button that isn't there: the run's module catches it and goes on.
    await step('browser.click', (p) =>
      p.getByRole('button', { name: 'Confirmar', exact: true }).click({ timeout: 1_500 }),
    );
    await step('browser.check', (p) => p.locator('[name="privacidad"]').check());
    await step('browser.click', async (p) => {
      await p.getByRole('button', { name: 'Confirmar cita', exact: true }).click();
      await p.waitForURL(/justificante\//);
    });
    await step('browser.snapshot', (p) => p.locator('body').ariaSnapshot());
    await context.tracing.stop({ path: join(captureDir, stamp, 'trace.zip') });
    await context.close();
  } finally {
    await browser.close();
    await sede.close();
  }
  const browserEnd = Date.now();

  // --- The agents around it. -------------------------------------------------------------------
  // Times before the browser run are backdated: the agent researched first.
  const t = browserStart - 31_400;
  const agent: Line[] = [];
  const coordinator: Line[] = [];
  const session = (lines: Line[], cwd: string) =>
    lines.push({ type: 'session', version: 3, id: cwd, timestamp: iso(t - 600), cwd });
  let n = 0;
  const entry = (lines: Line[], at: number, fields: Line) => {
    const id = (++n).toString(16).padStart(8, '0');
    const parentId = (lines.findLast((l) => l.id) as { id?: string } | undefined)?.id ?? null;
    lines.push({ ...fields, id, parentId, timestamp: iso(at) });
  };
  const user = (lines: Line[], at: number, text: string) =>
    entry(lines, at, {
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text }], timestamp: at },
    });
  const assistant = (
    lines: Line[],
    start: number,
    end: number,
    model: string,
    usage: { input: number; output: number; cacheRead: number; cost: number },
    content: unknown[],
    stopReason = 'stop',
  ) =>
    entry(lines, end, {
      type: 'message',
      message: {
        role: 'assistant',
        content,
        api: 'openai-responses',
        provider: 'openai',
        model,
        usage: {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: 0,
          totalTokens: usage.input + usage.output + usage.cacheRead,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
        },
        stopReason,
        timestamp: start,
      },
    });
  const toolResult = (
    lines: Line[],
    at: number,
    id: string,
    name: string,
    text: string,
    details?: object,
    isError = false,
  ) =>
    entry(lines, at, {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: id,
        toolName: name,
        content: [{ type: 'text', text }],
        details,
        isError,
        timestamp: at,
      },
    });

  // Coordinator: the user asks; it starts the agent.
  const c0 = t - 6_800;
  session(coordinator, 'assistant/work');
  user(
    coordinator,
    c0,
    'Hola, tengo que renovar el DNI. ¿Me pides cita en la comisaría más cercana?',
  );
  assistant(
    coordinator,
    c0 + 40,
    c0 + 2_350,
    'gpt-6-luna',
    { input: 2_310, output: 96, cacheRead: 9_800, cost: 0.0041 },
    [
      {
        type: 'thinking',
        thinking:
          'The user wants an appointment to renew their DNI: start a background agent with their words as its brief.',
      },
      {
        type: 'toolCall',
        id: 'call_c1',
        name: 'agent_start',
        arguments: { brief: 'Renovar el DNI: pedir cita previa en la comisaría más cercana.' },
      },
    ],
    'toolUse',
  );
  toolResult(coordinator, c0 + 2_480, 'call_c1', 'agent_start', `Started agent ${AGENT}.`);
  assistant(
    coordinator,
    c0 + 2_500,
    c0 + 3_900,
    'gpt-6-luna',
    { input: 160, output: 41, cacheRead: 12_100, cost: 0.0012 },
    [
      {
        type: 'text',
        text: 'Perfecto, me pongo con ello: busco los requisitos y te pido cita. Te aviso cuando necesite que elijas el día.',
      },
    ],
  );

  // The agent: research, then the browser.
  session(agent, `agents/${AGENT}/work`);
  user(agent, t, 'Renovar el DNI: pedir cita previa en la comisaría más cercana.');
  assistant(
    agent,
    t + 60,
    t + 4_300,
    'gpt-6.2-sol',
    { input: 14_200, output: 610, cacheRead: 0, cost: 0.0318 },
    [
      {
        type: 'thinking',
        thinking:
          'Research the requirements first (official sources), then create the procedure card.',
      },
      { type: 'text', text: 'Primero miro los requisitos oficiales.' },
      {
        type: 'toolCall',
        id: 'call_a1',
        name: 'codemode',
        arguments: { title: 'Investigar requisitos', procedures: [], source: RESEARCH_SOURCE },
      },
    ],
    'toolUse',
  );
  const r1 = t + 4_340;
  const research: Op[] = [
    { op: 'search', start: r1 + 20, ms: 6_140 },
    {
      op: 'fetchUrl',
      label: 'https://www.dnielectronico.es/PortalDNIe/PRF1_Cons02.action?pag=REF_310',
      start: r1 + 6_180,
      ms: 1_220,
    },
    { op: 'procedures.getOrCreate', start: r1 + 7_420, ms: 38 },
    { op: 'procedures.update', start: r1 + 7_470, ms: 31 },
  ];
  entry(agent, r1 + 7_560, {
    type: 'custom',
    customType: RUN_TRACE,
    data: {
      runId: 'run_1',
      title: 'Investigar requisitos',
      startedAt: r1,
      endedAt: r1 + 7_520,
      status: 'succeeded',
      calls: research,
    },
  });
  toolResult(
    agent,
    r1 + 7_580,
    'call_a1',
    'codemode',
    'Run succeeded.\n\nResult:\n{\n  "requisitos": ["DNI anterior", "Foto reciente (32x26 mm)", "Tasa de 12 €"],\n  "procedure": "p_c1t4dn1r3n0v4r0"\n}',
    { runId: 'run_1', status: 'succeeded' },
  );
  const l2 = r1 + 7_600;
  const r2 = browserStart - 60;
  assistant(
    agent,
    l2,
    r2 - 40,
    'gpt-6.2-sol',
    { input: 1_840, output: 1_230, cacheRead: 14_600, cost: 0.0274 },
    [
      { type: 'text', text: 'Ahora pido la cita en la sede.' },
      {
        type: 'toolCall',
        id: 'call_a2',
        name: 'codemode',
        arguments: { title: 'Pedir cita en la sede', procedures: [PROCEDURE], source: CITA_SOURCE },
      },
    ],
    'toolUse',
  );
  const ui = ops.find((o) => o.op === 'ui')!;
  // The run detached when its interface opened: the call returned, the run went on.
  toolResult(
    agent,
    ui.start + 30,
    'call_a2',
    'codemode',
    'Run run_2 is waiting for the user (interface: elegir-hueco). It keeps running on its own; its result reaches you as a message when it ends.',
    { runId: 'run_2', status: 'detached' },
  );
  entry(agent, browserEnd + 20, {
    type: 'custom',
    customType: RUN_TRACE,
    data: {
      runId: 'run_2',
      title: 'Pedir cita en la sede',
      startedAt: r2,
      endedAt: browserEnd,
      status: 'succeeded',
      calls: ops,
    },
  });
  const report = browserEnd + 60;
  user(
    agent,
    report,
    'Run run_2 ended: succeeded.\nResult: {"localizador":"C-7Q2K9","fecha":"martes 1 de diciembre a las 10:00","oficina":"Oficina de Documentación Centro"}',
  );
  assistant(
    agent,
    report + 40,
    report + 3_100,
    'gpt-6.2-sol',
    { input: 420, output: 380, cacheRead: 16_900, cost: 0.0097 },
    [
      {
        type: 'text',
        text: 'Cita confirmada: martes 1 de diciembre a las 10:00 en la Oficina de Documentación Centro (localizador C-7Q2K9). He actualizado la tarjeta del trámite con lo que hay que llevar.',
      },
    ],
  );

  // The coordinator hears the agent's report and tells the user.
  user(
    coordinator,
    report + 3_300,
    `Agent ${AGENT} finished: cita confirmada el martes 1 de diciembre a las 10:00 (localizador C-7Q2K9).`,
  );
  assistant(
    coordinator,
    report + 3_340,
    report + 5_200,
    'gpt-6-luna',
    { input: 210, output: 88, cacheRead: 12_400, cost: 0.0016 },
    [
      {
        type: 'text',
        text: '¡Listo! Tienes cita el martes 1 de diciembre a las 10:00 en la Oficina de Documentación Centro. Lleva tu DNI actual, una foto reciente y 12 € para la tasa.',
      },
    ],
  );

  const jsonl = (lines: Line[]) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  await mkdir(join(dir, 'assistant'), { recursive: true });
  await mkdir(join(dir, 'agents', AGENT), { recursive: true });
  await writeFile(join(dir, 'assistant', 'session-v2.jsonl'), jsonl(coordinator));
  await writeFile(join(dir, 'agents', AGENT, 'session.jsonl'), jsonl(agent));
  await writeFile(
    join(dir, 'agents', AGENT, 'agent.json'),
    JSON.stringify(
      {
        id: AGENT,
        kind: 'worker',
        status: 'Cita para renovar el DNI',
        brief: 'Renovar el DNI: pedir cita previa.',
        procedures: [PROCEDURE],
        stopped: false,
        createdAt: iso(t),
        updatedAt: iso(report),
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(dir, 'procedures', PROCEDURE, 'procedure.json'),
    JSON.stringify({ id: PROCEDURE, title: 'Renovar el DNI' }, null, 2),
  );
  return dir;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const RESEARCH_SOURCE = `export async function main(api) {
  const found = await api.search({ prompt: 'Requisitos para renovar el DNI en 2026: documentación, tasa y cita previa', mode: 'balanced' });
  const page = await api.fetchUrl('https://www.dnielectronico.es/PortalDNIe/PRF1_Cons02.action?pag=REF_310');
  const p = await api.procedures.getOrCreate({ id: 'renovar-dni', title: 'Renovar el DNI' });
  await api.procedures.update(p.id, {
    status: 'Buscando cita',
    requirements: ['DNI anterior', 'Foto reciente (32x26 mm)', 'Tasa de 12 €'],
  });
  return { requisitos: ['DNI anterior', 'Foto reciente (32x26 mm)', 'Tasa de 12 €'], procedure: p.id };
}`;

const CITA_SOURCE = `export async function main(api) {
  const page = await api.browser.currentPage();
  await page.goto('https://sede.example/tramites/cita/solicitud/oficina');
  await page.snapshot();
  await api.browser.loginClave();
  await page.locator('[name="oficina"]').selectOption({ index: 1 });
  await page.locator('[name="servicio"]').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Continuar' }).click();
  const slots = await page.snapshot();
  const slot = await api.ui.present('elegir-hueco', ({ done }) => <SlotPicker slots={slots} onPick={done} />);
  await page.ref(slot.ref).check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.locator('[name="telefono"]').fill(await api.vault.value('phone'));
  try { await page.getByRole('button', { name: 'Confirmar' }).click(); } catch {}
  await page.locator('[name="privacidad"]').check();
  await page.getByRole('button', { name: 'Confirmar cita' }).click();
  return (await page.snapshot()).snapshot.match(/Localizador: (\\S+)/)?.[1];
}`;
