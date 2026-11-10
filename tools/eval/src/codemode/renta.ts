import type { ScenarioInput } from '@sa/mock-llm';

/**
 * The spec's own example (docs/codemode.md): "¿tengo que presentar este año la declaración de la
 * renta?", which the coordinator hands to an agent, answered by the agent with one workflow: a
 * card, the income question shown at once while the official threshold is read in parallel, a
 * classifier, the card updated. The
 * scripted model writes exactly that workflow; what the test checks is the harness.
 */

export const RENTA_QUESTION = '¿Tengo que presentar este año la declaración de la renta?';

export const RENTA_PAGE = `<!doctype html><html lang="es"><head><title>Obligados a declarar - IRPF 2025</title></head>
<body><main><h1>¿Quién está obligado a declarar?</h1>
<p>Están obligados a presentar la declaración del IRPF los contribuyentes con rendimientos del trabajo superiores a 22.000 euros anuales cuando procedan de un solo pagador.</p>
<p>El límite es de 15.876 euros cuando hay más de un pagador y lo recibido del segundo y siguientes supera 1.500 euros.</p>
</main></body></html>`;

function rentaWorkflow(siteUrl: string): string {
  return `import { Form, TextField, Actions, Button, Text } from '@spainassist/ui';

function IncomeForm({ api }) {
  const [income, setIncome] = api.ui.useDurableState('income', '');
  return (
    <Form title="¿Cuánto ganaste en 2025?">
      <Text tone="muted">Lo que pone tu certificado de retenciones, sumando todos los pagadores.</Text>
      <TextField label="Rendimientos del trabajo (€)" type="number" value={income} onChange={setIncome} />
      <Actions>
        <Button type="secondary" onClick={() => api.ui.close({ result: 'skipped' })}>No lo sé</Button>
        <Button type="primary" disabled={!income} onClick={() => api.ui.close({ result: 'ok', income: Number(income) })}>Seguir</Button>
      </Actions>
    </Form>
  );
}

export async function main(api) {
  const procedure = await api.procedures.getOrCreate({
    id: 'obligatoriedad-renta',
    title: 'Obligación de presentar la renta',
    status: 'researching',
  });
  const [answer, page] = await api.parallelize([
    api.ui.present('income', () => <IncomeForm api={api} />),
    api.state.memo('umbral', () => api.fetchUrl('${siteUrl}/irpf/obligados')),
  ]);
  if (page.status === 'rejected') throw page.reason;
  if (answer.value.result === 'skipped') throw new Error('The user does not know their income: ask how to find it out.');
  const verdict = await api.classify({
    prompt: '<facts><user_income>' + answer.value.income + '</user_income><research>' + page.value.text + '</research></facts><question>Is this user obliged to file the IRPF Modelo 100?</question>',
    options: ['yes-obligated', 'no-exempt', 'unknown'],
  });
  if (verdict === 'unknown') throw new Error('Could not decide: investigate further.');
  await procedure.update({
    status: 'done',
    summary: verdict === 'no-exempt' ? 'No tienes que presentar la declaración de 2025.' : 'Tienes que presentar la declaración de 2025.',
    facts: [{ label: 'Límite', value: '22.000 € de un solo pagador' }],
    sources: [{ title: 'Obligados a declarar', url: '${siteUrl}/irpf/obligados' }],
  });
  return { verdict, income: answer.value.income };
}
`;
}

/** The scripted model of the codemode run. `llmDelayMs`: the latency of every model call. */
export function rentaCodemodeScenario(siteUrl: string, llmDelayMs = 0): ScenarioInput {
  const coordinator = '^You are Spain Assist\\.';
  const agent = "Spain Assist's background agents";
  return {
    rules: [
      {
        id: 'classifier',
        when: { systemPrompt: '^You classify' },
        reply: { text: 'no-exempt', delayMs: llmDelayMs },
      },
      {
        id: 'coordinator: final answer',
        when: {
          systemPrompt: coordinator,
          lastUser: '\\[Report from agent[\\s\\S]*No está obligado',
        },
        reply: {
          text: 'No tienes que presentar la renta de 2025: ganaste menos de **22.000 €** de un solo pagador.',
          delayMs: llmDelayMs,
        },
      },
      {
        id: 'coordinator: the question is up',
        when: { systemPrompt: coordinator, lastUser: '\\[Report from agent' },
        reply: { text: 'Te he dejado una pregunta para saberlo.', delayMs: llmDelayMs },
      },
      {
        id: 'coordinator: waits',
        when: { systemPrompt: coordinator, lastTool: 'agent_start' },
        reply: { text: 'Lo estoy comprobando.', delayMs: llmDelayMs },
      },
      {
        id: 'coordinator: starts an agent',
        when: { systemPrompt: coordinator, lastUser: 'renta', hasTool: '^agent_start$' },
        reply: {
          toolCalls: [
            {
              name: 'agent_start',
              arguments: {
                status: 'Comprobando si tienes que hacer la renta…',
                brief: '¿Tengo que presentar este año la declaración de la renta?',
              },
            },
          ],
          delayMs: llmDelayMs,
        },
      },
      {
        id: 'agent: report',
        when: { systemPrompt: agent, lastUser: '\\[Workflow "renta-obligacion".*succeeded' },
        reply: {
          text: 'No está obligado: ganó menos de 22.000 € de un solo pagador. Tarjeta completada.',
          delayMs: llmDelayMs,
        },
      },
      {
        id: 'agent: waiting',
        when: { systemPrompt: agent, lastTool: 'codemode', lastToolResult: 'waiting for the user' },
        reply: { text: 'Le he preguntado cuánto ganó en 2025.', delayMs: llmDelayMs },
      },
      {
        id: 'agent: workflow',
        when: { systemPrompt: agent, lastUser: 'renta', hasTool: '^codemode$' },
        reply: {
          toolCalls: [
            {
              name: 'codemode',
              arguments: {
                workflow: 'renta-obligacion',
                title: 'Saber si tienes que hacer la renta',
                source: rentaWorkflow(siteUrl),
              },
            },
          ],
          delayMs: llmDelayMs,
        },
      },
    ],
    fallback: { text: '(unexpected request)' },
  };
}
