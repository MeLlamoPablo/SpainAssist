import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuleSpec } from '@sa/mock-llm';
import type { ChatItem, ProcedureListItem, PromptItem } from '@sa/shared';
import { expect, type Harness, invoke, test } from '../fixtures';

/**
 * The app runs one conversation with the assistant (an orchestrator agent) and one agent per
 * procedure. Mock LLM rules tell them apart by the tools each declares: only the assistant has
 * procedure_start; only procedure agents have browser_open.
 */
const ASSISTANT = '^procedure_start$';
const PROCEDURE = '^browser_open$';

/** The assistant starts one procedure on the first message and relays its report. */
function assistantRules(title: string, brief: string, reply: string): RuleSpec[] {
  return [
    {
      when: { hasTool: ASSISTANT, lastUser: '^\\[Report from procedure' },
      reply: { text: reply },
    },
    {
      when: { hasTool: ASSISTANT, lastTool: 'procedure_start' },
      reply: { text: 'Me pongo con ello.' },
    },
    {
      when: { hasTool: ASSISTANT, turn: 0 },
      reply: { toolCalls: [{ name: 'procedure_start', arguments: { title, brief } }] },
    },
  ];
}

async function connect(h: Harness) {
  const result = await invoke(h.page, 'providers.redeemVoucher', 'SA-DEMO42');
  expect(result.ok).toBe(true);
  await invoke(h.page, 'settings.update', { onboardingCompleted: true });
}

async function attachDebug(h: Harness) {
  await test.info().attach('conversation.json', {
    body: JSON.stringify(await invoke(h.page, 'chat.transcript'), null, 2),
    contentType: 'application/json',
  });
  await test.info().attach('requests.json', {
    body: JSON.stringify(h.llm.requests(), null, 2),
    contentType: 'application/json',
  });
}

/** Waits for a procedure the assistant started. */
async function procedureTitled(h: Harness, title: string): Promise<ProcedureListItem> {
  let found: ProcedureListItem | undefined;
  try {
    await expect
      .poll(async () => {
        found = (await invoke(h.page, 'procedures.list')).find((p) => p.title === title);
        return Boolean(found);
      })
      .toBe(true);
  } catch (error) {
    await attachDebug(h);
    throw error;
  }
  return found as ProcedureListItem;
}

/** Waits for a question of a procedure's agent, in the conversation. */
async function pending(h: Harness, procedureId: string): Promise<PromptItem> {
  let found: PromptItem | undefined;
  try {
    await expect
      .poll(async () => {
        // A procedure's questions wait on its card (runtime), not in the conversation.
        found = (await invoke(h.page, 'procedures.get', procedureId))?.runtime.prompts?.[0];
        return Boolean(found);
      })
      .toBe(true);
  } catch (error) {
    await attachDebug(h);
    throw error;
  }
  return found as PromptItem;
}

async function idle(h: Harness, procedureId: string): Promise<ChatItem[]> {
  await expect
    .poll(async () => (await invoke(h.page, 'procedures.get', procedureId))?.runtime.activity)
    .toBe('idle');
  return invoke(h.page, 'procedures.log', procedureId);
}

async function assistantSaid(h: Harness, text: string) {
  try {
    await expect
      .poll(async () =>
        (await invoke(h.page, 'chat.transcript')).some(
          (i) => i.type === 'assistant' && i.status === 'complete' && i.text.includes(text),
        ),
      )
      .toBe(true);
  } catch (error) {
    await attachDebug(h);
    throw error;
  }
}

test('onboarding redeems a local voucher and the assistant answers in the one conversation', async ({
  harness: h,
}) => {
  await expect(h.page.getByTestId('onboarding')).toBeVisible();
  await h.page.getByTestId('onboarding-voucher').click();
  // `SA-` is a fixed prefix: a whole pasted code keeps only its 6 characters, uppercased.
  await h.page.getByTestId('voucher-input').fill('sa-demo42');
  await expect(h.page.getByTestId('voucher-input')).toHaveValue('DEMO42');
  // The voucher form has a single submit button; its copy is localized by the renderer.
  await h.page
    .getByTestId('voucher-input')
    .locator('xpath=ancestor::form')
    .locator('button[type="submit"]')
    .click();
  await expect.poll(async () => (await invoke(h.page, 'providers.status')).configured).toBe(true);
  await expect(h.page.getByRole('heading', { name: 'Añade tus datos', exact: true })).toBeVisible();
  await h.page.getByRole('button', { name: 'Empezar', exact: true }).click();

  // Empty app: the welcome splash in the chat and the empty state of "Mis trámites".
  await expect(h.page.getByTestId('chat-welcome')).toBeVisible();
  await expect(h.page.getByTestId('procedures-empty')).toBeVisible();
  await expect(h.page.getByTestId('credit-meter')).toBeVisible();

  const chat = h.page.getByTestId('chat-panel');
  await chat.getByRole('textbox').fill('Prueba de conversación local');
  await chat.getByTestId('composer-send').click();
  await expect(chat.getByText('Echo: Prueba de conversación local', { exact: true })).toBeVisible();
  await expect(h.page.getByTestId('chat-welcome')).toHaveCount(0);
  expect(await invoke(h.page, 'procedures.list')).toEqual([]);
  expect(h.llm.requests().some((req) => req.path === '/v1/chat/completions')).toBe(true);
});

test('the assistant delegates; the procedure asks on its card; its report comes back; all survives a restart', async ({
  harness: h,
}) => {
  await connect(h);
  h.llm.setScenario({
    name: 'delegate-form',
    rules: [
      ...assistantRules(
        'Trámite de prueba',
        'Investiga el trámite de prueba.',
        'Tu plan de prueba está listo.',
      ),
      {
        when: { hasTool: PROCEDURE, lastTool: 'ask_user' },
        reply: {
          toolCalls: [
            {
              name: 'procedure_update',
              arguments: {
                status: 'planned',
                facts: [{ label: 'Coste', value: 'Gratis' }],
                steps: [{ id: 'next', title: 'Revisar el plan', owner: 'user', status: 'current' }],
                nextAction: { text: 'Revisar el plan', owner: 'user' },
              },
            },
          ],
        },
      },
      {
        when: { hasTool: PROCEDURE, lastTool: 'procedure_update' },
        reply: { text: 'Plan listo; le toca revisarlo.' },
      },
      {
        when: { hasTool: PROCEDURE, lastTool: 'feedback_search' },
        reply: {
          toolCalls: [
            {
              name: 'ask_user',
              arguments: {
                title: 'Provincia para el trámite',
                fields: [
                  {
                    key: 'province',
                    label: 'Provincia',
                    type: 'text',
                    vaultKey: 'addressProvince',
                  },
                ],
              },
            },
          ],
        },
      },
      {
        when: { hasTool: PROCEDURE, turn: 0 },
        reply: {
          toolCalls: [{ name: 'feedback_search', arguments: { query: 'cita previa dni' } }],
        },
      },
    ],
  });

  const chat = h.page.getByTestId('chat-panel');
  await chat.getByRole('textbox').fill('Investiga el trámite de prueba');
  await chat.getByTestId('composer-send').click();
  const procedure = await procedureTitled(h, 'Trámite de prueba');
  const card = h.page.getByTestId(`procedure-card-${procedure.id}`);
  await expect(card).toBeVisible();

  // The procedure's agent asks directly on its card; the chat stays free.
  const prompt = await pending(h, procedure.id);
  const questions = card.getByTestId('card-questions');
  await expect(questions.getByText('Provincia para el trámite')).toBeVisible();
  await expect(card).toHaveAttribute('data-state', 'yourTurn');
  await expect(h.page.getByTestId('prompt-dock')).toHaveCount(0);
  await expect(chat.getByRole('textbox')).toBeVisible();
  // Nothing to skip: questions don't block the conversation.
  await expect(questions.getByRole('button', { name: 'Ahora no' })).toHaveCount(0);
  await questions.getByRole('combobox', { name: 'Provincia', exact: true }).fill('Madrid');
  await h.page.getByRole('option', { name: 'Madrid', exact: true }).click();
  await questions.locator('button[type="submit"]').click();
  await expect(card.getByTestId('card-questions')).toHaveCount(0);
  await expect
    .poll(async () =>
      (await invoke(h.page, 'procedures.log', procedure.id)).find((i) => i.id === prompt.id),
    )
    .toMatchObject({ status: 'answered' });
  expect((await invoke(h.page, 'chat.transcript')).some((i) => i.type === 'prompt')).toBe(false);

  // The procedure finishes; its short report reaches the assistant, which tells the user.
  const log = await idle(h, procedure.id);
  expect(log.some((i) => i.type === 'activity' && i.tool === 'feedback_search')).toBe(true);
  expect(log.some((i) => i.type === 'assistant' && i.text.includes('Plan listo'))).toBe(true);
  await assistantSaid(h, 'Tu plan de prueba está listo.');
  await expect(chat.getByTestId('procedure-event').filter({ hasText: 'Novedades' })).toBeVisible();
  const reports = h.llm
    .requests()
    .filter((r) => JSON.stringify(r.body).includes('[Report from procedure'));
  expect(reports.length).toBeGreaterThan(0);
  // The assistant never saw the procedure's tool calls or the form answer.
  const assistantRequests = h.llm
    .requests()
    .filter((r) => JSON.stringify(r.body).includes('"procedure_start"'));
  expect(JSON.stringify(assistantRequests)).not.toContain('feedback_search');
  expect(JSON.stringify(assistantRequests)).not.toContain('"Madrid"');

  expect(await invoke(h.page, 'procedures.get', procedure.id)).toMatchObject({
    status: 'planned',
    nextAction: { text: 'Revisar el plan', owner: 'user' },
  });
  await expect(card.getByTestId('card-facts')).toContainText('Gratis');
  await expect(card.getByTestId('card-steps')).toContainText('Revisar el plan');
  expect(
    (await invoke(h.page, 'vault.overview')).personal.some(
      (p) => p.key === 'addressProvince' && p.value === 'Madrid',
    ),
  ).toBe(true);

  await invoke(h.page, 'vault.addClave', {
    username: '99999999R',
    password: 'private-local-password',
  });
  const files = await readdir(join(h.userData, 'vault'));
  for (const file of files.filter((f) => f.endsWith('.bin'))) {
    expect(
      (await readFile(join(h.userData, 'vault', file))).includes(
        Buffer.from('private-local-password'),
      ),
    ).toBe(false);
  }

  await h.restart();
  expect((await invoke(h.page, 'procedures.get', procedure.id))?.title).toBe('Trámite de prueba');
  expect(
    (await invoke(h.page, 'chat.transcript')).some(
      (i) => i.type === 'assistant' && i.text.includes('Tu plan de prueba'),
    ),
  ).toBe(true);
  expect(
    (await invoke(h.page, 'procedures.log', procedure.id)).some(
      (i) => i.type === 'assistant' && i.text.includes('Plan listo'),
    ),
  ).toBe(true);
  await expect(h.page.getByTestId(`procedure-card-${procedure.id}`)).toBeVisible();
  expect(
    (await invoke(h.page, 'vault.overview')).credentials.some((c) => c.kind === 'clave_permanente'),
  ).toBe(true);
});

test('secret answers stay out of model requests and saved transcripts; stopping a procedure cancels its question', async ({
  harness: h,
}) => {
  await connect(h);
  h.llm.setScenario({
    name: 'secret-form',
    rules: [
      ...assistantRules('Prueba secreta', 'Entra en la sede de prueba.', 'Hecho.'),
      {
        when: { hasTool: PROCEDURE, lastTool: 'browser_fill_from_user' },
        reply: { text: 'Código escrito.' },
      },
      {
        when: {
          hasTool: PROCEDURE,
          lastTool: 'browser_click',
          // Not the Cl@ve password: browser_fill_from_user refuses it (browser_login_clave types it).
          lastToolResult: 'textbox "DNI o NIE[^"]*"[^\\n]*?\\[ref=(?<secretRef>[^\\]]+)\\]',
        },
        reply: {
          toolCalls: [
            {
              name: 'browser_fill_from_user',
              arguments: { ref: '{{secretRef}}', title: 'Código de prueba', label: 'Código' },
            },
          ],
        },
      },
      {
        when: {
          hasTool: PROCEDURE,
          lastTool: 'browser_open',
          lastToolResult: 'button "Acceso Cl@ve Permanente"[^\\n]*?\\[ref=(?<loginRef>[^\\]]+)\\]',
        },
        reply: { toolCalls: [{ name: 'browser_click', arguments: { ref: '{{loginRef}}' } }] },
      },
      {
        when: { hasTool: PROCEDURE, turn: 0 },
        reply: {
          toolCalls: [
            {
              name: 'browser_open',
              arguments: { url: `${h.sede.url}/tramites/residencia/solicitud/datos-personales` },
            },
          ],
        },
      },
    ],
  });
  await invoke(h.page, 'chat.send', { text: 'Prueba secreta' });
  const procedure = await procedureTitled(h, 'Prueba secreta');
  const prompt = await pending(h, procedure.id);
  await invoke(h.page, 'chat.respond', prompt.id, {
    kind: 'form',
    values: { value: 'secret-code-773311' },
    savedToVault: [],
    dismissed: false,
  });
  const log = await idle(h, procedure.id);
  await assistantSaid(h, 'Hecho.');
  expect(JSON.stringify(log)).not.toContain('secret-code-773311');
  expect(JSON.stringify(await invoke(h.page, 'chat.transcript'))).not.toContain(
    'secret-code-773311',
  );
  expect(JSON.stringify(h.llm.requests())).not.toContain('secret-code-773311');
  for (const file of [
    join(h.userData, 'procedures', procedure.id, 'transcript.json'),
    join(h.userData, 'assistant', 'transcript.json'),
  ]) {
    await expect.poll(async () => readFile(file, 'utf8').catch(() => '')).not.toBe('');
    expect(await readFile(file, 'utf8')).not.toContain('secret-code-773311');
  }

  // A second run of the same procedure waits on a question; the user stops it from its card.
  h.llm.setScenario({
    name: 'secret-again',
    rules: [
      {
        when: { hasTool: ASSISTANT, lastTool: 'procedure_message' },
        reply: { text: 'Se lo he pasado.' },
      },
      {
        when: { hasTool: ASSISTANT },
        reply: {
          toolCalls: [
            {
              name: 'procedure_message',
              arguments: { procedureId: procedure.id, message: 'Vuelve a entrar.' },
            },
          ],
        },
      },
      {
        when: { hasTool: PROCEDURE },
        reply: {
          toolCalls: [
            {
              name: 'confirm_action',
              arguments: { confirmKind: 'submission', title: 'Enviar', message: 'Voy a enviarlo.' },
            },
          ],
        },
      },
    ],
  });
  await invoke(h.page, 'chat.send', { text: 'Vuelve a intentarlo' });
  const waiting = await pending(h, procedure.id);
  const card = h.page.getByTestId(`procedure-card-${procedure.id}`);
  await expect(card).toHaveAttribute('data-state', 'yourTurn');
  await invoke(h.page, 'procedures.stop', procedure.id);
  await expect
    .poll(
      async () =>
        (await invoke(h.page, 'procedures.log', procedure.id)).find(
          (i): i is PromptItem => i.id === waiting.id && i.type === 'prompt',
        )?.status,
    )
    .toBe('cancelled');
  await idle(h, procedure.id);
});

test('a procedure agent opens the mock government site through the browser bridge', async ({
  harness: h,
}) => {
  await connect(h);
  h.llm.setScenario({
    name: 'browser',
    rules: [
      ...assistantRules('Abrir la sede', 'Abre la sede de prueba.', 'La sede está abierta.'),
      {
        when: { hasTool: PROCEDURE, lastTool: 'browser_open' },
        reply: {
          toolCalls: [
            {
              name: 'procedure_update',
              arguments: { sources: [{ title: 'Sede de prueba', url: h.sede.url }] },
            },
          ],
        },
      },
      {
        when: { hasTool: PROCEDURE, lastTool: 'procedure_update' },
        reply: { text: 'He abierto la sede de prueba.' },
      },
      {
        when: { hasTool: PROCEDURE, turn: 0 },
        reply: { toolCalls: [{ name: 'browser_open', arguments: { url: h.sede.url } }] },
      },
    ],
  });
  await invoke(h.page, 'chat.send', { text: 'Abre la sede de prueba' });
  const procedure = await procedureTitled(h, 'Abrir la sede');
  const log = await idle(h, procedure.id);
  expect(
    log.some((i) => i.type === 'activity' && i.tool === 'browser_open' && i.status === 'done'),
  ).toBe(true);
  await assistantSaid(h, 'La sede está abierta.');
  const requests = JSON.stringify(h.llm.requests());
  expect(requests).toContain('Sede');
  expect(requests).toContain(h.sede.url);
  expect(log.some((i) => i.type === 'notice' && i.level === 'error')).toBe(false);
  expect(
    (await invoke(h.page, 'chat.transcript')).some(
      (i) => i.type === 'notice' && i.level === 'error',
    ),
  ).toBe(false);

  // The card's details show what the user needs and the sources, not the agent's activity.
  const card = h.page.getByTestId(`procedure-card-${procedure.id}`);
  await card.getByTestId('card-details').click();
  await expect(card.getByRole('button', { name: 'Sede de prueba', exact: false })).toBeVisible();
  await expect(card.getByTestId('activity-log')).toHaveCount(0);
});
