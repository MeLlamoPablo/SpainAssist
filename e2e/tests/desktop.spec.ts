import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PromptItem } from '@sa/shared';
import { expect, invoke, test } from '../fixtures';
import {
  AGENT,
  agentIdle,
  agentRules,
  assistantSaid,
  COORDINATOR,
  codemodeCall,
  codemodeCalls,
  connect,
  coordinatorRules,
  openUi,
  pending,
  procedureTitled,
  savedTextFiles,
  theAgent,
} from '../helpers';

test('onboarding redeems a local voucher and the coordinator answers in the one conversation', async ({
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
  // The echo model repeats what the coordinator read: the user's words after the cards' header.
  await expect(chat.getByText(/^Echo: [\s\S]*Prueba de conversación local$/)).toBeVisible();
  await expect(h.page.getByTestId('chat-welcome')).toHaveCount(0);
  expect(await invoke(h.page, 'procedures.list')).toEqual([]);
  const requests = h.llm.requests().filter((req) => req.path === '/v1/chat/completions');
  expect(requests.length).toBeGreaterThan(0);
  // The chat's agent is the coordinator: it delegates with agent_* tools and never runs code.
  const tools = JSON.stringify(requests[0]?.body);
  expect(tools).toContain('"name":"agent_start"');
  expect(tools).not.toContain('"name":"codemode"');
});

test('the coordinator delegates; the agent asks in "Para ti"; its question survives a restart; the report comes back', async ({
  harness: h,
}) => {
  await connect(h);
  // The mock model's built-in demo (tools/mock-llm/src/scenarios.ts), as `pnpm dev` shows it.
  h.llm.setScenario('demo');

  const chat = h.page.getByTestId('chat-panel');
  await chat.getByRole('textbox').fill('Quiero renovar el DNI');
  await chat.getByTestId('composer-send').click();

  // The agent's workflow creates the card with its plan and asks above the cards.
  const procedure = await procedureTitled(h, 'Renovar el DNI');
  const card = h.page.getByTestId(`procedure-card-${procedure.id}`);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('card-facts')).toContainText('12 €');
  const question = h.page
    .getByTestId('for-you')
    .getByTestId('for-you-ui')
    .filter({ hasText: 'Dos datos para la cita del DNI' });
  await expect(question).toBeVisible();
  const { workflow } = await openUi(h, 'datos');
  expect(workflow).toMatchObject({ id: 'renovar-dni', status: 'waiting_user' });
  // The question is not on the card, and the chat stays free.
  await expect(card).not.toContainText('Dos datos');
  await expect(h.page.getByTestId('prompt-dock')).toHaveCount(0);
  await expect(chat.getByRole('textbox')).toBeEnabled();
  // The agent's turn ended while the question waits; the coordinator said so.
  await assistantSaid(h, 'Te he dejado dos preguntas');
  const agent = await theAgent(h);
  await agentIdle(h, agent.id, 'waiting_user');

  // The app quits before the user answers: the workflow keeps its state, its question comes back.
  await h.restart();
  await expect(h.page.getByTestId(`procedure-card-${procedure.id}`)).toBeVisible();
  const again = h.page
    .getByTestId('for-you-ui')
    .filter({ hasText: 'Dos datos para la cita del DNI' });
  await expect(again).toBeVisible();
  expect((await openUi(h, 'datos')).workflow.status).toBe('waiting_user');

  // Answering wakes the agent, whose host resumes the workflow without another model turn.
  await again.getByRole('combobox', { name: 'Provincia', exact: true }).fill('Madrid');
  await h.page.getByRole('option', { name: 'Madrid', exact: true }).click();
  await again.getByRole('button', { name: 'Seguir', exact: true }).click();
  await expect(h.page.getByTestId('for-you')).toHaveCount(0);

  // The workflow ends; the agent's report reaches the coordinator, which tells the user.
  await assistantSaid(h, 'tienes el plan en la tarjeta de **Renovar el DNI**');
  const restartedChat = h.page.getByTestId('chat-panel');
  await expect(restartedChat.getByTestId('procedure-event').first()).toBeVisible();
  expect(await invoke(h.page, 'procedures.get', procedure.id)).toMatchObject({
    status: 'planned',
    nextAction: { text: 'Pedir cita previa en citapreviadnie.es', owner: 'user' },
  });
  const restartedCard = h.page.getByTestId(`procedure-card-${procedure.id}`);
  await expect(restartedCard.getByTestId('card-next')).toContainText('Pedir cita previa');
  await restartedCard.getByTestId('card-details').click();
  await expect(restartedCard.getByTestId('card-steps')).toContainText(
    'Ir a la oficina y pagar la tasa',
  );
  expect(
    (await invoke(h.page, 'vault.overview')).personal.some(
      (p) => p.key === 'addressProvince' && p.value === 'Madrid',
    ),
  ).toBe(true);
  const log = await agentIdle(h, agent.id);
  expect(codemodeCalls(log)).toHaveLength(1);
  expect(
    log.some((i) => i.type === 'assistant' && i.text.includes('Esto es lo que tiene que hacer')),
  ).toBe(true);

  // The coordinator only read the reports: never the workflow, its interface or the answer.
  const coordinatorRequests = h.llm
    .requests()
    .filter((r) => JSON.stringify(r.body).includes('"name":"agent_start"'));
  expect(coordinatorRequests.length).toBeGreaterThan(0);
  const coordinatorRead = JSON.stringify(coordinatorRequests);
  expect(coordinatorRead).not.toContain('useDurableState');
  // Its prompt names the time zone (Europe/Madrid); the answer is nowhere else.
  expect(coordinatorRead.replaceAll('Europe/Madrid', '')).not.toContain('Madrid');

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

  // Everything survives another restart: the card, the chat, the agent's log, the vault.
  await h.restart();
  expect(await invoke(h.page, 'procedures.get', procedure.id)).toMatchObject({
    title: 'Renovar el DNI',
    status: 'planned',
  });
  await expect(h.page.getByTestId(`procedure-card-${procedure.id}`)).toBeVisible();
  await expect(h.page.getByTestId('for-you')).toHaveCount(0);
  expect(
    (await invoke(h.page, 'chat.transcript')).some(
      (i) => i.type === 'assistant' && i.text.includes('tienes el plan en la tarjeta'),
    ),
  ).toBe(true);
  expect(
    (await invoke(h.page, 'codemode.agentLog', agent.id)).some(
      (i) => i.type === 'assistant' && i.text.includes('Esto es lo que tiene que hacer'),
    ),
  ).toBe(true);
  expect(
    (await invoke(h.page, 'vault.overview')).credentials.some((c) => c.kind === 'clave_permanente'),
  ).toBe(true);
});

test('secret answers stay out of model requests and saved transcripts; stopping an agent cancels its question', async ({
  harness: h,
}) => {
  await connect(h);
  const secret = 'secret-code-773311';
  h.llm.setScenario({
    name: 'secret-form',
    rules: [
      ...coordinatorRules('Entra en la sede de prueba.', 'Hecho.', 'Código escrito'),
      ...agentRules(
        {
          workflow: 'sede-secreta',
          title: 'Entrar en la sede',
          // Not the Cl@ve password: fillFromUser refuses it (loginClave types it).
          source: `export async function main(api) {
  await api.procedures.getOrCreate({ id: 'sede', title: 'Prueba secreta', status: 'in_progress' });
  const page = await api.browser.currentPage();
  await page.goto('${h.sede.url}/tramites/residencia/solicitud/datos-personales');
  await page.getByRole('button', { name: 'Acceso Cl@ve Permanente' }).click();
  const dni = page.getByLabel('DNI o NIE');
  await dni.waitFor();
  await page.fillFromUser(dni, { title: 'Código de prueba', label: 'Código' });
  return { typed: true };
}
`,
        },
        'Código escrito.',
      ),
    ],
  });
  await invoke(h.page, 'chat.send', { text: 'Prueba secreta' });
  const procedure = await procedureTitled(h, 'Prueba secreta');
  // The app asks for the code itself, above the cards; the workflow never sees it.
  const prompt = await pending(h, procedure.id);
  await expect(h.page.getByTestId('for-you-prompt')).toContainText('Código de prueba');
  await invoke(h.page, 'chat.respond', prompt.id, {
    kind: 'form',
    values: { value: secret },
    savedToVault: [],
    dismissed: false,
  });
  await assistantSaid(h, 'Hecho.');
  const agent = await theAgent(h);
  const log = await agentIdle(h, agent.id);
  expect(codemodeCalls(log).map((c) => c.status)).toEqual(['done']);
  expect(JSON.stringify(log)).not.toContain(secret);
  expect(JSON.stringify(await invoke(h.page, 'procedures.log', procedure.id))).not.toContain(
    secret,
  );
  expect(JSON.stringify(await invoke(h.page, 'chat.transcript'))).not.toContain(secret);
  expect(JSON.stringify(h.llm.requests())).not.toContain(secret);
  for (const file of [
    join(h.userData, 'procedures', procedure.id, 'transcript.json'),
    join(h.userData, 'assistant', 'transcript.json'),
  ]) {
    await expect.poll(async () => readFile(file, 'utf8').catch(() => '')).not.toBe('');
  }
  const saved = await savedTextFiles(h.userData);
  expect([...saved.keys()].some((path) => path.includes(agent.id))).toBe(true);
  for (const [path, text] of saved) expect(text, path).not.toContain(secret);

  // The coordinator passes a new request on; the agent's next workflow waits for an approval,
  // and the user stops the agent.
  h.llm.setScenario({
    name: 'secret-again',
    rules: [
      {
        when: { hasTool: COORDINATOR, lastTool: 'agent_message' },
        reply: { text: 'Se lo he pasado.' },
      },
      {
        when: { hasTool: COORDINATOR, turn: 0 },
        reply: {
          toolCalls: [
            {
              name: 'agent_message',
              arguments: { agentId: agent.id, message: 'Vuelve a entrar.' },
            },
          ],
        },
      },
      {
        when: { hasTool: AGENT, lastUser: 'Vuelve a entrar' },
        reply: {
          toolCalls: [
            codemodeCall({
              workflow: 'enviar',
              title: 'Enviar la solicitud',
              source: `export async function main(api) {
  await api.procedures.getOrCreate({ id: '${procedure.id}', title: 'Prueba secreta' });
  const ok = await api.user.confirm({ kind: 'submission', title: 'Enviar', message: 'Voy a enviarlo.' });
  return { ok };
}
`,
            }),
          ],
        },
      },
    ],
  });
  await invoke(h.page, 'chat.send', { text: 'Vuelve a intentarlo' });
  const waiting = await pending(h, procedure.id);
  expect(waiting.prompt.kind).toBe('confirm');
  await expect(h.page.getByTestId('for-you-prompt')).toContainText('Voy a enviarlo.');
  await invoke(h.page, 'codemode.stopAgent', agent.id);
  await expect
    .poll(
      async () =>
        (await invoke(h.page, 'procedures.log', procedure.id)).find(
          (i): i is PromptItem => i.id === waiting.id && i.type === 'prompt',
        )?.status,
    )
    .toBe('cancelled');
  await expect(h.page.getByTestId('for-you')).toHaveCount(0);
  await agentIdle(h, agent.id);
});

test('an agent opens the mock government site through the browser bridge', async ({
  harness: h,
}) => {
  await connect(h);
  const url = h.sede.url;
  h.llm.setScenario({
    name: 'browser',
    rules: [
      ...coordinatorRules('Abre la sede de prueba.', 'La sede está abierta.', 'He abierto'),
      ...agentRules(
        {
          workflow: 'abrir-sede',
          title: 'Abrir la sede',
          source: `export async function main(api) {
  const card = await api.procedures.getOrCreate({ id: 'sede', title: 'Abrir la sede', status: 'researching' });
  const page = await api.browser.currentPage();
  await page.goto('${url}');
  const seen = await page.snapshot();
  await card.update({ sources: [{ title: 'Sede de prueba', url: '${url}' }] });
  return { url: seen.url, title: seen.title, tabs: seen.tabs.length };
}
`,
        },
        'He abierto la sede de prueba.',
      ),
    ],
  });
  await invoke(h.page, 'chat.send', { text: 'Abre la sede de prueba' });
  const procedure = await procedureTitled(h, 'Abrir la sede');
  await assistantSaid(h, 'La sede está abierta.');
  const agent = await theAgent(h);
  const log = await agentIdle(h, agent.id);
  expect(codemodeCalls(log).map((c) => c.status)).toEqual(['done']);
  // The workflow's result (what the page showed) reached the agent's model.
  const agentRequests = JSON.stringify(
    h.llm.requests().filter((r) => JSON.stringify(r.body).includes('"name":"codemode"')),
  );
  expect(agentRequests).toContain('succeeded');
  expect(agentRequests).toContain('Sede');
  expect(agentRequests).toContain(url);
  expect(log.some((i) => i.type === 'notice' && i.level === 'error')).toBe(false);
  expect(
    (await invoke(h.page, 'chat.transcript')).some(
      (i) => i.type === 'notice' && i.level === 'error',
    ),
  ).toBe(false);

  // The card's details show the sources, not the agent's activity.
  const card = h.page.getByTestId(`procedure-card-${procedure.id}`);
  await card.getByTestId('card-details').click();
  await expect(card.getByRole('button', { name: 'Sede de prueba', exact: false })).toBeVisible();
  await expect(card.getByTestId('activity-log')).toHaveCount(0);
});
