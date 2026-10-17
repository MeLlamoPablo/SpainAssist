/**
 * Quiescence across a hand-over: a procedure's report goes to the orchestrator, whose host may have
 * to start for it. In that gap no agent is running and nothing is pending, yet the run is not over.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HeadlessApp } from '@sa/desktop/headless';
import type { ScenarioInput } from '@sa/mock-llm';
import { ASSISTANT_AGENT_ID } from '@sa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvalAppWith } from '../../../src/run/app';
import { assistantRules } from './scripts';
import { expectNoEgress, prepareHostBundle, removeRunDir, startWorld, waitFor } from './support';

let host: Awaited<ReturnType<typeof prepareHostBundle>>;
beforeAll(async () => {
  host = await prepareHostBundle();
}, 180_000);
afterAll(() => host?.cleanup());
afterAll(expectNoEgress);

const procedure = { hasTool: '^procedure_update$' };

const scenario: ScenarioInput = {
  rules: [
    {
      when: { hasTool: '^procedure_start$', lastUser: 'Report from procedure' },
      reply: { text: 'Informe recibido.' },
    },
    ...assistantRules,
    // The procedure takes its time: the orchestrator's host is stopped meanwhile.
    { when: procedure, reply: { text: 'Terminado.', delayMs: 2500 } },
  ],
  fallback: { text: 'Hecho.' },
};

describe("a report that needs the orchestrator's host to start again", () => {
  it('is not idle until the orchestrator has answered it', async () => {
    const world = await startWorld({ hostBundle: host.bundle, scenario });
    let headless: HeadlessApp | undefined;
    const app = await createEvalAppWith(world.spec, world.deps, {
      hostBundle: { bundle: host.bundle, sources: [] },
      onApp: (created) => {
        headless = created;
      },
    });
    try {
      await app.send('sácame la vida laboral');
      await waitFor(
        () =>
          world.log
            .all()
            .some(
              (o) => o.type === 'assistant_message' && o.text === 'Empiezo con tu vida laboral.',
            ),
        'the orchestrator to start the procedure',
      );
      // The orchestrator is done and its host is gone (an app does this after ten idle minutes).
      await waitFor(
        () => !(headless as HeadlessApp).services.agents.isRunning(ASSISTANT_AGENT_ID),
        'the orchestrator to finish its run',
      );
      await (headless as HeadlessApp).services.agents.stop(ASSISTANT_AGENT_ID);
      expect(app.idle()).toBe(false);

      expect(await app.untilIdle({ holdMs: 300, timeoutMs: 90_000 })).toBe(true);
      // Idle means the report was handed over and answered, by a host that started for it.
      const said = world.log
        .all()
        .flatMap((o) =>
          o.type === 'assistant_message' && o.agent === 'assistant' ? [o.text] : [],
        );
      expect(said).toEqual(['Empiezo con tu vida laboral.', 'Informe recibido.']);
      expect(existsSync(join(world.runDir, 'net', 'host-assistant-2.jsonl'))).toBe(true);
      expect(existsSync(join(world.runDir, 'host', 'assistant-2.json'))).toBe(true);
    } finally {
      await app.close();
      world.run.close();
      await world.env.close();
      await world.bench.close();
      world.log.close();
      removeRunDir(world.runDir);
    }
  }, 180_000);
});
