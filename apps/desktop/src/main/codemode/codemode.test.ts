/**
 * The codemode harness in main, through the real composition root (`createHeadlessApp`) with the
 * fake agent processes of the main-process tests: the bridge calls are made here exactly as an
 * agent host makes them (bearer token, `x-sa-procedure` header), and what the renderer and the
 * agents receive is checked. The host side is tested in @sa/agent (codemode-*.test.ts).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_REPORT_PREFIX, RESULT_CHARS, RUN_RESULT_PREFIX } from '@sa/agent';
import {
  ASSISTANT_AGENT_ID,
  PROCEDURE_HEADER,
  type SaEvent,
  UI_FAILED,
  type UiNode,
} from '@sa/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHeadlessApp, type HeadlessApp } from '../app/headless';
import { createFakeAgentLib, type FakeAgentClient, FakeBrowser } from '../testing/fakes';
import { procedureIdFor } from './handlers';

let root: string;
let apps: HeadlessApp[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sa-codemode-'));
  apps = [];
});

afterEach(async () => {
  for (const app of apps) await app.close();
  await rm(root, { recursive: true, force: true });
});

async function open(options: { userData?: string; clock?: () => Date } = {}) {
  const hostScript = join(root, 'host.js');
  await writeFile(hostScript, '');
  const agentLib = createFakeAgentLib();
  const browser = new FakeBrowser();
  const app = await createHeadlessApp({
    userDataDir: options.userData ?? join(root, 'userData'),
    tmpRoot: join(root, 'os-tmp'),
    agentLib,
    browserFactory: () => browser,
    hostScript,
    ...(options.clock ? { clock: options.clock } : {}),
    places: {
      place: async (address: string) =>
        address.includes('Nowhere') ? undefined : { latitude: 40.4, longitude: -3.7 },
      home: async () => null,
    },
  });
  apps.push(app);
  const set = await app.invoke('providers.setCustom', {
    baseUrl: 'http://127.0.0.1:18789/v1',
    api: 'openai-completions',
    model: 'mock-model',
  });
  expect(set.ok).toBe(true);
  const events: SaEvent[] = [];
  app.on((e) => events.push(e));
  return { app, agentLib, browser, events };
}

// biome-ignore lint/suspicious/noExplicitAny: the tests read results of many methods by path
type Call = { ok: boolean; result?: any; error?: { code: string; message: string } };

/** One bridge call as an agent host makes it. */
async function call(
  app: HeadlessApp,
  token: string,
  method: string,
  params: unknown,
  procedureId?: string,
): Promise<Call> {
  const res = await fetch(`${app.services.bridge.url()}/rpc/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(procedureId ? { [PROCEDURE_HEADER]: procedureId } : {}),
    },
    body: JSON.stringify(params),
  });
  return (await res.json()) as Call;
}

const FORM: UiNode = {
  type: 'Root',
  props: {},
  children: [
    {
      type: 'Form',
      props: { title: '¿Cuánto ganaste en 2026?' },
      children: [
        {
          type: 'TextField',
          props: { label: 'Ingresos', value: '', onChange: { $handler: 'r.0:Income/0#onChange' } },
          children: [],
        },
        {
          type: 'Button',
          props: { type: 'primary', onClick: { $handler: 'r.0:Income/1#onClick' } },
          children: ['Seguir'],
        },
      ],
    },
  ],
};

/** Every message an agent got (a prompt when idle, a follow-up or steer while running). */
function received(client: FakeAgentClient | undefined): string[] {
  return client
    ? [...client.prompts.map((p) => p.text), ...client.followUps, ...client.steers]
    : [];
}

/** A token for an agent whose process already started (starting one issues a new token). */
async function tokenFor(
  app: HeadlessApp,
  agentLib: ReturnType<typeof createFakeAgentLib>,
  agentId: string,
): Promise<string> {
  await vi.waitFor(() => expect(clientOf(agentLib, agentId)?.started).toBe(true));
  return app.services.tokens.issue(agentId);
}

/** An agent the coordinator started (only agents run modules), and a token for it. */
async function anAgent(
  app: HeadlessApp,
  agentLib: ReturnType<typeof createFakeAgentLib>,
): Promise<{ agentId: string; token: string }> {
  const { result } = await call(
    app,
    app.services.tokens.issue(ASSISTANT_AGENT_ID),
    'agents.start',
    { status: 'Renta', brief: 'b' },
  );
  const agentId = result.agentId as string;
  return { agentId, token: await tokenFor(app, agentLib, agentId) };
}

function clientOf(
  agentLib: ReturnType<typeof createFakeAgentLib>,
  agentId: string,
): FakeAgentClient | undefined {
  return [...agentLib.clients]
    .reverse()
    .find((c) => JSON.parse(c.launch.env.SA_AGENT_CONFIG ?? '{}').procedureId === agentId);
}

describe('the coordinator', () => {
  it('runs as the codemode orchestrator, in its own session, reading the procedures with the message', async () => {
    const { app, agentLib } = await open();
    await app.invoke('chat.send', { text: '¿Tengo que hacer la renta?' });
    await vi.waitFor(() => expect(clientOf(agentLib, ASSISTANT_AGENT_ID)?.prompts.length).toBe(1));
    const config = JSON.parse(
      clientOf(agentLib, ASSISTANT_AGENT_ID)?.launch.env.SA_AGENT_CONFIG ?? '{}',
    );
    expect(config.role).toBe('orchestrator');
    // Version 2 of the chat's agent: the same chat, a fresh model context.
    expect(config.sessionFile).toMatch(/assistant[\\/]session-v2\.jsonl$/);
    expect(clientOf(agentLib, ASSISTANT_AGENT_ID)?.prompts[0]?.text).toBe(
      '[Procedures: none yet]\n\n¿Tengo que hacer la renta?',
    );
  });
});

describe('a run', () => {
  it('creates its procedure by key, shows an interface, gets the user’s answer and hands the result to its agent', async () => {
    const { app, agentLib, events } = await open();
    const { agentId, token } = await anAgent(app, agentLib);

    const begin = await call(app, token, 'run.begin', {
      title: 'Renta',
      source: 'src',
    });
    expect(begin).toMatchObject({ ok: true, result: { state: { memo: {}, ui: {} } } });
    const runId = begin.result.runId as string;

    const created = await call(app, token, 'procs.getOrCreate', {
      id: 'obligatoriedad-renta',
      title: 'Obligación de declarar la renta',
      status: 'researching',
    });
    expect(created).toMatchObject({
      ok: true,
      result: { created: true, version: 1, status: 'researching' },
    });
    const procedureId = created.result.id as string;
    const again = await call(app, token, 'procs.getOrCreate', {
      id: 'obligatoriedad-renta',
      title: 'Otro',
    });
    expect(again.result).toMatchObject({
      id: procedureId,
      created: false,
      title: 'Obligación de declarar la renta',
    });

    expect(
      (
        await call(app, token, 'run.memo', {
          runId,
          key: 'income-search',
          value: { umbral: 22000 },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await call(app, token, 'run.ui', {
          runId,
          action: 'open',
          key: 'income',
          rev: 1,
          tree: FORM,
        })
      ).ok,
    ).toBe(true);

    const state = await app.invoke('codemode.state');
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ id: runId, status: 'waiting_user', attached: true });
    // The agent worked on the procedure it created; the renderer is not told (questions are not
    // tied to procedures).
    expect(app.services.codemode?.directory.get(agentId)?.procedures).toEqual([procedureId]);
    expect(state.runs[0]).not.toHaveProperty('procedures');
    expect(state.runs[0]?.ui[0]).toMatchObject({ key: 'income', rev: 1, tree: FORM });
    expect(events.some((e) => e.type === 'codemode.run' && e.run.ui.length === 1)).toBe(true);

    // The host polls; the user types and clicks in the meantime.
    const poll = call(app, token, 'run.events', { runId, after: 0 });
    expect(
      await app.invoke('codemode.uiEvent', runId, 'income', {
        handler: 'r.0:Income/0#onChange',
        rev: 1,
        value: '21000',
      }),
    ).toBe(true);
    const polled = await poll;
    expect(polled.result.events).toEqual([
      {
        seq: 1,
        key: 'income',
        event: { handler: 'r.0:Income/0#onChange', rev: 1, value: '21000' },
      },
    ]);

    expect(
      (
        await call(app, token, 'run.ui', {
          runId,
          action: 'durable',
          key: 'income',
          name: 'income',
          value: '21000',
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await call(app, token, 'run.ui', {
          runId,
          action: 'close',
          key: 'income',
          result: { income: 21000 },
        })
      ).ok,
    ).toBe(true);
    const update = await call(app, token, 'procs.update', {
      id: procedureId,
      expectedVersion: 1,
      patch: { status: 'done', summary: 'No estás obligado.' },
    });
    expect(update.result).toMatchObject({ version: 2, status: 'done' });

    const followUps = () => received(clientOf(agentLib, agentId));
    expect(
      (
        await call(app, token, 'run.end', {
          runId,
          outcome: { status: 'succeeded', value: '"no-exempt"' },
          deliver: true,
        })
      ).ok,
    ).toBe(true);
    await vi.waitFor(() =>
      expect(
        followUps().some((t) => t.startsWith(`${RUN_RESULT_PREFIX} ${runId} (Renta) succeeded]`)),
      ).toBe(true),
    );
    expect((await app.invoke('codemode.state')).runs).toEqual([]);

    // The agent's next run gets its state: the memoized value and the closed interface's answer.
    const rerun = await call(app, token, 'run.begin', { source: 'src v2' });
    expect(rerun.result).toMatchObject({
      state: {
        memo: { 'income-search': { value: { umbral: 22000 } } },
        ui: { income: { status: 'closed', result: { income: 21000 } } },
      },
    });
  });

  it('refuses an update made from an old version (optimistic concurrency)', async () => {
    const { app, agentLib } = await open();
    const { token } = await anAgent(app, agentLib);
    await call(app, token, 'run.begin', { source: 's' });
    const created = await call(app, token, 'procs.getOrCreate', {
      id: 'dni',
      title: 'Renovar el DNI',
    });
    app.services.procedures.rename(created.result.id, 'Renovar mi DNI');
    const stale = await call(app, token, 'procs.update', {
      id: created.result.id,
      expectedVersion: created.result.version,
      patch: { status: 'planned' },
    });
    expect(stale.error?.code).toBe('conflict');
    expect(stale.error?.message).toMatch(/changed since you read it/);
  });

  it('validates interfaces before the renderer sees them and locates every map address', async () => {
    const { app, agentLib } = await open();
    const { token } = await anAgent(app, agentLib);
    const { result } = await call(app, token, 'run.begin', { source: 's' });
    const bad = await call(app, token, 'run.ui', {
      runId: result.runId,
      action: 'open',
      key: 'x',
      rev: 1,
      tree: { type: 'Root', props: {}, children: [{ type: 'Script', props: {}, children: [] }] },
    });
    expect(bad.error).toMatchObject({ code: 'bad_request' });
    expect(bad.error?.message).toMatch(/unknown component "Script"/);
    const map = (address: string): UiNode => ({
      type: 'Root',
      props: {},
      children: [
        {
          type: 'Map',
          props: { options: [{ value: 'a', label: 'Comisaría', address }] },
          children: [],
        },
      ],
    });
    const missing = await call(app, token, 'run.ui', {
      runId: result.runId,
      action: 'open',
      key: 'm',
      rev: 1,
      tree: map('Calle Nowhere 1, Nada'),
    });
    expect(missing.error?.message).toMatch(/No matching place in Spain for: Calle Nowhere 1/);
    expect(
      (
        await call(app, token, 'run.ui', {
          runId: result.runId,
          action: 'open',
          key: 'm',
          rev: 1,
          tree: map('Calle Mayor 1, Madrid'),
        })
      ).ok,
    ).toBe(true);
    expect(
      await app.invoke('codemode.pins', result.runId, 'm', [
        'Calle Mayor 1, Madrid',
        'Calle Falsa 2',
      ]),
    ).toEqual([{ latitude: 40.4, longitude: -3.7 }, null]);
  });
});

describe('answers for Mis datos', () => {
  const field = (props: Record<string, unknown>): UiNode => ({
    type: 'TextField',
    props: { label: 'Dato', ...props },
    children: [],
  });
  const tree = (...children: UiNode[]): UiNode => ({ type: 'Root', props: {}, children });

  it('are saved by the app when the interface closes: fields with a vaultKey, unless flagged', async () => {
    const { app, agentLib } = await open();
    const { agentId, token } = await anAgent(app, agentLib);
    await app.invoke('vault.setPersonal', [{ key: 'phone', value: '+34 600 000 000' }]);
    const { result } = await call(app, token, 'run.begin', { source: 's' });
    const runId = result.runId as string;
    const ui = (action: string, extra: Record<string, unknown>) =>
      call(app, token, 'run.ui', { runId, action, key: 'datos', ...extra });
    expect((await ui('open', { rev: 1, tree: tree(field({ value: '' })) })).ok).toBe(true);
    // The last tree is what the user answered.
    await ui('render', {
      rev: 2,
      tree: tree(
        field({ vaultKey: 'email', value: ' lucia@example.es ' }),
        field({ vaultKey: 'phone', value: '+34 600 000 000' }),
        field({ vaultKey: 'givenName', value: 'Lu', error: 'Escribe tu nombre completo.' }),
        field({
          vaultKey: 'custom.referencia_catastral',
          label: 'Referencia catastral',
          value: '9872023VH5797S0001WX',
        }),
        field({ value: 'sin vaultKey' }),
      ),
    });
    await vi.waitFor(() =>
      expect(app.services.codemode.runs.stateOf(agentId).ui.datos?.rev).toBe(2),
    );
    expect((await ui('close', { result: { ok: true } })).ok).toBe(true);

    const personal = (key: string) =>
      app.services.vault.overview().personal.find((p) => p.key === key);
    expect(personal('email')).toMatchObject({
      value: 'lucia@example.es',
      source: 'form',
    });
    expect(personal('custom.referencia_catastral')).toMatchObject({
      label: 'Referencia catastral',
      value: '9872023VH5797S0001WX',
    });
    // Flagged as wrong by the module: not saved. Already saved: left as it was.
    expect(personal('givenName')).toBeUndefined();
    expect(personal('phone')).toMatchObject({ source: 'manual' });
    expect(app.services.conversation.transcript().at(-1)).toMatchObject({
      type: 'notice',
      text: 'Guardado en Mis datos: Correo electrónico, Referencia catastral.',
    });
  });

  it('save Spanish dates as ISO, and tell the agent which answers the vault refused', async () => {
    const { app, agentLib } = await open();
    const { token } = await anAgent(app, agentLib);
    const { result } = await call(app, token, 'run.begin', { source: 's' });
    const ui = (action: string, extra: Record<string, unknown>) =>
      call(app, token, 'run.ui', { runId: result.runId, action, key: 'datos', ...extra });
    const answers = tree(
      field({ vaultKey: 'dniExpiry', value: '04/12/2026' }),
      field({ vaultKey: 'passportExpiry', value: '31/02/2026' }),
    );
    expect((await ui('open', { rev: 1, tree: answers })).ok).toBe(true);
    const closed = await ui('close', { result: null });
    expect(closed.result).toEqual({
      note: expect.stringContaining('passportExpiry (invalid_date)'),
    });
    expect(closed.result?.note).not.toContain('31/02/2026');
    const personal = (key: string) =>
      app.services.vault.overview().personal.find((p) => p.key === key);
    expect(personal('dniExpiry')).toMatchObject({ value: '2026-12-04', source: 'form' });
    expect(personal('passportExpiry')).toBeUndefined();
  });

  it('may not name what agents never see (the CAN, PINs)', async () => {
    const { app, agentLib } = await open();
    const { token } = await anAgent(app, agentLib);
    const { result } = await call(app, token, 'run.begin', { source: 's' });
    for (const vaultKey of ['dniAccessNumber', 'custom.pin_tarjeta']) {
      const refused = await call(app, token, 'run.ui', {
        runId: result.runId,
        action: 'open',
        key: 'x',
        rev: 1,
        tree: tree(field({ vaultKey, value: '' })),
      });
      expect(refused.error?.message).toMatch(/vaultKey is not available to agents/);
    }
  });
});

describe('procedure keys', () => {
  it('name the same procedure on every run of an agent; full ids pass through', () => {
    const id = procedureIdFor('a_1', 'obligatoriedad-renta');
    expect(id).toMatch(/^p_[a-f0-9]{16}$/);
    expect(procedureIdFor('a_1', 'obligatoriedad-renta')).toBe(id);
    expect(procedureIdFor('a_2', 'obligatoriedad-renta')).not.toBe(id);
    expect(procedureIdFor('a_2', id)).toBe(id);
  });

  it('name the same card in every run of the agent, which procedures.get takes too', async () => {
    const { app, agentLib } = await open();
    const { token } = await anAgent(app, agentLib);
    expect((await call(app, token, 'run.begin', { source: 's' })).result.procedures).toEqual([]);
    const made = await call(app, token, 'procs.getOrCreate', { id: 'contrato', title: 'Contrato' });
    // The next run starts with the card as its default procedure (documents, prompts), and the
    // key gives the same card, not a second one.
    const second = await call(app, token, 'run.begin', { source: 's' });
    expect(second.result.procedures).toEqual([made.result.id]);
    const again = await call(app, token, 'procs.getOrCreate', { id: 'contrato', title: 'Otro' });
    expect(again.result).toMatchObject({ id: made.result.id, created: false, title: 'Contrato' });
    expect(app.services.procedures.list()).toHaveLength(1);
    expect((await call(app, token, 'procs.get', { id: 'contrato' })).result).toMatchObject({
      id: made.result.id,
      title: 'Contrato',
    });
    expect((await call(app, token, 'procs.get', { id: made.result.id })).ok).toBe(true);
    const missing = await call(app, token, 'procs.get', { id: 'otro' });
    expect(missing.error?.code).toBe('not_found');
    expect(missing.error?.message).toMatch(
      /^No procedure of yours with the key "otro" \(p_[a-f0-9]{16}\)\. api\.procedures\.getOrCreate\(\{ id: "otro", title \}\) creates it/,
    );
  });
});

describe('roles', () => {
  it('lets the coordinator only delegate, and agents only act on procedures they name', async () => {
    const { app, agentLib } = await open();
    const orchestrator = app.services.tokens.issue(ASSISTANT_AGENT_ID);
    // No runs, interfaces, vault, approvals or browser: agents and the cards only.
    for (const [method, params] of [
      ['run.begin', { source: 's' }],
      ['vault.read', {}],
      ['prompt.confirm', { title: 'T', message: 'M' }],
      ['browser.snapshot', {}],
    ] as const)
      expect((await call(app, orchestrator, method, params)).error?.code).toBe('policy_denied');
    expect((await call(app, orchestrator, 'agents.list', {})).ok).toBe(true);
    expect((await call(app, orchestrator, 'procs.list', {})).ok).toBe(true);

    const started = await call(app, orchestrator, 'agents.start', {
      status: 'DNI',
      brief: 'Renueva el DNI',
    });
    const agentId = started.result.agentId as string;
    expect(agentId).toMatch(/^a_[a-f0-9]{16}$/);
    const agent = await tokenFor(app, agentLib, agentId);
    // The agent creates the card once it knows the procedure.
    await call(app, agent, 'run.begin', { source: 's' });
    const p = await call(app, agent, 'procs.getOrCreate', { id: 'k', title: 'T' });
    expect((await call(app, orchestrator, 'procs.get', { id: p.result.id })).ok).toBe(true);
    expect((await call(app, agent, 'browser.snapshot', {})).error?.message).toMatch(
      /needs a procedure/,
    );
    expect((await call(app, agent, 'browser.snapshot', {}, 'p_0000000000000000')).error?.code).toBe(
      'not_found',
    );
    expect((await call(app, agent, 'browser.snapshot', {}, p.result.id)).ok).toBe(true);
    expect((await call(app, agent, 'agents.start', { status: 'x', brief: 'y' })).error?.code).toBe(
      'policy_denied',
    );
    // A procedure is not an agent: a token for its id reaches nothing.
    const procedureToken = app.services.tokens.issue(p.result.id);
    expect((await call(app, procedureToken, 'procs.list', {})).error?.code).toBe('unauthorized');
  });
});

describe('agents', () => {
  it('start with the brief and the cards, and report to the coordinator when a run ends', async () => {
    const { app, agentLib } = await open();
    const orchestrator = app.services.tokens.issue(ASSISTANT_AGENT_ID);
    const started = await call(app, orchestrator, 'agents.start', {
      status: 'Empadronamiento',
      brief: 'Empadrónate en Madrid',
    });
    const agentId = started.result.agentId as string;
    await vi.waitFor(() => expect(clientOf(agentLib, agentId)?.prompts.length).toBe(1));
    const client = clientOf(agentLib, agentId);
    expect(JSON.parse(client?.launch.env.SA_AGENT_CONFIG ?? '{}').role).toBe('agent');
    expect(client?.prompts[0]?.text).toBe(
      '[Procedures: none yet]\n\n[Brief from the coordinator]\nEmpadrónate en Madrid',
    );
    expect((await app.invoke('codemode.state')).agents[0]).toMatchObject({
      id: agentId,
      kind: 'agent',
      status: 'Empadronamiento',
      activity: 'working',
    });

    // An assistant client exists to receive the report.
    await app.invoke('chat.send', { text: 'hola' });
    client?.emit({ type: 'run_start' });
    client?.emit({ type: 'assistant_start', messageId: 'm1' });
    client?.emit({ type: 'assistant_end', messageId: 'm1', text: 'Cita reservada el 12/11.' });
    client?.emit({ type: 'run_end' });
    await vi.waitFor(() =>
      expect(
        received(clientOf(agentLib, ASSISTANT_AGENT_ID)).some(
          (t) =>
            t.startsWith(`${AGENT_REPORT_PREFIX} ${agentId} "Empadronamiento"`) &&
            t.includes('Cita reservada el 12/11.'),
        ),
      ).toBe(true),
    );
    expect((await app.invoke('codemode.state')).agents[0]?.activity).toBe('idle');
  });

  it('wait for the user while a question they asked is open, then work again with a new timer', async () => {
    const { app, agentLib } = await open();
    const orchestrator = app.services.tokens.issue(ASSISTANT_AGENT_ID);
    const { result } = await call(app, orchestrator, 'agents.start', {
      status: 'Presentando la solicitud…',
      brief: 'Pídeme el voto por correo',
    });
    const agentId = result.agentId as string;
    const token = await tokenFor(app, agentLib, agentId);
    const agent = async () =>
      (await app.invoke('codemode.state')).agents.find((a) => a.id === agentId);
    await call(app, token, 'run.begin', { source: 's' });
    const card = await call(app, token, 'procs.getOrCreate', {
      id: 'voto',
      title: 'Voto por correo',
    });
    const before = (await agent())?.since;
    expect((await agent())?.activity).toBe('working');

    const asked = call(
      app,
      token,
      'prompt.confirm',
      { title: '¿Presentar la solicitud?', message: 'M', confirmKind: 'submission' },
      card.result.id,
    );
    await vi.waitFor(() => expect(app.services.prompts.pendingItems()).toHaveLength(1));
    expect(await agent()).toMatchObject({ activity: 'waiting_user' });
    expect((await agent())?.since).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 5));
    const [pending] = app.services.prompts.pendingItems();
    await app.invoke('chat.respond', pending?.item.id ?? '', { kind: 'confirm', approved: true });
    expect((await asked).ok).toBe(true);
    expect((await agent())?.activity).toBe('working');
    expect((await agent())?.since).toBeDefined();
    expect((await agent())?.since).not.toBe(before);
  });

  it('work while a run goes on after their turn ended, until its result wakes them', async () => {
    const { app, agentLib } = await open();
    const orchestrator = app.services.tokens.issue(ASSISTANT_AGENT_ID);
    const { result } = await call(app, orchestrator, 'agents.start', {
      status: 'Revisando el pago…',
      brief: 'Pide la devolución de la tasa',
    });
    const agentId = result.agentId as string;
    const token = await tokenFor(app, agentLib, agentId);
    const client = clientOf(agentLib, agentId);
    const agent = async () =>
      (await app.invoke('codemode.state')).agents.find((a) => a.id === agentId);
    const seen: string[] = [];
    app.on((e) => {
      if (e.type === 'codemode.agent' && e.agent.id === agentId) seen.push(e.agent.activity);
    });
    client?.emit({ type: 'run_start' });
    const { result: run } = await call(app, token, 'run.begin', { source: 's' });
    const since = (await agent())?.since;
    expect(since).toBeDefined();

    // The codemode call returned "still running": the turn ends, the run works on.
    client?.emit({ type: 'run_end' });
    await vi.waitFor(() =>
      expect(
        received(clientOf(agentLib, ASSISTANT_AGENT_ID)).some((t) =>
          t.startsWith(`${AGENT_REPORT_PREFIX} ${agentId}`),
        ),
      ).toBe(true),
    );
    expect(await agent()).toMatchObject({ activity: 'working', since });

    // Its result wakes the agent: it works on, on the same timer.
    await call(app, token, 'run.end', {
      runId: run.runId,
      outcome: { status: 'succeeded', value: '{}' },
      deliver: true,
    });
    expect(await agent()).toMatchObject({ activity: 'working', since });
    expect(seen).not.toContain('idle');
  });

  it('show the status the agent sets, or the one the coordinator gives when it resumes it', async () => {
    const { app, agentLib } = await open();
    const orchestrator = app.services.tokens.issue(ASSISTANT_AGENT_ID);
    const { result } = await call(app, orchestrator, 'agents.start', {
      status: 'Buscando cómo pedir el voto por correo…',
      brief: 'Pídeme el voto por correo para el 29N',
    });
    const agentId = result.agentId as string;
    const token = await tokenFor(app, agentLib, agentId);
    const status = async () =>
      (await app.invoke('codemode.state')).agents.find((a) => a.id === agentId)?.status;

    expect(
      (await call(app, token, 'run.setStatus', { status: 'Analizando la página de Correos…' }))
        .error,
    ).toBeUndefined();
    expect(await status()).toBe('Analizando la página de Correos…');
    // Only agents set their own status: the coordinator gives it with a message.
    expect((await call(app, orchestrator, 'run.setStatus', { status: 'x' })).error?.code).toBe(
      'policy_denied',
    );

    await call(app, orchestrator, 'agents.message', {
      agentId,
      message: 'Mejor que me lo envíen a Sevilla.',
      status: 'Cambiando la dirección de envío…',
    });
    expect(await status()).toBe('Cambiando la dirección de envío…');
    await call(app, orchestrator, 'agents.message', { agentId, message: 'Gracias.' });
    expect(await status()).toBe('Cambiando la dirección de envío…');
  });
});

describe('resuming', () => {
  it('wakes the agent of a run no process runs when the user acts, and hands it the queued events', async () => {
    const { app, agentLib } = await open();
    const orchestrator = app.services.tokens.issue(ASSISTANT_AGENT_ID);
    const { result: agent } = await call(app, orchestrator, 'agents.start', {
      status: 'DNI',
      brief: 'Renueva el DNI',
    });
    const token = await tokenFor(app, agentLib, agent.agentId);
    const { result } = await call(app, token, 'run.begin', { source: 'src' });
    await call(app, token, 'run.ui', {
      runId: result.runId,
      action: 'open',
      key: 'income',
      rev: 3,
      tree: FORM,
    });
    await call(app, token, 'run.ui', {
      runId: result.runId,
      action: 'durable',
      key: 'income',
      name: 'income',
      value: '100',
    });

    // The agent's process goes away (idle, or the app restarted): the run keeps waiting.
    await app.services.agents.stop(agent.agentId);
    const after = await app.invoke('codemode.state');
    expect(after.runs[0]).toMatchObject({ status: 'waiting_user', attached: false });

    const before = agentLib.clients.filter(
      (c) => c.launch.env.SA_PROCEDURE_ID === agent.agentId,
    ).length;
    expect(
      await app.invoke('codemode.uiEvent', result.runId, 'income', {
        handler: 'r.0:Income/1#onClick',
        rev: 3,
      }),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(
        agentLib.clients.filter((c) => c.launch.env.SA_PROCEDURE_ID === agent.agentId).length,
      ).toBe(before + 1),
    );
    expect(clientOf(agentLib, agent.agentId)?.started).toBe(true);
    // Woken without a message: its host resumes the run by itself.
    expect(clientOf(agentLib, agent.agentId)?.prompts).toEqual([]);

    // Its new host asks what to resume and starts the run again from the state.
    const fresh = await tokenFor(app, agentLib, agent.agentId);
    const resumable = await call(app, fresh, 'run.resumable', {});
    expect(resumable.result.runs).toEqual([{ runId: result.runId, source: 'src', procedures: [] }]);
    const resumed = await call(app, fresh, 'run.begin', { runId: result.runId, source: 'src' });
    expect(resumed.result.runId).toBe(result.runId);
    expect(resumed.result.state.ui.income).toEqual({
      status: 'open',
      durable: { income: '100' },
      rev: 3,
    });
    const polled = await call(app, fresh, 'run.events', {
      runId: resumed.result.runId,
      after: 0,
    });
    expect(polled.result.events).toEqual([
      { seq: 1, key: 'income', event: { handler: 'r.0:Income/1#onClick', rev: 3 } },
    ]);
  });

  it('keeps runs across an app restart: waiting ones stay on screen, running ones are interrupted', async () => {
    const userData = join(root, 'persist');
    const first = await open({ userData });
    const { agentId, token } = await anAgent(first.app, first.agentLib);
    const a = await call(first.app, token, 'run.begin', { source: 's' });
    await call(first.app, token, 'run.ui', {
      runId: a.result.runId,
      action: 'open',
      key: 'q',
      rev: 1,
      tree: FORM,
    });
    const b = await call(first.app, token, 'run.begin', { source: 's' });
    await first.app.close();
    apps = apps.filter((x) => x !== first.app);

    const second = await open({ userData });
    const state = await second.app.invoke('codemode.state');
    expect(state.runs.map((w) => [w.id, w.status, w.ui.length])).toEqual([
      [a.result.runId, 'waiting_user', 1],
    ]);
    expect(second.app.services.codemode?.runs.get(b.result.runId)?.status).toBe('interrupted');
    // Its agent hears about the interrupted one with its next message.
    await call(second.app, second.app.services.tokens.issue(ASSISTANT_AGENT_ID), 'agents.message', {
      agentId,
      message: 'sigue',
    });
    await vi.waitFor(() =>
      expect(
        received(clientOf(second.agentLib, agentId)).some(
          (t) => t.includes(`[Interrupted runs (`) && t.includes(`): ${b.result.runId}]`),
        ),
      ).toBe(true),
    );
    // Told once: the record is gone.
    expect(second.app.services.codemode?.runs.get(b.result.runId)).toBeUndefined();
  });

  it('tells an agent which of its interfaces are still open when a message may answer them', async () => {
    const { app, agentLib } = await open();
    const { agentId, token } = await anAgent(app, agentLib);
    const a = await call(app, token, 'run.begin', { source: 's' });
    await call(app, token, 'run.ui', {
      runId: a.result.runId,
      action: 'open',
      key: 'numero',
      rev: 1,
      tree: FORM,
    });
    const other = await call(app, token, 'run.begin', { source: 's' });
    await call(app, app.services.tokens.issue(ASSISTANT_AGENT_ID), 'agents.message', {
      agentId,
      message: 'El número está en el PDF adjunto',
    });
    await vi.waitFor(() =>
      expect(
        received(clientOf(agentLib, agentId)).find((t) => t.includes('El número está en el PDF')),
      ).toContain(
        `[Your interfaces the user still sees (if this message answers one or makes it obsolete, cancel its run with api.runs.cancel and continue with the answer): ${a.result.runId}: "numero"]`,
      ),
    );
    const message = received(clientOf(agentLib, agentId)).find((t) => t.includes('PDF adjunto'));
    expect(message).not.toContain(other.result.runId);
  });
});

describe('stale runs (found by the protocol model checker)', () => {
  it('ends a run that stopped reaching main: a running one is interrupted and its agent told', async () => {
    let now = Date.parse('2026-11-08T10:00:00Z');
    const { app, agentLib } = await open({ clock: () => new Date(now) });
    const { result: agent } = await call(
      app,
      app.services.tokens.issue(ASSISTANT_AGENT_ID),
      'agents.start',
      { status: 'DNI', brief: 'b' },
    );
    const token = await tokenFor(app, agentLib, agent.agentId);
    const { result } = await call(app, token, 'run.begin', {
      title: 'Buscar cita',
      source: 's',
    });
    now += 60_000;
    app.services.codemode?.runs.sweep();
    expect(app.services.codemode?.runs.get(result.runId)?.status).toBe('running');
    now += 30_000;
    app.services.codemode?.runs.sweep();
    // Told now, so its record goes (nothing to note later).
    expect(app.services.codemode?.runs.get(result.runId)).toBeUndefined();
    await vi.waitFor(() =>
      expect(
        received(clientOf(agentLib, agent.agentId)).some((t) =>
          t.startsWith(`${RUN_RESULT_PREFIX} ${result.runId} (Buscar cita) interrupted]`),
        ),
      ).toBe(true),
    );
    // Its host, if it was still there, hears that the run is gone and stops it.
    expect(
      (await call(app, token, 'run.events', { runId: result.runId, after: 0 })).error?.code,
    ).toBe('not_found');
  });

  it('keeps a waiting run on screen and hands what the user did to the one that resumes it', async () => {
    let now = Date.parse('2026-11-08T10:00:00Z');
    const { app, agentLib } = await open({ clock: () => new Date(now) });
    const { agentId, token } = await anAgent(app, agentLib);
    const begun = await call(app, token, 'run.begin', { source: 's' });
    expect(begun.error).toBeUndefined();
    const { result } = begun;
    await call(app, token, 'run.ui', {
      runId: result.runId,
      action: 'open',
      key: 'income',
      rev: 1,
      tree: FORM,
    });
    expect(
      await app.invoke('codemode.uiEvent', result.runId, 'income', {
        handler: 'r.0:Income/1#onClick',
        rev: 1,
      }),
    ).toBe(true);
    now += 120_000;
    app.services.codemode?.runs.sweep();
    expect((await app.invoke('codemode.state')).runs[0]).toMatchObject({
      id: result.runId,
      status: 'waiting_user',
      attached: false,
    });
    // What the user did wakes its agent, whose host resumes it.
    const fresh = await tokenFor(app, agentLib, agentId);
    expect(
      (await call(app, fresh, 'run.resumable', {})).result.runs.map(
        (r: { runId: string }) => r.runId,
      ),
    ).toEqual([result.runId]);
    const resumed = await call(app, fresh, 'run.begin', { runId: result.runId, source: 's' });
    const polled = await call(app, fresh, 'run.events', {
      runId: resumed.result.runId,
      after: 0,
    });
    expect(polled.result.events).toEqual([
      { seq: 1, key: 'income', event: { handler: 'r.0:Income/1#onClick', rev: 1 } },
    ]);
  });

  it('never ends a run whose host is polling, however long it waits', async () => {
    let now = Date.parse('2026-11-08T10:00:00Z');
    const { app, agentLib } = await open({ clock: () => new Date(now) });
    const { token } = await anAgent(app, agentLib);
    const { result } = await call(app, token, 'run.begin', { source: 's' });
    const poll = call(app, token, 'run.events', { runId: result.runId, after: 0 });
    // Until the poll reaches main.
    await new Promise((r) => setTimeout(r, 150));
    now += 10 * 60_000;
    app.services.codemode?.runs.sweep();
    expect(app.services.codemode?.runs.get(result.runId)?.status).toBe('running');
    await app.services.codemode?.runs.cancel(result.runId);
    expect((await poll).result).toEqual({ events: [], ended: true });
  });
});

describe('what an agent may keep', () => {
  it('refuses values nested too deeply to resume, and records too large to load', async () => {
    const { app, agentLib } = await open();
    const { agentId, token } = await anAgent(app, agentLib);
    const { result } = await call(app, token, 'run.begin', { source: 's' });
    const runId = result.runId;

    let deep: unknown = 'x';
    for (let i = 0; i < 100; i++) deep = [deep];
    const nested = await call(app, token, 'run.memo', { runId, key: 'deep', value: deep });
    expect(nested.error).toMatchObject({ code: 'bad_request' });
    expect(nested.error?.message).toMatch(/nests deeper than 64/);

    // Each request stays under the bridge's 1 MB; together they would pass 8 MB.
    const chunk = 'x'.repeat(900_000);
    const keys = Array.from({ length: 9 }, (_, i) => `k${i}`);
    for (const key of keys)
      expect((await call(app, token, 'run.memo', { runId, key, value: chunk })).ok).toBe(true);
    const full = await call(app, token, 'run.memo', { runId, key: 'more', value: chunk });
    expect(full.error?.message).toMatch(/would keep too much/);
    // The refused value is not kept; the others are.
    expect(Object.keys(app.services.codemode?.runs.stateOf(agentId).memo ?? {})).toEqual(keys);
  });

  it('keeps at most 20 interfaces open at once', async () => {
    const { app, agentLib } = await open();
    const { token } = await anAgent(app, agentLib);
    const { result } = await call(app, token, 'run.begin', { source: 's' });
    const present = (key: string) =>
      call(app, token, 'run.ui', {
        runId: result.runId,
        action: 'open',
        key,
        rev: 1,
        tree: FORM,
      });
    for (let i = 0; i < 20; i++) expect((await present(`k${i}`)).ok).toBe(true);
    expect((await present('k20')).error?.message).toMatch(/have 20 interfaces open/);
    // An open one may still be shown again.
    expect((await present('k3')).ok).toBe(true);
  });
});

describe('an interface the app could not draw', () => {
  const detail = '<Appointment label="Cita"> in CitaForm (RangeError: Invalid time value)';

  it('leaves the screen, and its run hears it as a refusal of the interface', async () => {
    const { app, agentLib } = await open();
    const { token } = await anAgent(app, agentLib);
    const { result } = await call(app, token, 'run.begin', { source: 's' });
    await call(app, token, 'run.ui', {
      runId: result.runId,
      action: 'open',
      key: 'cita',
      rev: 2,
      tree: FORM,
    });

    // A newer tree may draw: a report about another one changes nothing.
    expect(await app.invoke('codemode.uiFailed', result.runId, 'cita', 1, detail)).toBe(false);
    expect(await app.invoke('codemode.uiFailed', result.runId, 'cita', 2, detail)).toBe(true);
    expect((await app.invoke('codemode.state')).runs[0]?.ui ?? []).toEqual([]);
    expect(app.services.codemode?.runs.get(result.runId)?.status).toBe('running');
    const polled = await call(app, token, 'run.events', { runId: result.runId, after: 0 });
    expect(polled.result.events).toEqual([
      {
        seq: 1,
        key: 'cita',
        event: {
          handler: UI_FAILED,
          rev: 2,
          value: `The interface "cita" could not be shown: the app failed to draw ${detail}. Change what you pass to it and present it again.`,
        },
      },
    ]);
  });

  it('wakes the agent when no process runs it, to present it again', async () => {
    const { app, agentLib } = await open();
    const { result: agent } = await call(
      app,
      app.services.tokens.issue(ASSISTANT_AGENT_ID),
      'agents.start',
      { status: 'DNI', brief: 'b' },
    );
    const token = await tokenFor(app, agentLib, agent.agentId);
    const { result } = await call(app, token, 'run.begin', { source: 's' });
    await call(app, token, 'run.ui', {
      runId: result.runId,
      action: 'open',
      key: 'cita',
      rev: 1,
      tree: FORM,
    });
    await app.services.agents.stop(agent.agentId);
    const clients = () =>
      agentLib.clients.filter((c) => c.launch.env.SA_PROCEDURE_ID === agent.agentId).length;
    const before = clients();

    expect(await app.invoke('codemode.uiFailed', result.runId, 'cita', 1, detail)).toBe(true);
    // Its host resumes it: the replay presents the interface again and hears what fails then.
    expect(app.services.codemode?.runs.get(result.runId)?.status).toBe('waiting_user');
    await vi.waitFor(() => expect(clients()).toBe(before + 1));
  });
});

describe('a run the user dismisses', () => {
  it('is reported to its agent when its run ends, with the reason', async () => {
    const { app, agentLib } = await open();
    const { result: agent } = await call(
      app,
      app.services.tokens.issue(ASSISTANT_AGENT_ID),
      'agents.start',
      { status: 'DNI', brief: 'b' },
    );
    const token = await tokenFor(app, agentLib, agent.agentId);
    const { result } = await call(app, token, 'run.begin', {
      title: 'Buscar cita',
      source: 's',
    });
    await call(app, token, 'run.ui', {
      runId: result.runId,
      action: 'open',
      key: 'k',
      rev: 1,
      tree: FORM,
    });

    await app.services.codemode?.runs.cancel(result.runId, 'The user dismissed it');
    // Its host hears that the run ended, cancels it and reports the end (the agent's codemode
    // call had returned when the interface opened).
    expect(
      (await call(app, token, 'run.events', { runId: result.runId, after: 0 })).result,
    ).toEqual({ events: [], ended: true });
    const end = await call(app, token, 'run.end', {
      runId: result.runId,
      outcome: { status: 'cancelled', error: 'Cancelled from the app' },
      deliver: true,
    });
    expect(end.ok).toBe(true);
    await vi.waitFor(() =>
      expect(
        received(clientOf(agentLib, agent.agentId)).some((t) =>
          t.startsWith(
            `${RUN_RESULT_PREFIX} ${result.runId} (Buscar cita) cancelled]\nCancelled: The user dismissed it.`,
          ),
        ),
      ).toBe(true),
    );
  });

  it('is reported to its agent at once when no process runs it', async () => {
    let now = Date.parse('2026-11-08T10:00:00Z');
    const { app, agentLib } = await open({ clock: () => new Date(now) });
    const { result: agent } = await call(
      app,
      app.services.tokens.issue(ASSISTANT_AGENT_ID),
      'agents.start',
      { status: 'DNI', brief: 'b' },
    );
    const token = await tokenFor(app, agentLib, agent.agentId);
    const { result } = await call(app, token, 'run.begin', { source: 's' });
    await call(app, token, 'run.ui', {
      runId: result.runId,
      action: 'open',
      key: 'k',
      rev: 1,
      tree: FORM,
    });
    // Its run stops reaching main: the interface waits on screen with no run.
    now += 120_000;
    app.services.codemode?.runs.sweep();
    expect(app.services.codemode?.runs.get(result.runId)?.status).toBe('waiting_user');

    await app.services.codemode?.runs.cancel(result.runId, 'The user dismissed it');
    await vi.waitFor(() =>
      expect(
        received(clientOf(agentLib, agent.agentId)).some((t) =>
          t.startsWith(`${RUN_RESULT_PREFIX} ${result.runId} cancelled]`),
        ),
      ).toBe(true),
    );
  });

  it('is not reported back to an agent that cancelled its own run', async () => {
    const { app, agentLib } = await open();
    const { result: agent } = await call(
      app,
      app.services.tokens.issue(ASSISTANT_AGENT_ID),
      'agents.start',
      { status: 'DNI', brief: 'b' },
    );
    const token = await tokenFor(app, agentLib, agent.agentId);
    const { result } = await call(app, token, 'run.begin', { source: 's' });
    expect((await call(app, token, 'run.cancel', { runId: result.runId })).ok).toBe(true);
    const end = await call(app, token, 'run.end', {
      runId: result.runId,
      outcome: { status: 'cancelled' },
      deliver: true,
    });
    expect(end.ok).toBe(true);
    expect(
      received(clientOf(agentLib, agent.agentId)).some((t) =>
        t.includes(`${result.runId} cancelled]`),
      ),
    ).toBe(false);
  });
});

describe('a run outcome delivered later', () => {
  it('carries the run’s logs, with the notes the user left', async () => {
    const { app, agentLib } = await open();
    const orchestrator = app.services.tokens.issue(ASSISTANT_AGENT_ID);
    const { result: agent } = await call(app, orchestrator, 'agents.start', {
      status: 'DNI',
      brief: 'b',
    });
    const token = await tokenFor(app, agentLib, agent.agentId);
    const { result } = await call(app, token, 'run.begin', { source: 's' });
    await call(app, token, 'run.end', {
      runId: result.runId,
      outcome: {
        status: 'succeeded',
        value: '{"captcha":false}',
        logs: '[user] On "Escribe el código" the user noted: X7K2',
        searches: "Searches main didn't return (read them):\n\n### api.search: q\nModelo 600",
      },
      deliver: true,
    });
    await vi.waitFor(() =>
      expect(received(clientOf(agentLib, agent.agentId))).toContainEqual(
        expect.stringContaining(
          'Result:\n{"captcha":false}\n\nLogs:\n[user] On "Escribe el código" the user noted: X7K2\n\nSearches main didn\'t return (read them):\n\n### api.search: q\nModelo 600',
        ),
      ),
    );
  });

  it('shows the value up to the one result limit, the same as the tool result', async () => {
    const { app, agentLib } = await open();
    const { token } = await anAgent(app, agentLib);
    const { result } = await call(app, token, 'run.begin', { source: 's' });
    // A real run returned { answer, research, feedback } and a 4,000-character clip cut 60% of
    // the research; the host sends at most RESULT_CHARS, and the message shows them all.
    const value = JSON.stringify({ research: 'x'.repeat(RESULT_CHARS - 100) });
    await call(app, token, 'run.end', {
      runId: result.runId,
      outcome: { status: 'succeeded', value },
      deliver: true,
    });
    const agentId = (await app.invoke('codemode.state')).agents[0]?.id ?? '';
    await vi.waitFor(() =>
      expect(received(clientOf(agentLib, agentId)).some((t) => t.includes(value))).toBe(true),
    );
  });
});
