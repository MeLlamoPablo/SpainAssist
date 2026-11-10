/**
 * Codemode end to end: the real app (createHeadlessApp), the real agent host process with its
 * QuickJS workflows, the real bridge, and a scripted model. The user is played through the
 * renderer API, as the renderer would.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createMockLlm, type MockLlm } from '@sa/mock-llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findNode,
  handler,
  type LocalSite,
  openInterface,
  openRealApp,
  type RealApp,
  startLocalSite,
  waitFor,
} from '../../src/codemode/harness';
import { RENTA_PAGE, RENTA_QUESTION, rentaCodemodeScenario } from '../../src/codemode/renta';

let site: LocalSite;
let llm: MockLlm;
let real: RealApp;

beforeAll(async () => {
  // The app runs @sa/agent's dist/host.js: build it from the current sources.
  const agentRoot = dirname(createRequire(import.meta.url).resolve('@sa/agent/package.json'));
  execFileSync(process.execPath, [join(agentRoot, 'scripts', 'build-host.mjs')], { stdio: 'pipe' });
  site = await startLocalSite({ '/irpf/obligados': RENTA_PAGE });
  llm = await createMockLlm({ scenario: rentaCodemodeScenario(site.url) });
  real = await openRealApp({ llmBaseUrl: llm.baseUrl, codemode: true });
}, 120_000);

afterAll(async () => {
  await real?.close();
  await llm?.close();
  await site?.close();
});

describe('codemode end to end', () => {
  it('answers "¿tengo que hacer la renta?" through an agent with one workflow: the question at once, the decision without another turn', async () => {
    const { app } = real;
    await app.invoke('chat.send', { text: RENTA_QUESTION });

    const { workflow, tree, rev } = await openInterface(app, 'income');
    expect(workflow).toMatchObject({
      id: 'renta-obligacion',
      title: 'Saber si tienes que hacer la renta',
      status: 'waiting_user',
    });
    const procedures = await app.invoke('procedures.list');
    expect(procedures.map((p) => [p.title, p.status])).toEqual([
      ['Obligación de presentar la renta', 'researching'],
    ]);
    // The workflow records the procedure it serves (main only: the renderer never gets it).
    expect(app.services.codemode?.workflows.get(workflow.id)?.procedures).toEqual([
      procedures[0]?.id,
    ]);

    // The coordinator handed it to an agent, and both turns ended while the question waits.
    await waitFor(
      () =>
        app.services.conversation
          .transcript()
          .some((i) => i.type === 'assistant' && i.text.includes('Te he dejado una pregunta')),
      30_000,
      'the waiting message',
    );
    const turnsBeforeAnswer = llm.requests().length;

    await app.invoke('codemode.uiEvent', workflow.id, 'income', {
      handler: handler(findNode(tree, 'TextField'), 'onChange'),
      rev,
      value: '18000',
    });
    const updated = await waitFor(
      async () => {
        const ui = (await app.invoke('codemode.state')).workflows.find((w) => w.id === workflow.id)
          ?.ui[0];
        return ui && ui.rev > rev && findNode(ui.tree, 'Button', 'Seguir')?.props.disabled === false
          ? ui
          : undefined;
      },
      30_000,
      'the re-render',
    );
    await app.invoke('codemode.uiEvent', workflow.id, 'income', {
      handler: handler(findNode(updated.tree, 'Button', 'Seguir'), 'onClick'),
      rev: updated.rev,
    });

    const done = await waitFor(
      async () => {
        const p = (await app.invoke('procedures.list'))[0];
        return p?.status === 'done' ? p : undefined;
      },
      60_000,
      'the card done',
    );
    expect(done.summary).toBe('No tienes que presentar la declaración de 2025.');
    await waitFor(
      () =>
        app.services.conversation
          .transcript()
          .some((i) => i.type === 'assistant' && i.text.includes('22.000')),
      60_000,
      'the final answer',
    );

    // Model calls: the coordinator starts an agent and says so; the agent writes the workflow and
    // reports the question; the coordinator relays it; then the classifier, the agent's report and
    // the coordinator's final answer. Answering the question cost no workflow turn.
    const requests = llm.requests().filter((r) => r.path.endsWith('/chat/completions'));
    expect(requests).toHaveLength(8);
    expect(llm.requests().length - turnsBeforeAnswer).toBe(3);
    expect(requests.some((r) => JSON.stringify(r.body).includes('"name":"agent_start"'))).toBe(
      true,
    );
    expect(app.services.codemode?.workflows.get('renta-obligacion')).toMatchObject({
      status: 'succeeded',
    });
    expect(
      JSON.parse(app.services.codemode?.workflows.get('renta-obligacion')?.result ?? '{}'),
    ).toEqual({ verdict: 'no-exempt', income: 18000 });
  }, 180_000);
});
