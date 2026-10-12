import { REPORT_PREFIX } from '@sa/agent';
import { ASSISTANT_AGENT_ID, REPORT_TOOL } from '@sa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_REPORT_CHARS } from '../conversation/coordinator';
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

describe('the assistant', () => {
  it('starts on the first message with its own role, session and work dir', async () => {
    await withProvider();
    const { client, launch, token } = await app.say('Quiero renovar el DNI');
    expect(launch).toMatchObject({
      nodeBinary: '/fake/electron',
      electronRunAsNode: true,
      cwd: `${app.paths.assistantDir}/work`,
      bridge: { url: app.services.bridge.url() },
      config: {
        role: 'assistant',
        procedureId: ASSISTANT_AGENT_ID,
        sessionFile: `${app.paths.assistantDir}/session.jsonl`,
        language: 'es',
        model: { provider: 'custom', id: 'mock-model' },
      },
    });
    expect(client.launch.args[0]).toBe('/app/packages/agent/dist/host.js');
    expect(client.prompts).toEqual([{ text: 'Quiero renovar el DNI' }]);
    expect(conversation()[0]).toMatchObject({ type: 'user', text: 'Quiero renovar el DNI' });
    expect(await app.invoke('chat.state')).toEqual({ activity: 'working' });
    // The assistant may list procedures and use the user's data, but never the browser.
    expect((await app.rpc('procedures.list', {}, token)).body).toEqual({
      ok: true,
      result: { procedures: [] },
    });
    expect((await app.rpc('vault.read', {}, token)).status).toBe(200);
    expect((await app.rpc('browser.snapshot', {}, token)).body.error?.code).toBe('policy_denied');
    expect((await app.rpc('procedure.update', { status: 'done' }, token)).status).toBe(403);
  });

  it('steers while it is replying and prompts when idle', async () => {
    await withProvider();
    const { client } = await app.say('Hola');
    client.emit({ type: 'run_start' });
    await app.say('¿Y para mi hija?');
    expect(client.steers).toEqual(['¿Y para mi hija?']);
    client.emit({ type: 'run_end' });
    await app.say('Gracias');
    expect(client.prompts.map((p) => p.text)).toEqual(['Hola', 'Gracias']);
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
    expect((await app.rpc('procedures.list', {}, token)).status).toBe(401);
    app.agentLib.createClient = original;
    const { client } = await app.say('Otra vez');
    expect(client.prompts).toEqual([{ text: 'Otra vez' }]);
  });

  it('abort stops its reply and its own questions, not the procedures', async () => {
    await withProvider();
    const { procedureId, agent } = await app.startProcedure();
    const assistant = app.agentFor(ASSISTANT_AGENT_ID)!;
    assistant.client.emit({ type: 'run_start' });
    const own = app.rpc(
      'prompt.form',
      { title: 'Ciudad', fields: [{ key: 'c', label: 'Ciudad', type: 'text' }] },
      assistant.token,
    );
    const theirs = app.rpc(
      'prompt.confirm',
      { confirmKind: 'payment', title: 'Pagar', message: 'Pagar 12 €' },
      agent!.token,
    );
    await app.waitFor(() => !!app.pendingPrompt() && !!app.pendingPrompt(procedureId));
    await app.invoke('chat.abort');
    expect((await own).body.error?.code).toBe('user_rejected');
    expect(assistant.client.aborts).toBe(1);
    expect(app.pendingPrompt(procedureId)).toBeDefined();
    expect(agent!.client.aborts).toBe(0);
    await app.invoke('procedures.stop', procedureId);
    expect((await theirs).body.error?.code).toBe('user_rejected');
    expect(agent!.client.aborts).toBe(1);
  });
});

describe('procedure agents', () => {
  it('does not acknowledge a new procedure brief when its agent fails to start', async () => {
    await withProvider();
    const assistant = await app.say('Hola');
    const create = app.agentLib.createClient;
    app.agentLib.createClient = (launch) => {
      const client = create(launch) as ReturnType<typeof create> & { failStart?: Error };
      client.failStart = new Error('spawn EACCES');
      return client;
    };
    const result = await app.rpc(
      'procedures.start',
      { title: 'Descargar documento', brief: 'Solo consulta' },
      assistant.token,
    );
    expect(result.body.ok).toBe(false);
    expect(result.body).not.toHaveProperty('result');
    expect(app.services.procedures.briefs(false)).toHaveLength(1);
    await app.services.coordinator.settled();
  });

  it('start from the assistant with their own role, token and work dir', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure(
      'Renovar el DNI',
      'Caduca en octubre. Vive en Madrid.',
    );
    const paths = app.services.procedures.paths(procedureId);
    expect(app.services.procedures.get(procedureId)).toMatchObject({
      title: 'Renovar el DNI',
      status: 'researching',
      runtime: { activity: 'working' },
    });
    expect(agent!.launch).toMatchObject({
      cwd: paths.workDir,
      config: { role: 'procedure', procedureId, sessionFile: paths.sessionFile },
    });
    expect(agent!.client.prompts).toEqual([{ text: 'Caduca en octubre. Vive en Madrid.' }]);
    // Procedure agents cannot drive other procedures.
    expect(
      (await app.rpc('procedures.start', { title: 'x', brief: 'y' }, agent!.token)).body.error
        ?.code,
    ).toBe('policy_denied');
    expect((await app.rpc('procedure.get', {}, agent!.token)).body.result.id).toBe(procedureId);
    // The assistant sees it in its list.
    const list = await app.rpc('procedures.list', {}, assistant.token);
    expect(list.body.result.procedures).toEqual([
      expect.objectContaining({ id: procedureId, title: 'Renovar el DNI', activity: 'working' }),
    ]);
  });

  it('get messages from the assistant: right away when idle, queued while working', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    agent!.client.emit({ type: 'run_start' });
    const queued = await app.rpc(
      'procedures.message',
      { procedureId, message: 'Prefiere por la tarde.' },
      assistant.token,
    );
    await app.services.coordinator.settled();
    expect(queued.body.result).toEqual({ delivered: 'queued' });
    expect(agent!.client.followUps).toEqual(['Prefiere por la tarde.']);
    agent!.client.emit({ type: 'run_end' });
    const started = await app.rpc(
      'procedures.message',
      { procedureId, message: 'Ya tiene el certificado.' },
      assistant.token,
    );
    await app.services.coordinator.settled();
    expect(started.body.result).toEqual({ delivered: 'started' });
    expect(agent!.client.prompts.at(-1)).toEqual({ text: 'Ya tiene el certificado.' });
    const missing = await app.rpc(
      'procedures.message',
      { procedureId: 'p_0000000000000000', message: 'x' },
      assistant.token,
    );
    expect(missing.body.error?.code).toBe('not_found');
  });

  it('reads and answers pending forms from the coordinator, including vault persistence', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    agent!.client.emit({ type: 'run_start' });
    const call = app.rpc(
      'prompt.form',
      {
        title: 'Horario',
        fields: [
          {
            key: 'time',
            label: 'Horario',
            type: 'select',
            required: true,
            options: [{ value: 'afternoon', label: 'Tarde' }],
            vaultKey: 'custom.horario',
          },
        ],
      },
      agent!.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    const read = await app.rpc('procedures.read', { procedureId }, assistant.token);
    expect(read.body.result.runtime.prompts[0].id).toBe(prompt.id);
    const answer = { procedureId, promptId: prompt.id, values: { time: 'afternoon' } };
    const other = await app.procedureWithToken();
    expect(
      (
        await app.rpc(
          'procedures.respond',
          { ...answer, procedureId: other.procedureId },
          assistant.token,
        )
      ).body.error?.code,
    ).toBe('not_found');
    expect((await app.rpc('procedures.respond', answer, agent!.token)).body.error?.code).toBe(
      'policy_denied',
    );
    expect(
      (await app.rpc('procedures.respond', { ...answer, procedureId: 'missing' }, assistant.token))
        .body.error?.code,
    ).toBe('not_found');
    expect(
      (await app.rpc('procedures.respond', { ...answer, values: {} }, assistant.token)).body.error
        ?.code,
    ).toBe('bad_request');
    expect(
      (
        await app.rpc(
          'procedures.respond',
          { ...answer, values: { time: 'invalid' } },
          assistant.token,
        )
      ).body.error?.code,
    ).toBe('bad_request');
    expect(app.pendingPrompt(procedureId)).toBeDefined();
    expect((await app.rpc('procedures.respond', answer, assistant.token)).body.result).toEqual({
      answered: true,
      dismissed: false,
    });
    expect((await call).body.result.values).toEqual({ time: 'afternoon' });
    expect(app.vault.getPersonal('custom.horario')?.value).toBe('afternoon');
    expect(app.pendingPrompt(procedureId)).toBeUndefined();
    expect((await app.rpc('procedures.respond', answer, assistant.token)).body.error?.code).toBe(
      'not_found',
    );
  });

  it('answers only visible required fields, preserving a false boolean answer', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    const call = app.rpc(
      'prompt.form',
      {
        title: 'Acceso',
        fields: [
          {
            key: 'method',
            label: 'Método',
            type: 'select',
            options: [
              { value: 'mobile', label: 'Móvil' },
              { value: 'sms', label: 'SMS' },
            ],
          },
          {
            key: 'phone',
            label: 'Teléfono',
            type: 'phone',
            vaultKey: 'phone',
            visibleWhen: { field: 'method', values: ['sms'] },
          },
          { key: 'remember', label: 'Recordar', type: 'boolean' },
        ],
      },
      agent!.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const promptId = app.pendingPrompt(procedureId)!.id;
    const result = await app.rpc(
      'procedures.respond',
      { procedureId, promptId, values: { method: 'mobile', remember: false } },
      assistant.token,
    );
    expect(result.body.result.answered).toBe(true);
    expect((await call).body.result.values).toEqual({ method: 'mobile', remember: false });
  });

  it('aborts the blocked form and starts a new run with newly available credentials', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    agent!.client.emit({ type: 'run_start' });
    const call = app.rpc(
      'prompt.form',
      {
        title: 'Otra vía de acceso',
        fields: [{ key: 'method', label: 'Método', type: 'text' }],
      },
      agent!.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    await app.rpc(
      'procedures.message',
      { procedureId, message: 'Ya he añadido Cl@ve' },
      assistant.token,
    );
    await app.services.coordinator.settled();
    expect(app.pendingPrompt(procedureId)).toBeDefined();
    const result = await app.rpc(
      'procedures.resume',
      { procedureId, message: 'Relee Mis datos y continúa con Cl@ve.' },
      assistant.token,
    );
    expect(result.body.result.delivered).toBe('started');
    expect((await call).body.error?.code).toBe('user_rejected');
    await app.services.coordinator.settled();
    expect(app.pendingPrompt(procedureId)).toBeUndefined();
    expect(agent!.client.aborts).toBe(1);
    expect(agent!.client.prompts.at(-1)?.text).toBe('Relee Mis datos y continúa con Cl@ve.');
    expect(app.services.procedures.findItem(procedureId, prompt.id)).toMatchObject({
      status: 'cancelled',
    });
    expect(app.services.procedures.get(procedureId)?.status).not.toBe('cancelled');
  });

  it('lets only the coordinator cancel pending requests on resume, without approving them', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    for (const [method, params] of [
      ['prompt.confirm', { title: 'Pagar', message: 'Pagar tasa', confirmKind: 'payment' }],
      [
        'prompt.userAction',
        {
          title: 'Aprueba en tu móvil',
          message: 'Abre la app',
          actionKind: 'phone_approval',
          showBrowser: false,
        },
      ],
      [
        'prompt.form',
        { title: 'Código', fields: [{ key: 'code', label: 'Código', type: 'secret' }] },
      ],
    ] as const) {
      agent!.client.emit({ type: 'run_start' });
      const call = app.rpc(method, params, agent!.token);
      await app.waitFor(() => !!app.pendingPrompt(procedureId));
      const prompt = app.pendingPrompt(procedureId)!;
      const response = await app.rpc(
        'procedures.respond',
        { procedureId, promptId: prompt.id, values: { code: '123456' } },
        assistant.token,
      );
      expect(response.body.error?.code).toBe('policy_denied');
      expect(
        (
          await app.rpc(
            'procedures.resume',
            { procedureId, message: 'Cambia de vía' },
            agent!.token,
          )
        ).body.error?.code,
      ).toBe('policy_denied');
      expect(app.pendingPrompt(procedureId)?.id).toBe(prompt.id);
      const resumed = await app.rpc(
        'procedures.resume',
        { procedureId, message: 'Cambia de vía' },
        assistant.token,
      );
      expect(resumed.body.result).toEqual({ delivered: 'started' });
      expect((await call).body.error?.code).toBe('user_rejected');
      expect(app.pendingPrompt(procedureId)).toBeUndefined();
      expect(app.services.procedures.findItem(procedureId, prompt.id)).toMatchObject({
        status: 'cancelled',
      });
      expect(app.services.procedures.findItem(procedureId, prompt.id)).not.toHaveProperty(
        'response',
      );
      await expect(
        app.invoke('chat.respond', prompt.id, { kind: 'confirm', approved: true }),
      ).rejects.toThrow();
    }
    expect(agent!.client.aborts).toBe(3);
  });

  it('waits for the previous run to abort before delivering a correction', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    agent!.client.emit({ type: 'run_start' });
    let finishAbort!: () => void;
    const abort = vi.spyOn(agent!.client, 'abort').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishAbort = () => {
            agent!.client.emit({ type: 'run_end', aborted: true });
            resolve();
          };
        }),
    );
    const call = app.rpc(
      'prompt.userAction',
      {
        title: 'Confirma el acceso',
        message: 'Escanea el QR',
        actionKind: 'qr_scan',
        showBrowser: false,
      },
      agent!.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const resume = app.rpc(
      'procedures.resume',
      { procedureId, message: 'Usa otro método' },
      assistant.token,
    );
    await app.waitFor(() => abort.mock.calls.length > 0);
    expect((await call).body.error?.code).toBe('user_rejected');
    expect(agent!.client.prompts).toHaveLength(1);
    finishAbort();
    expect((await resume).body.result).toEqual({ delivered: 'started' });
    expect(agent!.client.prompts.at(-1)?.text).toBe('Usa otro método');
    expect(agent!.client.steers).toHaveLength(0);
    expect(agent!.client.followUps).toHaveLength(0);
    expect(
      conversation().some((item) => item.type === 'activity' && item.tool === REPORT_TOOL),
    ).toBe(false);
  });

  it('restarts the agent if its old run cannot abort', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    agent!.client.emit({ type: 'run_start' });
    vi.spyOn(agent!.client, 'abort').mockRejectedValue(new Error('abort failed'));
    const result = await app.rpc(
      'procedures.resume',
      { procedureId, message: 'Cambia de método' },
      assistant.token,
    );
    expect(result.body.result).toEqual({ delivered: 'started' });
    expect(agent!.client.stopped).toBe(true);
    const replacement = app.agentFor(procedureId)!;
    expect(replacement.client).not.toBe(agent!.client);
    expect(replacement.client.prompts).toEqual([{ text: 'Cambia de método' }]);
    expect(replacement.launch.config.sessionFile).toBe(agent!.launch.config.sessionFile);
    expect((await app.rpc('procedure.get', {}, agent!.token)).body.error?.code).toBe(
      'unauthorized',
    );
  });

  it('acknowledges only actual delivery and propagates dispatch failures', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    let accept!: (value: 'queued') => void;
    const prompt = vi.spyOn(agent!.client, 'prompt').mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    let acknowledged = false;
    const delivery = app
      .rpc('procedures.message', { procedureId, message: 'Más información' }, assistant.token)
      .then((result) => {
        acknowledged = true;
        return result;
      });
    await app.waitFor(() => prompt.mock.calls.length > 0);
    expect(acknowledged).toBe(false);
    accept('queued');
    expect((await delivery).body.result).toEqual({ delivered: 'queued' });
    prompt.mockRejectedValue(new Error('delivery rejected'));
    for (const method of ['procedures.message', 'procedures.resume'] as const) {
      const failed = await app.rpc(
        method,
        { procedureId, message: 'Nueva instrucción' },
        assistant.token,
      );
      expect(failed.body.ok).toBe(false);
      expect(failed.body).not.toHaveProperty('result');
    }
  });

  it('report each finished run to the assistant, short and with the card status', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    await app.rpc(
      'procedure.update',
      { status: 'planned', nextAction: { text: 'Elegir oficina', owner: 'user' } },
      agent!.token,
    );
    assistant.client.emit({ type: 'run_start' });
    const c = agent!.client;
    c.emit({ type: 'run_start' });
    c.emit({ type: 'assistant_start', messageId: 'm1' });
    c.emit({ type: 'assistant_end', messageId: 'm1', text: `Plan listo. ${'x'.repeat(900)}` });
    c.emit({ type: 'run_end' });
    await app.services.coordinator.settled();
    // The assistant was busy: the report waits for it to finish.
    const report = assistant.client.followUps.at(-1)!;
    expect(report.startsWith(`${REPORT_PREFIX} ${procedureId} "Renovar el DNI"`)).toBe(true);
    expect(report).toContain('status: planned · next: Elegir oficina (user)]');
    expect(report.length).toBeLessThan(MAX_REPORT_CHARS + 200);
    // The user sees a compact row, not the report as a message.
    const row = conversation().at(-1);
    expect(row).toMatchObject({
      type: 'activity',
      tool: REPORT_TOOL,
      status: 'done',
      args: { procedureId, title: 'Renovar el DNI' },
    });
    // The procedure's own message stays in its activity log.
    expect((await app.invoke('procedures.log', procedureId)).at(-1)).toMatchObject({
      type: 'assistant',
      status: 'complete',
    });
    // Aborted runs (the user stopped it) are not reported.
    const before = assistant.client.followUps.length;
    c.emit({ type: 'run_start' });
    c.emit({ type: 'run_end', aborted: true });
    await app.services.coordinator.settled();
    expect(assistant.client.followUps).toHaveLength(before);
  });

  it('ask the user directly on their card; the answer goes straight back', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    const call = app.rpc(
      'prompt.form',
      {
        title: '¿Dónde quieres la cita?',
        fields: [{ key: 'city', label: 'Ciudad', type: 'text', vaultKey: 'addressCity' }],
      },
      agent!.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    expect(prompt.procedureId).toBe(procedureId);
    expect(app.services.procedures.get(procedureId)?.runtime.activity).toBe('needs_user');
    // A chat message does not cancel questions of procedure agents.
    await app.say('Una cosa más');
    expect(app.pendingPrompt(procedureId)?.id).toBe(prompt.id);
    await app.invoke('chat.respond', prompt.id, {
      kind: 'form',
      values: { city: 'Madrid' },
      savedToVault: ['city'],
      dismissed: false,
    });
    expect((await call).body.result).toMatchObject({ values: { city: 'Madrid' } });
    expect(app.services.procedures.findItem(procedureId, prompt.id)).toMatchObject({
      status: 'answered',
    });
    expect(conversation().some((i) => i.type === 'prompt')).toBe(false);
    expect(conversation().at(-1)).toMatchObject({ type: 'notice', procedureId });
    // Nothing of it reached the assistant.
    expect(JSON.stringify(assistant.client.prompts)).not.toContain('Madrid');
  });

  it('show what they are doing on their card and log their tool calls', async () => {
    await withProvider();
    const { procedureId, agent } = await app.startProcedure();
    await app.invoke('procedures.markRead', procedureId);
    const c = agent!.client;
    c.emit({ type: 'run_start' });
    c.emit({
      type: 'tool_start',
      toolCallId: 't1',
      tool: 'fetch_url',
      args: { url: 'https://x.es' },
    });
    expect(app.services.procedures.get(procedureId)?.runtime).toMatchObject({
      activity: 'working',
      now: { tool: 'fetch_url', args: { url: 'https://x.es' } },
    });
    c.emit({
      type: 'tool_end',
      toolCallId: 't1',
      tool: 'fetch_url',
      isError: false,
      summary: 'ok',
    });
    c.emit({ type: 'assistant_start', messageId: 'm1' });
    c.emit({ type: 'assistant_end', messageId: 'm1', text: 'Hecho.' });
    c.emit({ type: 'run_end' });
    // The brief it got from the assistant, its tool call, its report.
    expect((await app.invoke('procedures.log', procedureId)).map((i) => i.type)).toEqual([
      'user',
      'activity',
      'assistant',
    ]);
    expect(app.services.procedures.get(procedureId)?.runtime).toEqual({
      activity: 'idle',
      unread: true,
    });
    expect(
      app.events.some((e) => e.type === 'procedure.log' && e.procedureId === procedureId),
    ).toBe(true);
  });

  it('stop when idle, never while a question is pending, and revoke their token', async () => {
    await withProvider({ idleMs: 40 });
    const { procedureId, agent, assistant } = await app.startProcedure();
    const c = agent!.client;
    c.emit({ type: 'run_start' });
    const call = app.rpc(
      'prompt.form',
      { title: 'Datos', fields: [{ key: 'a', label: 'A', type: 'text' }] },
      agent!.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    c.emit({ type: 'run_end' });
    await new Promise((r) => setTimeout(r, 120));
    expect(c.stopped).toBe(false);
    await app.invoke('chat.respond', app.pendingPrompt(procedureId)!.id, {
      kind: 'form',
      values: { a: 'x' },
      dismissed: false,
      savedToVault: [],
    });
    expect((await call).body.ok).toBe(true);
    await app.waitFor(() => c.stopped, 1000);
    expect((await app.rpc('procedure.get', {}, agent!.token)).status).toBe(401);
    // A new message from the assistant restarts it transparently (the assistant stopped too).
    assistant.client.emit({ type: 'run_start' });
    assistant.client.emit({ type: 'run_end' });
    await app.waitFor(() => assistant.client.stopped, 1000);
    const again = await app.say('Sigue');
    await app.rpc('procedures.message', { procedureId, message: 'Sigue' }, again.token);
    await app.services.coordinator.settled();
    expect(app.agentFor(procedureId)!.token).not.toBe(agent!.token);
  });

  it('crashes show on the card and reach the assistant as a failed report', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    agent!.client.emit({ type: 'run_start' });
    agent!.client.emit({ type: 'process_exit', code: 1, signal: null, stderrTail: 'boom' });
    await app.services.coordinator.settled();
    expect((await app.invoke('procedures.log', procedureId)).at(-1)).toMatchObject({
      type: 'notice',
      level: 'error',
      text: t('es', 'agentCrashed'),
    });
    expect(app.services.procedures.get(procedureId)?.runtime).toMatchObject({
      activity: 'idle',
      error: t('es', 'agentCrashed'),
    });
    expect(conversation().at(-1)).toMatchObject({ tool: REPORT_TOOL, status: 'error' });
    expect(assistant.client.prompts.at(-1)?.text).toContain('It failed');
    expect((await app.rpc('procedure.get', {}, agent!.token)).status).toBe(401);
  });

  it('shares and rates learnings only with a gateway key (voucher or ChatGPT), shares only with the flag', async () => {
    await withProvider();
    const custom = await app.startProcedure('Trámite A');
    expect(custom.agent!.launch.config.feedback).toEqual({ submit: false, vote: false });
    await app.close();

    app = await createTestApp();
    expect((await app.invoke('providers.redeemVoucher', 'VALID-CODE')).ok).toBe(true);
    const voucher = await app.startProcedure('Trámite B');
    expect(voucher.agent!.launch.config.feedback).toEqual({ submit: true, vote: true });
    await app.close();

    // Without the feature flag they still rate learnings, but don't share them.
    app = await createTestApp({ features: { feedbackServer: false } });
    expect((await app.invoke('providers.redeemVoucher', 'VALID-CODE')).ok).toBe(true);
    const flagOff = await app.startProcedure('Trámite C');
    expect(flagOff.agent!.launch.config.feedback).toEqual({ submit: false, vote: true });
  });

  it('all stop when the provider or the language changes', async () => {
    await withProvider();
    const a = await app.startProcedure('Trámite A');
    const b = await app.startProcedure('Trámite B');
    await app.invoke('providers.setModel', 'other-model');
    expect(a.agent!.client.stopped && b.agent!.client.stopped).toBe(true);
    expect(a.assistant.client.stopped).toBe(true);
    const { client } = await app.say('Hola');
    expect(app.agentLib.launches.at(-1)?.config.model.id).toBe('other-model');
    await app.invoke('settings.update', { language: 'en' });
    await app.waitFor(() => client.stopped);
  });

  it('cancelled by the assistant: stopped, questions cancelled, card cancelled', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    const call = app.rpc(
      'prompt.confirm',
      { confirmKind: 'action', title: 'x', message: 'y' },
      agent!.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const res = await app.rpc(
      'procedures.cancel',
      { procedureId, reason: 'Ya no lo necesita' },
      assistant.token,
    );
    expect(res.body.result).toEqual({ cancelled: true });
    expect(agent!.client.stopped).toBe(true);
    expect((await call).status).toBeGreaterThanOrEqual(400);
    expect(app.services.procedures.get(procedureId)).toMatchObject({ status: 'cancelled' });
    expect(app.services.procedures.get(procedureId)?.nextAction).toBeUndefined();
  });

  it('only the coordinator can interrupt work, preserving the procedure for resumption', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    agent!.client.emit({ type: 'run_start' });
    const before = structuredClone(app.services.procedures.require(procedureId));
    const prompt = app.rpc(
      'prompt.form',
      {
        title: 'Ciudad',
        fields: [{ key: 'city', label: 'Ciudad', type: 'text', required: false }],
      },
      agent!.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const denied = await app.rpc('procedures.stop', { procedureId }, agent!.token);
    expect(denied.body.error?.code).toBe('policy_denied');
    expect(agent!.client.aborts).toBe(0);
    expect(
      (await app.rpc('procedures.stop', { procedureId: '' }, assistant.token)).body.error?.code,
    ).toBe('bad_request');
    expect(
      (await app.rpc('procedures.stop', { procedureId: 'missing' }, assistant.token)).body.error
        ?.code,
    ).toBe('not_found');
    const stopped = await app.rpc('procedures.stop', { procedureId }, assistant.token);
    expect(stopped.body).toEqual({ ok: true, result: { stopped: true } });
    expect((await prompt).body.error?.code).toBe('user_rejected');
    expect(agent!.client.aborts).toBe(1);
    expect(app.pendingPrompt(procedureId)).toBeUndefined();
    expect(app.services.procedures.get(procedureId)).toMatchObject({
      status: before.status,
      steps: before.steps,
      runtime: { activity: 'idle' },
    });
    const resumed = await app.rpc(
      'procedures.message',
      { procedureId, message: 'Continúa' },
      assistant.token,
    );
    expect(resumed.body.result).toEqual({ delivered: 'started' });
    await app.services.coordinator.settled();
    expect(agent!.client.prompts.at(-1)?.text).toBe('Continúa');
  });

  it('deleting a procedure stops its agent and cancels its questions', async () => {
    await withProvider();
    const { procedureId, agent } = await app.startProcedure();
    const call = app.rpc(
      'prompt.confirm',
      { confirmKind: 'action', title: 'x', message: 'y' },
      agent!.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    await app.invoke('procedures.delete', procedureId);
    expect(agent!.client.stopped).toBe(true);
    expect((await call).status).toBeGreaterThanOrEqual(400);
    expect(await app.invoke('procedures.list')).toEqual([]);
    expect(app.events.at(-1)).toEqual({ type: 'procedure.deleted', procedureId });
    // Its questions lived on its card: nothing is left in the conversation.
    expect(conversation().some((i) => i.type === 'prompt')).toBe(false);
  });
});

describe('pending forms across app restarts', () => {
  it('restores procedure and assistant forms and resumes with safe answers', async () => {
    await withProvider();
    const { procedureId, agent, assistant } = await app.startProcedure();
    const request = app.rpc(
      'prompt.form',
      {
        title: 'Elige un centro',
        fields: [
          { key: 'city', label: 'Ciudad', type: 'text', vaultKey: 'custom.city', required: true },
          { key: 'code', label: 'Código', type: 'secret' },
        ],
      },
      agent!.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const form = app.pendingPrompt(procedureId)!;
    const assistantRequest = app.rpc(
      'prompt.form',
      {
        title: 'Una pregunta',
        fields: [{ key: 'name', label: 'Nombre', type: 'text' }],
      },
      assistant.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(ASSISTANT_AGENT_ID));
    const assistantForm = app.pendingPrompt(ASSISTANT_AGENT_ID)!;
    await app.restart();
    await request;
    await assistantRequest;
    expect(app.services.agents.activeCount()).toBe(0);
    expect(app.services.procedures.get(procedureId)?.runtime).toMatchObject({
      activity: 'needs_user',
      prompts: [{ id: form.id, status: 'pending' }],
    });
    expect(app.services.conversation.state().activity).toBe('needs_user');
    expect(
      await app.invoke('chat.respond', form.id, {
        kind: 'form',
        values: { city: 'Sevilla', code: 'secret-code' },
        dismissed: false,
        savedToVault: ['city', 'code'],
      }),
    ).toBeUndefined();
    const delivery = app.agentFor(procedureId)!.client.prompts.at(-1)!.text;
    expect(delivery).toContain('Sevilla');
    expect(delivery).not.toContain('secret-code');
    expect(app.vault.listPersonal()).toContainEqual(
      expect.objectContaining({ key: 'custom.city', value: 'Sevilla' }),
    );
    expect(app.services.procedures.runtimeOf(procedureId).prompts).toBeUndefined();
    expect(
      await app.invoke('chat.respond', assistantForm.id, {
        kind: 'form',
        values: { name: 'Lucía' },
        dismissed: false,
        savedToVault: [],
      }),
    ).toBeUndefined();
    expect(app.agentFor(ASSISTANT_AGENT_ID)!.client.prompts.at(-1)!.text).toContain('Lucía');
    await app.restart();
    expect(app.services.procedures.runtimeOf(procedureId).prompts).toBeUndefined();
    expect(app.services.conversation.state().activity).toBe('idle');
    expect(app.services.procedures.findItem(procedureId, form.id)).toMatchObject({
      status: 'answered',
    });
  });

  it('keeps a phone call pending across a restart and sends its outcome to the agent', async () => {
    await withProvider();
    const { procedureId, agent } = await app.startProcedure();
    const request = app.rpc(
      'prompt.phoneCall',
      {
        title: 'Llama a EMASESA',
        organization: 'EMASESA',
        phoneNumber: '900 822 010',
        purpose: 'Cambiar el número de personas que viven en la casa.',
        questions: ['¿Qué papeles hacen falta?'],
      },
      agent!.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const call = app.pendingPrompt(procedureId)!;
    await app.restart();
    await request;
    expect(app.services.procedures.runtimeOf(procedureId).prompts).toMatchObject([
      { id: call.id, status: 'pending' },
    ]);
    await app.invoke('chat.respond', call.id, {
      kind: 'phone_call',
      outcome: 'done',
      transcript: 'Ellos: Hace falta el volante de empadronamiento.',
    });
    const delivery = app.agentFor(procedureId)!.client.prompts.at(-1)!.text;
    expect(delivery).toContain('restarted while waiting for this phone call');
    expect(delivery).toContain('volante de empadronamiento');
    expect(app.services.procedures.runtimeOf(procedureId).prompts).toBeUndefined();
  });

  it('recovers persisted forms after an interrupted run and honours explicit stop', async () => {
    await withProvider();
    const { procedureId } = await app.startProcedure();
    // Simulate items left on disk by an interrupted process, without live bridge requests.
    app.services.procedures.upsertItem(procedureId, {
      id: 'q_recover',
      createdAt: new Date().toISOString(),
      type: 'prompt',
      status: 'pending',
      procedureId,
      prompt: {
        kind: 'form',
        allowDismiss: false,
        title: 'Ciudad',
        fields: [{ key: 'city', label: 'Ciudad', type: 'text', required: false }],
      },
    });
    app.services.procedures.upsertItem(procedureId, {
      id: 'q_approval',
      createdAt: new Date().toISOString(),
      type: 'prompt',
      status: 'pending',
      procedureId,
      prompt: {
        kind: 'confirm',
        confirmKind: 'action',
        title: 'Enviar',
        message: 'Enviar solicitud',
      },
    });
    await app.services.procedures.flush();
    await app.restart();
    expect(app.services.procedures.runtimeOf(procedureId).prompts?.map((p) => p.id)).toEqual([
      'q_recover',
    ]);
    expect(app.services.procedures.findItem(procedureId, 'q_approval')).toMatchObject({
      status: 'cancelled',
    });
    await app.services.agents.abort(procedureId);
    await app.restart();
    expect(app.services.procedures.runtimeOf(procedureId).prompts).toBeUndefined();
    await expect(
      app.invoke('chat.respond', 'q_recover', {
        kind: 'form',
        values: { city: 'Sevilla' },
        dismissed: false,
        savedToVault: [],
      }),
    ).rejects.toThrow();
  });

  it('keeps a restored form pending if the agent cannot accept its answer', async () => {
    await withProvider();
    const { procedureId, agent } = await app.startProcedure();
    const request = app.rpc(
      'prompt.form',
      {
        title: 'Ciudad',
        fields: [{ key: 'city', label: 'Ciudad', type: 'text', required: false }],
      },
      agent!.token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const form = app.pendingPrompt(procedureId)!;
    await app.restart();
    await request;
    await app.invoke('providers.logout');
    await expect(
      app.invoke('chat.respond', form.id, {
        kind: 'form',
        values: { city: 'Sevilla' },
        dismissed: false,
        savedToVault: [],
      }),
    ).rejects.toThrow();
    expect(app.services.procedures.runtimeOf(procedureId).prompts).toMatchObject([
      { id: form.id, status: 'pending' },
    ]);
  });
});
