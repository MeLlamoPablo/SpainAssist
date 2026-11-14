import { type BridgeMethod, UI_FAILED } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import type { BridgeCallOptions, BridgeTransport } from '../src/bridge/client';
import { WorkflowEngine } from '../src/codemode/engine';
import { createImageStore } from '../src/codemode/host-ops';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('WorkflowEngine', () => {
  it('dispatches events that came before their interface reopened, once it opens', async () => {
    // A resumed run replays (here a slow procedure call) before it presents its interface
    // again; the user's event, sent while no process ran it, is already queued in the app.
    let polls = 0;
    const ended: unknown[] = [];
    const bridge: BridgeTransport = {
      async call<M extends BridgeMethod>(method: M, params: unknown, options?: BridgeCallOptions) {
        const answer = async (): Promise<unknown> => {
          switch (method) {
            case 'workflow.begin':
              return {
                runId: 'run_1',
                resumed: true,
                procedures: [],
                state: { memo: {}, ui: { q: { status: 'open', rev: 1 } } },
              };
            case 'procs.getOrCreate':
              await sleep(300);
              return { id: 'p_aaaaaaaaaaaaaaaa' };
            case 'workflow.events':
              polls++;
              if (polls === 1)
                return {
                  events: [{ seq: 1, key: 'q', event: { handler: UI_FAILED, rev: 1, value: 'x' } }],
                };
              // Nothing more from the user: the poll stays open until the run ends.
              await new Promise((resolve) =>
                options?.signal?.addEventListener('abort', resolve, { once: true }),
              );
              return { events: [], ended: true };
            case 'workflow.end':
              ended.push((params as { outcome: unknown }).outcome);
              return {};
            default:
              return {};
          }
        };
        return (await answer()) as never;
      },
    };
    const engine = new WorkflowEngine({
      bridge,
      images: createImageStore(),
      imagesSupported: false,
      detachAfterMs: 10_000,
    });
    await engine.start({
      workflowId: 'wf',
      source: `export async function main(api) {
  await api.procedures.getOrCreate({ id: 'tramite', title: 'Trámite' });
  try {
    await api.ui.present('q', () => <Form title="¿Seguro?" />);
    return 'answered';
  } catch (e) {
    return 'heard: ' + e.message;
  }
}`,
    });
    // Before, the event waited for the next poll to return (25 s in the app).
    for (let i = 0; i < 60 && !ended.length; i++) await sleep(50);
    expect(ended).toEqual([expect.objectContaining({ status: 'succeeded', value: '"heard: x"' })]);
  });
});
