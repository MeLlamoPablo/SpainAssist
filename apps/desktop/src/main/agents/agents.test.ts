import { join } from 'node:path';
import { AGENT_REPORT_PREFIX } from '@sa/agent';
import { ASSISTANT_AGENT_ID, REPORT_TOOL } from '@sa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_VERSION } from '../app/paths';
import { t } from '../core/i18n';
import { createTestApp, type TestApp } from '../testing/harness';

let app: TestApp;
afterEach(async () => {
  await app?.close();
});

async function withProvider(opts: Parameters<typeof createTestApp>[0] = {}) {
  app = await createTestApp(opts);
  const res = await app.invoke('providers.setCustom', {
    baseUrl: 'http://127.0.0.1:8789/v1',
    api: 'openai-completions',
    model: 'mock-model',
  });
  expect(res.ok).toBe(true);
  return app;
}

const conversation = () => app.services.conversation.transcript();
/** A fresh token of the coordinator (starting its process issues a new one). */
const coordinatorToken = () => app.services.tokens.issue(ASSISTANT_AGENT_ID);
/** What the user sees of an agent (the meter). */
const infoOf = (agentId: string) => app.services.codemode.directory.info(agentId);

describe('the coordinator', () => {
  it('starts on the first message with its own role, session and work dir', async () => {
    await withProvider();
    const { client, launch, token } = await app.say('Quiero renovar el DNI');
    expect(launch).toMatchObject({
      nodeBinary: '/fake/electron',
      electronRunAsNode: true,
      cwd: join(app.paths.assistantDir, 'work'),
      bridge: { url: app.services.bridge.url() },
      config: {
        role: 'orchestrator',
        procedureId: ASSISTANT_AGENT_ID,
        sessionFile: join(app.paths.assistantDir, `session-v${CHAT_VERSION}.jsonl`),
        language: 'es',
        model: { provider: 'custom', id: 'mock-model' },
      },
    });
    expect(client.launch.args[0]).toBe('/app/packages/agent/dist/host.js');
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]?.text).toMatch(/\n\nQuiero renovar el DNI$/);
    expect(conversation()[0]).toMatchObject({ type: 'user', text: 'Quiero renovar el DNI' });
    expect(await app.invoke('chat.state')).toEqual({ activity: 'working' });
    // It only delegates: its agents and the cards, never the user's data or the browser.
    expect((await app.rpc('procs.list', {}, token)).body).toEqual({
      ok: true,
      result: { procedures: [] },
    });
    expect((await app.rpc('agents.list', {}, token)).body).toEqual({
      ok: true,
      result: { agents: [] },
    });
    // Its host checks the documents its messages link: their ids and names, nothing else.
    const doc = await app.vault.addDocument({
      name: 'Modelo 790-012.pdf',
      mimeType: 'application/pdf',
      bytes: Buffer.from('%PDF'),
      source: 'download',
    });
    expect((await app.rpc('vault.documents', {}, token)).body).toEqual({
      ok: true,
      result: { documents: [{ id: doc.id, name: 'Modelo 790-012.pdf' }] },
    });
    for (const method of [
      'vault.read',
      'browser.snapshot',
      'prompt.confirm',
      'procs.update',
      'agent.exaKey',
    ])
      expect((await app.rpc(method, {}, token)).status, method).toBe(403);
  });

  it('steers while it is replying and prompts when idle', async () => {
    await withProvider();
    const { client } = await app.say('Hola');
    client.emit({ type: 'run_start' });
    await app.say('¿Y para mi hija?');
    expect(client.steers).toHaveLength(1);
    expect(client.steers[0]).toMatch(/¿Y para mi hija\?$/);
    client.emit({ type: 'run_end' });
    await app.say('Gracias');
    expect(client.prompts.map((p) => p.text.split('\n\n').at(-1))).toEqual(['Hola', 'Gracias']);
    expect(app.agentLib.clients).toHaveLength(1);
  });

  it('gets attached images and document ids', async () => {
    await withProvider();
    const doc = await app.invoke('vault.addDocument', {
      name: 'dni.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([137, 80, 78, 71]),
    });
    await app.invoke('chat.send', {
      text: 'Aquí está mi DNI',
      attachments: [
        { documentId: doc.id, name: 'x', mimeType: 'x' },
        { documentId: 'd_missing', name: 'y', mimeType: 'y' },
      ],
    });
    await app.services.chat.settled();
    const last = app.agentFor(ASSISTANT_AGENT_ID)!.client.prompts.at(-1)!;
    expect(last.text).toContain(`dni.png (image/png, documentId: ${doc.id})`);
    expect(last.images).toEqual([{ mimeType: 'image/png', dataBase64: 'iVBORw==' }]);
    expect(conversation().at(-1)).toMatchObject({
      type: 'user',
      attachments: [{ documentId: doc.id, name: 'dni.png', mimeType: 'image/png' }],
    });
  });

  it('reports a missing provider as a notice without starting', async () => {
    app = await createTestApp();
    await app.invoke('chat.send', { text: 'Hola' });
    await app.services.chat.settled();
    expect(app.agentLib.launches).toHaveLength(0);
    expect(conversation().at(-1)).toMatchObject({
      type: 'notice',
      level: 'error',
      text: t('es', 'agentErrorNoProvider'),
    });
    expect(await app.invoke('chat.state')).toEqual({
      activity: 'idle',
      error: t('es', 'agentErrorNoProvider'),
    });
  });

  it('reports start failures and lets the next message retry', async () => {
    await withProvider();
    const original = app.agentLib.createClient;
    app.agentLib.createClient = (launch) => {
      const client = original(launch) as ReturnType<typeof original> & { failStart?: Error };
      client.failStart = new Error('spawn EACCES');
      return client;
    };
    await app.invoke('chat.send', { text: 'Hola' });
    await app.services.chat.settled();
    expect(conversation().at(-1)).toMatchObject({ type: 'notice', level: 'error' });
    const token = app.agentLib.launches.at(-1)!.bridge.token;
    expect((await app.rpc('procs.list', {}, token)).status).toBe(401);
    app.agentLib.createClient = original;
    const { client } = await app.say('Otra vez');
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]?.text).toMatch(/Otra vez$/);
  });

  it('abort stops its reply, not its agents or their questions', async () => {
    await withProvider();
    const coordinator = await app.say('Hola');
    const { procedureId, agentId, agent } = await app.startProcedure();
    coordinator.client.emit({ type: 'run_start' });
    const theirs = app.rpc(
      'prompt.confirm',
      { confirmKind: 'payment', title: 'Pagar', message: 'Pagar 12 €' },
      agent.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    await app.invoke('chat.abort');
    expect(coordinator.client.aborts).toBe(1);
    expect(app.pendingPrompt(procedureId)).toBeDefined();
    expect(agent.client.aborts).toBe(0);
    // The user stops the agent from the meter: the questions it asked go with it.
    await app.invoke('codemode.stopAgent', agentId);
    expect(agent.client.aborts).toBe(1);
    expect(agent.client.stopped).toBe(true);
    expect((await theirs).body.error?.code).toBe('user_rejected');
    expect(app.pendingPrompt(procedureId)).toBeUndefined();
  });
});

describe('background agents', () => {
  it('start from the coordinator with their own role, token, session and work dir', async () => {
    await withProvider();
    const { agentId, agent } = await app.startProcedure(
      'Renovar el DNI',
      'Caduca en octubre. Vive en Madrid.',
    );
    const paths = app.services.codemode.directory.paths(agentId);
    expect(agent.launch).toMatchObject({
      cwd: paths.workDir,
      config: { role: 'agent', procedureId: agentId, sessionFile: paths.sessionFile },
    });
    expect(agent.client.prompts).toHaveLength(1);
    expect(agent.client.prompts[0]?.text).toMatch(
      /\[Brief from the coordinator\]\nCaduca en octubre\. Vive en Madrid\.$/,
    );
    expect(infoOf(agentId)).toMatchObject({ kind: 'agent', status: 'Renovar el DNI' });
    // Agents cannot start or drive other agents.
    for (const [method, params] of [
      ['agents.start', { status: 'x', brief: 'y' }],
      ['agents.message', { agentId, message: 'x' }],
      ['agents.stop', { agentId }],
      ['agents.list', {}],
    ] as const)
      expect((await app.rpc(method, params, agent.token)).body.error?.code, method).toBe(
        'policy_denied',
      );
    // The coordinator sees it in its list.
    const list = await app.rpc('agents.list', {}, coordinatorToken());
    expect(list.body.result.agents).toEqual([
      expect.objectContaining({ id: agentId, status: 'Renovar el DNI' }),
    ]);
  });

  it('get messages from the coordinator: right away when idle, queued while working', async () => {
    await withProvider();
    const { agentId, agent } = await app.startProcedure();
    agent.client.emit({ type: 'run_start' });
    const queued = await app.rpc(
      'agents.message',
      { agentId, message: 'Prefiere por la tarde.' },
      coordinatorToken(),
    );
    expect(queued.body.result).toEqual({ delivered: 'queued', cancelledPrompts: 0 });
    expect(agent.client.followUps).toHaveLength(1);
    expect(agent.client.followUps[0]).toMatch(
      /\[Message from the coordinator\]\nPrefiere por la tarde\.$/,
    );
    agent.client.emit({ type: 'run_end' });
    // Its report started the coordinator, with a new token.
    await app.services.codemode.coordinator.settled();
    const started = await app.rpc(
      'agents.message',
      { agentId, message: 'Ya tiene el certificado.' },
      coordinatorToken(),
    );
    expect(started.body.result).toEqual({ delivered: 'started', cancelledPrompts: 0 });
    expect(agent.client.prompts.at(-1)?.text).toMatch(/Ya tiene el certificado\.$/);
    const missing = await app.rpc(
      'agents.message',
      { agentId: 'a_0000000000000000', message: 'x' },
      coordinatorToken(),
    );
    expect(missing.body.error?.code).toBe('not_found');
  });

  it('an urgent correction steers the agent and cancels the questions it asked, not another agent’s', async () => {
    await withProvider();
    const { procedureId, agentId, agent } = await app.startProcedure();
    const other = await app.startProcedure('Empadronamiento');
    agent.client.emit({ type: 'run_start' });
    const call = app.rpc(
      'prompt.userAction',
      { actionKind: 'captcha', title: 'Captcha', message: 'Resuelve el captcha' },
      agent.token,
    );
    const theirs = app.rpc(
      'prompt.confirm',
      { confirmKind: 'action', title: 'Seguir', message: '¿Seguimos?' },
      other.agent.token,
    );
    await app.waitFor(
      () => !!app.pendingPrompt(procedureId) && !!app.pendingPrompt(other.procedureId),
    );
    const prompt = app.pendingPrompt(procedureId)!;
    // The correction is queued in the run before the blocked call is released.
    const steersWhenReleased = call.then(() => agent.client.steers.length);
    const result = await app.rpc(
      'agents.message',
      { agentId, message: 'Relee Mis datos y continúa con Cl@ve.', urgent: true },
      coordinatorToken(),
    );
    expect(result.body.result).toEqual({ delivered: 'queued', cancelledPrompts: 1 });
    expect((await call).body.error?.code).toBe('user_rejected');
    expect(await steersWhenReleased).toBe(1);
    expect(app.pendingPrompt(procedureId)).toBeUndefined();
    expect(agent.client.aborts).toBe(0);
    expect(agent.client.steers[0]).toMatch(/Relee Mis datos y continúa con Cl@ve\.$/);
    expect(agent.client.prompts).toHaveLength(1);
    expect(app.services.procedures.findItem(procedureId, prompt.id)).toMatchObject({
      status: 'cancelled',
    });
    expect(app.services.procedures.findItem(procedureId, prompt.id)).not.toHaveProperty('response');
    await expect(
      app.invoke('chat.respond', prompt.id, { kind: 'user_action', done: true }),
    ).rejects.toThrow();
    // The other agent's question stays.
    expect(app.pendingPrompt(other.procedureId)).toBeDefined();
    await app.invoke('chat.respond', app.pendingPrompt(other.procedureId)!.id, {
      kind: 'confirm',
      approved: true,
    });
    expect((await theirs).body.result).toEqual({ kind: 'confirm', approved: true });
  });

  it('cancels only the questions asked before the correction', async () => {
    await withProvider();
    const { procedureId, agentId, agent } = await app.startProcedure();
    agent.client.emit({ type: 'run_start' });
    const confirm = { confirmKind: 'action', title: 'Dato', message: '¿Seguimos?' };
    const before = app.rpc('prompt.confirm', confirm, agent.token);
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const obsolete = app.pendingPrompt(procedureId)!;
    let deliver!: () => void;
    vi.spyOn(agent.client, 'steer').mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = () => resolve('queued');
        }),
    );
    const correction = app.rpc(
      'agents.message',
      { agentId, message: 'Usa otro método', urgent: true },
      coordinatorToken(),
    );
    await app.waitFor(() => !!deliver);
    void app.rpc('prompt.confirm', confirm, agent.token);
    await app.waitFor(() => app.services.prompts.pendingCount(procedureId) === 2);
    deliver();
    expect((await correction).body.result).toEqual({ delivered: 'queued', cancelledPrompts: 1 });
    expect((await before).body.error?.code).toBe('user_rejected');
    expect(app.services.procedures.findItem(procedureId, obsolete.id)).toMatchObject({
      status: 'cancelled',
    });
    expect(app.services.prompts.pendingCount(procedureId)).toBe(1);
  });

  it('acknowledges only actual delivery and propagates dispatch failures', async () => {
    await withProvider();
    const { agentId, agent } = await app.startProcedure();
    let accept!: (value: 'queued') => void;
    const prompt = vi.spyOn(agent.client, 'prompt').mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    let acknowledged = false;
    const delivery = app
      .rpc('agents.message', { agentId, message: 'Más información' }, coordinatorToken())
      .then((result) => {
        acknowledged = true;
        return result;
      });
    await app.waitFor(() => prompt.mock.calls.length > 0);
    expect(acknowledged).toBe(false);
    accept('queued');
    expect((await delivery).body.result).toEqual({ delivered: 'queued', cancelledPrompts: 0 });
    prompt.mockRejectedValue(new Error('delivery rejected'));
    for (const urgent of [false, true]) {
      const failed = await app.rpc(
        'agents.message',
        { agentId, message: 'Nueva instrucción', urgent },
        coordinatorToken(),
      );
      expect(failed.body.ok).toBe(false);
      expect(failed.body).not.toHaveProperty('result');
    }
  });

  it('report each finished run to the coordinator, short and with the cards’ status', async () => {
    await withProvider();
    const coordinator = await app.say('Hola');
    const { procedureId, agentId, agent } = await app.startProcedure();
    app.services.procedures.applyUpdate(procedureId, {
      status: 'planned',
      nextAction: { text: 'Elegir oficina', owner: 'user' },
    });
    coordinator.client.emit({ type: 'run_start' });
    const pdf = (name: string, owner = procedureId) =>
      app.vault.addDocument({
        name,
        mimeType: 'application/pdf',
        bytes: Buffer.from('%PDF'),
        source: 'download',
        procedureId: owner,
      });
    const older = await pdf('Antiguo.pdf');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const c = agent.client;
    c.emit({ type: 'run_start' });
    const saved = await pdf('Justificante.pdf');
    await pdf('De otro trámite.pdf', 'p_other');
    c.emit({ type: 'assistant_start', messageId: 'm1' });
    c.emit({ type: 'assistant_end', messageId: 'm1', text: `Plan listo. ${'x'.repeat(900)}` });
    c.emit({ type: 'run_end' });
    await app.services.codemode.coordinator.settled();
    // The coordinator was busy: the report waits for it to finish.
    const report = coordinator.client.followUps.at(-1)!;
    expect(report.startsWith(`${AGENT_REPORT_PREFIX} ${agentId} "Renovar el DNI"`)).toBe(true);
    expect(report).toContain(`${procedureId} "Renovar el DNI" (planned · next: Elegir oficina)`);
    expect(report.length).toBeLessThan(800 + 300);
    // Documents the run saved are named with their ids, so the coordinator can link them.
    expect(report.endsWith(`\nSaved documents: ${saved.id} "Justificante.pdf"`)).toBe(true);
    expect(report).not.toContain(older.id);
    // The user sees a compact row, not the report as a message.
    expect(conversation().at(-1)).toMatchObject({
      type: 'activity',
      tool: REPORT_TOOL,
      status: 'done',
      args: { agentId, procedureId, title: 'Renovar el DNI' },
    });
    // The agent's own message stays in its activity log.
    expect((await app.invoke('codemode.agentLog', agentId)).at(-1)).toMatchObject({
      type: 'assistant',
      status: 'complete',
    });
    // Aborted runs (the user stopped it) are not reported.
    const before = coordinator.client.followUps.length;
    c.emit({ type: 'run_start' });
    c.emit({ type: 'run_end', aborted: true });
    await app.services.codemode.coordinator.settled();
    expect(coordinator.client.followUps).toHaveLength(before);
  });

  it('ask the user directly; the answer goes straight back, never through the chat', async () => {
    await withProvider();
    const { procedureId, agent } = await app.startProcedure();
    const call = app.rpc(
      'prompt.confirm',
      { confirmKind: 'action', title: '¿Pido la cita en Madrid?', message: 'Madrid centro' },
      agent.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    expect(prompt.procedureId).toBe(procedureId);
    expect(app.services.procedures.get(procedureId)?.runtime.activity).toBe('needs_user');
    // A chat message does not cancel the agents' questions.
    const coordinator = await app.say('Una cosa más');
    expect(app.pendingPrompt(procedureId)?.id).toBe(prompt.id);
    await app.invoke('chat.respond', prompt.id, { kind: 'confirm', approved: true });
    expect((await call).body.result).toEqual({ kind: 'confirm', approved: true });
    expect(app.services.procedures.findItem(procedureId, prompt.id)).toMatchObject({
      status: 'answered',
    });
    expect(conversation().some((i) => i.type === 'prompt')).toBe(false);
    // Nothing of it reached the coordinator.
    expect(JSON.stringify(coordinator.client.prompts)).not.toContain('Madrid centro');
  });

  it('show what they are doing on the meter and log their tool calls', async () => {
    await withProvider();
    const { agentId, agent } = await app.startProcedure();
    const c = agent.client;
    c.emit({ type: 'run_start' });
    c.emit({
      type: 'tool_start',
      toolCallId: 't1',
      tool: 'codemode',
      args: { workflow: 'w' },
    });
    expect(infoOf(agentId)).toMatchObject({ activity: 'working' });
    c.emit({
      type: 'tool_end',
      toolCallId: 't1',
      tool: 'codemode',
      isError: false,
      summary: 'ok',
    });
    c.emit({ type: 'assistant_start', messageId: 'm1' });
    c.emit({ type: 'assistant_end', messageId: 'm1', text: 'Hecho.' });
    c.emit({ type: 'run_end' });
    // The brief it got from the coordinator, its tool call, its report.
    expect((await app.invoke('codemode.agentLog', agentId)).map((i) => i.type)).toEqual([
      'user',
      'activity',
      'assistant',
    ]);
    expect(infoOf(agentId)).toMatchObject({ activity: 'idle' });
    expect(app.events.some((e) => e.type === 'codemode.agentLog' && e.agentId === agentId)).toBe(
      true,
    );
  });

  it('stop when idle, revoke their token, and restart with a new one for the next message', async () => {
    await withProvider({ idleMs: 40 });
    const { procedureId, agentId, agent } = await app.startProcedure();
    const c = agent.client;
    c.emit({ type: 'run_start' });
    c.emit({ type: 'run_end' });
    await app.waitFor(() => c.stopped, 1000);
    expect((await app.rpc('procs.get', { id: procedureId }, agent.token)).status).toBe(401);
    await app.services.codemode.coordinator.settled();
    const resumed = await app.rpc(
      'agents.message',
      { agentId, message: 'Sigue' },
      coordinatorToken(),
    );
    expect(resumed.body.result).toEqual({ delivered: 'started', cancelledPrompts: 0 });
    expect(app.agentFor(agentId)!.token).not.toBe(agent.token);
  });

  it('crashes show on the meter and reach the coordinator as a failed report', async () => {
    await withProvider();
    const coordinator = await app.say('Hola');
    const { agentId, agent } = await app.startProcedure();
    agent.client.emit({ type: 'run_start' });
    agent.client.emit({ type: 'process_exit', code: 1, signal: null, stderrTail: 'boom' });
    await app.services.codemode.coordinator.settled();
    expect((await app.invoke('codemode.agentLog', agentId)).at(-1)).toMatchObject({
      type: 'notice',
      level: 'error',
      text: t('es', 'agentCrashed'),
    });
    expect(infoOf(agentId)).toMatchObject({ activity: 'idle', error: t('es', 'agentCrashed') });
    expect(conversation().at(-1)).toMatchObject({ tool: REPORT_TOOL, status: 'error' });
    expect(coordinator.client.prompts.at(-1)?.text).toContain('It failed');
    expect((await app.rpc('procs.list', {}, agent.token)).status).toBe(401);
  });

  it('shares and rates learnings only with a gateway key (voucher or ChatGPT)', async () => {
    await withProvider();
    const custom = await app.startProcedure('Trámite A');
    expect(custom.agent.launch.config.feedback).toEqual({ submit: false, vote: false });
    await app.close();

    app = await createTestApp();
    expect((await app.invoke('providers.redeemVoucher', 'VALID-CODE')).ok).toBe(true);
    const voucher = await app.startProcedure('Trámite B');
    expect(voucher.agent.launch.config.feedback).toEqual({ submit: true, vote: true });
  });

  it('research with the user’s Exa key only on BYOK and custom endpoints', async () => {
    await withProvider();
    const custom = await app.startProcedure('Trámite A');
    expect(custom.agent.launch.config.research).toMatchObject({ exa: true });
    // The key itself never goes into the config: the host asks for it over the bridge.
    await app.invoke('providers.setExaKey', 'exa-secret-key-123');
    expect(JSON.stringify(app.agentLib.launches)).not.toContain('exa-secret-key-123');
    await app.close();

    app = await createTestApp();
    expect((await app.invoke('providers.redeemVoucher', 'VALID-CODE')).ok).toBe(true);
    const voucher = await app.startProcedure('Trámite B');
    expect(voucher.agent.launch.config.research?.exa).toBeUndefined();
  });

  it('research on a ChatGPT plan with the models the app picked for it', async () => {
    app = await createTestApp();
    await app.invoke('providers.loginChatGPT');
    const chatgpt = await app.startProcedure('Trámite A');
    // OpenAI's model list is offline here: each mode's first model.
    expect(chatgpt.agent.launch.config.research?.chatgptModels).toEqual({
      fast: { id: 'gpt-test-fast', thinkingLevel: 'high' },
      balanced: { id: 'gpt-test-balanced', thinkingLevel: 'high' },
      deep: { id: 'gpt-test-deep', thinkingLevel: 'high' },
    });
    await app.close();

    app = await createTestApp();
    expect((await app.invoke('providers.redeemVoucher', 'VALID-CODE')).ok).toBe(true);
    const voucher = await app.startProcedure('Trámite B');
    expect(voucher.agent.launch.config.research?.chatgptModels).toBeUndefined();
  });

  it('all stop when the provider or the language changes', async () => {
    await withProvider();
    const coordinator = await app.say('Hola');
    const a = await app.startProcedure('Trámite A');
    const b = await app.startProcedure('Trámite B');
    await app.invoke('providers.setModel', 'other-model');
    expect(a.agent.client.stopped && b.agent.client.stopped).toBe(true);
    expect(coordinator.client.stopped).toBe(true);
    const { client } = await app.say('Hola');
    expect(app.agentLib.launches.at(-1)?.config.model.id).toBe('other-model');
    await app.invoke('settings.update', { language: 'en' });
    await app.waitFor(() => client.stopped);
  });

  it('only the coordinator can stop them, and stopping keeps their procedures for resumption', async () => {
    await withProvider();
    const { procedureId, agentId, agent } = await app.startProcedure();
    agent.client.emit({ type: 'run_start' });
    const before = structuredClone(app.services.procedures.require(procedureId));
    expect((await app.rpc('agents.stop', { agentId }, agent.token)).body.error?.code).toBe(
      'policy_denied',
    );
    expect(agent.client.aborts).toBe(0);
    expect(
      (await app.rpc('agents.stop', { agentId: '' }, coordinatorToken())).body.error?.code,
    ).toBe('bad_request');
    expect(
      (await app.rpc('agents.stop', { agentId: 'a_0000000000000000' }, coordinatorToken())).body
        .error?.code,
    ).toBe('not_found');
    const stopped = await app.rpc('agents.stop', { agentId }, coordinatorToken());
    expect(stopped.body).toEqual({ ok: true, result: { stopped: true } });
    expect(agent.client.aborts).toBe(1);
    expect(infoOf(agentId)).toMatchObject({ activity: 'idle' });
    expect(app.services.procedures.get(procedureId)).toMatchObject({
      status: before.status,
      steps: before.steps,
    });
    const resumed = await app.rpc(
      'agents.message',
      { agentId, message: 'Continúa' },
      coordinatorToken(),
    );
    expect(resumed.body.result).toEqual({ delivered: 'started', cancelledPrompts: 0 });
    expect(app.agentFor(agentId)!.client.prompts.at(-1)?.text).toMatch(/Continúa$/);
  });

  it('deleting a procedure cancels its questions; its agent works on', async () => {
    await withProvider();
    const { procedureId, agentId, agent } = await app.startProcedure();
    const call = app.rpc(
      'prompt.confirm',
      { confirmKind: 'action', title: 'x', message: 'y' },
      agent.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    await app.invoke('procedures.delete', procedureId);
    expect((await call).status).toBeGreaterThanOrEqual(400);
    expect(agent.client.stopped).toBe(false);
    expect(await app.invoke('procedures.list')).toEqual([]);
    expect(app.events).toContainEqual({ type: 'procedure.deleted', procedureId });
    expect(infoOf(agentId)?.procedures).toEqual([]);
    // Its questions lived above the cards: nothing is left in the conversation.
    expect(conversation().some((i) => i.type === 'prompt')).toBe(false);
  });
});

describe('questions across app restarts', () => {
  it('none survives: each is cancelled, and the workflow that asked asks again when it resumes', async () => {
    await withProvider();
    const { procedureId, agent } = await app.startProcedure();
    const requests = [
      app.rpc(
        'prompt.phoneCall',
        {
          title: 'Llama a EMASESA',
          organization: 'EMASESA',
          phoneNumber: '900 822 010',
          purpose: 'Cambiar el número de personas que viven en la casa.',
          questions: ['¿Qué papeles hacen falta?'],
        },
        agent.token,
      ),
      app.rpc(
        'prompt.confirm',
        { confirmKind: 'action', title: 'Seguir', message: '¿Seguimos?' },
        agent.token,
      ),
    ];
    await app.waitFor(() => app.services.prompts.pendingCount(procedureId) === 2);
    const asked = app.services.prompts.pendingItems().map((p) => p.item.id);
    await app.restart();
    for (const request of await Promise.all(requests))
      expect(request.body.error?.code).toBe('user_rejected');
    expect(app.services.prompts.pendingItems()).toEqual([]);
    expect(app.pendingPrompt(procedureId)).toBeUndefined();
    for (const id of asked)
      expect(app.services.procedures.findItem(procedureId, id)).toMatchObject({
        status: 'cancelled',
      });
    await expect(
      app.invoke('chat.respond', asked[0]!, {
        kind: 'phone_call',
        outcome: 'done',
        transcript: 'Ellos: Hace falta el volante.',
      }),
    ).rejects.toThrow();
  });
});
