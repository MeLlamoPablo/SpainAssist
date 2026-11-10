import { createMockLlm, type ScenarioInput } from '@sa/mock-llm';
import {
  findNode,
  handler,
  openInterface,
  openRealApp,
  type RealApp,
  startLocalSite,
  waitFor,
} from './harness';
import { RENTA_PAGE, RENTA_QUESTION, rentaCodemodeScenario } from './renta';

/**
 * The harness benchmark (docs/codemode.md, "Empirical verification"): the same task, the spec's
 * "¿tengo que hacer la renta?", through the classic harness and through codemode, in the real
 * app with the real agent hosts. The model is scripted (tools/mock-llm) with the shortest tool
 * sequence each harness's prompts call for, and every model call takes `llmDelayMs`; the
 * simulated user reads and answers the question in `thinkMs`.
 *
 * What it measures is the harness, not a model: how many model turns the task needs, how long
 * the user waits for the first question, and how long after answering until the answer arrives.
 */

export type Harness = 'classic' | 'codemode';

export interface BenchOptions {
  llmDelayMs: number;
  thinkMs: number;
}

export interface BenchResult {
  harness: Harness;
  /** Model requests of the whole task. */
  modelCalls: number;
  /** Model requests after the user answered (they wait for these). */
  callsAfterAnswer: number;
  /** From sending the message until the question is on screen. */
  timeToQuestionMs: number;
  /** From answering until the final answer is in the chat. */
  answerToResultMs: number;
  /** From sending the message until the final answer. */
  totalMs: number;
}

const ANSWER = 'No tienes que presentar la renta de 2025';
const CLASSIC_REPORT =
  'No está obligado: 18.000 € de un solo pagador, por debajo de 22.000 €. Tarjeta completada.';

/** The classic harness: the assistant starts a procedure; its agent researches, asks, decides. */
function rentaClassicScenario(siteUrl: string, llmDelayMs = 0): ScenarioInput {
  const reply = <T extends object>(r: T) => ({ ...r, delayMs: llmDelayMs });
  const assistant = '^You are Spain Assist\\.';
  const agent = 'procedure agents';
  return {
    rules: [
      {
        id: 'assistant: tells the user',
        when: { systemPrompt: assistant, lastUser: '\\[Report from procedure' },
        reply: reply({ text: `${ANSWER}: ganaste menos de **22.000 €** de un solo pagador.` }),
      },
      {
        id: 'assistant: waits',
        when: { systemPrompt: assistant, lastTool: 'procedure_start' },
        reply: reply({ text: 'Lo estoy comprobando; te aviso en cuanto lo sepa.' }),
      },
      {
        id: 'assistant: starts the procedure',
        when: { systemPrompt: assistant, lastUser: 'renta', hasTool: '^procedure_start$' },
        reply: reply({
          toolCalls: [
            {
              name: 'procedure_start',
              arguments: {
                title: 'Obligación de presentar la renta',
                brief:
                  'El usuario quiere saber si tiene que presentar la declaración de la renta de 2025.',
              },
            },
          ],
        }),
      },
      {
        id: 'agent: report',
        when: { systemPrompt: agent, lastTool: 'procedure_update', lastToolResult: 'Status: done' },
        reply: reply({ text: CLASSIC_REPORT }),
      },
      {
        id: 'agent: decides',
        when: { systemPrompt: agent, lastTool: 'ask_user' },
        reply: reply({
          toolCalls: [
            {
              name: 'procedure_update',
              arguments: {
                status: 'done',
                summary: 'No tienes que presentar la declaración de 2025.',
                facts: [{ label: 'Límite', value: '22.000 € de un solo pagador' }],
                sources: [{ title: 'Obligados a declarar', url: `${siteUrl}/irpf/obligados` }],
              },
            },
          ],
        }),
      },
      {
        id: 'agent: asks',
        when: {
          systemPrompt: agent,
          lastTool: 'procedure_update',
          lastToolResult: 'Status: researching',
        },
        reply: reply({
          toolCalls: [
            {
              name: 'ask_user',
              arguments: {
                title: '¿Cuánto ganaste en 2025?',
                fields: [
                  {
                    key: 'income',
                    label: 'Rendimientos del trabajo (€)',
                    type: 'number',
                    required: true,
                  },
                ],
              },
            },
          ],
        }),
      },
      {
        id: 'agent: card',
        when: { systemPrompt: agent, lastTool: 'fetch_url' },
        reply: reply({
          toolCalls: [
            {
              name: 'procedure_update',
              arguments: {
                status: 'researching',
                summary: 'Depende de lo que ganaste en 2025.',
                facts: [{ label: 'Límite', value: '22.000 € de un solo pagador' }],
              },
            },
          ],
        }),
      },
      {
        id: 'agent: research',
        when: { systemPrompt: agent, lastTool: 'vault_read' },
        reply: reply({
          toolCalls: [{ name: 'fetch_url', arguments: { url: `${siteUrl}/irpf/obligados` } }],
        }),
      },
      {
        id: 'agent: vault',
        when: { systemPrompt: agent, turn: 0 },
        reply: reply({ toolCalls: [{ name: 'vault_read', arguments: {} }] }),
      },
    ],
    fallback: { text: '(unexpected request)' },
  };
}

function finalAnswered(real: RealApp): boolean {
  return real.app.services.conversation
    .transcript()
    .some((i) => i.type === 'assistant' && i.status === 'complete' && i.text.includes(ANSWER));
}

export async function runRentaBenchmark(
  harness: Harness,
  options: BenchOptions,
): Promise<BenchResult> {
  const site = await startLocalSite({ '/irpf/obligados': RENTA_PAGE });
  const scenario =
    harness === 'codemode'
      ? rentaCodemodeScenario(site.url, options.llmDelayMs)
      : rentaClassicScenario(site.url, options.llmDelayMs);
  const llm = await createMockLlm({ scenario });
  const real = await openRealApp({ llmBaseUrl: llm.baseUrl, codemode: harness === 'codemode' });
  const calls = () => llm.requests().filter((r) => r.path.endsWith('/chat/completions')).length;
  try {
    const started = Date.now();
    await real.app.invoke('chat.send', { text: RENTA_QUESTION });
    let questionAt: number;
    let answeredAt: number;
    let callsAtAnswer: number;
    if (harness === 'codemode') {
      const { workflow, tree, rev } = await openInterface(real.app, 'income', 120_000);
      questionAt = Date.now();
      await new Promise((r) => setTimeout(r, options.thinkMs));
      await real.app.invoke('codemode.uiEvent', workflow.id, 'income', {
        handler: handler(findNode(tree, 'TextField'), 'onChange'),
        rev,
        value: '18000',
      });
      const ui = await waitFor(
        async () => {
          const open = (await real.app.invoke('codemode.state')).workflows.find(
            (w) => w.id === workflow.id,
          )?.ui[0];
          return open && open.rev > rev ? open : undefined;
        },
        30_000,
        'the re-render',
      );
      answeredAt = Date.now();
      callsAtAnswer = calls();
      await real.app.invoke('codemode.uiEvent', workflow.id, 'income', {
        handler: handler(findNode(ui.tree, 'Button', 'Seguir'), 'onClick'),
        rev: ui.rev,
      });
    } else {
      const pending = await waitFor(
        () => real.app.services.prompts.pendingItems()[0],
        120_000,
        'the question',
      );
      questionAt = Date.now();
      await new Promise((r) => setTimeout(r, options.thinkMs));
      answeredAt = Date.now();
      callsAtAnswer = calls();
      await real.app.invoke('chat.respond', pending.item.id, {
        kind: 'form',
        values: { income: '18000' },
        dismissed: false,
        savedToVault: [],
      });
    }
    await waitFor(() => finalAnswered(real) || undefined, 120_000, 'the final answer');
    const done = Date.now();
    return {
      harness,
      modelCalls: calls(),
      callsAfterAnswer: calls() - callsAtAnswer,
      timeToQuestionMs: questionAt - started,
      answerToResultMs: done - answeredAt,
      totalMs: done - started,
    };
  } finally {
    await real.close();
    await llm.close();
    await site.close();
  }
}

/** A markdown table of results (docs/codemode.md). */
export function benchTable(results: BenchResult[], options: BenchOptions): string {
  const rows = results.map(
    (r) =>
      `| ${r.harness} | ${r.modelCalls} | ${r.callsAfterAnswer} | ${(r.timeToQuestionMs / 1000).toFixed(1)} s | ${(r.answerToResultMs / 1000).toFixed(1)} s | ${(r.totalMs / 1000).toFixed(1)} s |`,
  );
  return [
    `Model latency ${options.llmDelayMs} ms per call, user answers in ${options.thinkMs} ms.`,
    '',
    '| Harness | Model calls | Calls after the answer | Time to the question | Answer → result | Total |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}
