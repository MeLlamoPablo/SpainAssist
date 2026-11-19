import { type BridgeMethod, UI_FAILED } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import type { BridgeCallOptions, BridgeTransport } from '../src/bridge/client';
import { type ResearchLog, unreturnedSearches, WorkflowEngine } from '../src/codemode/engine';
import { createImageStore, RESEARCH_FIRST } from '../src/codemode/host-ops';
import { codemodeTool } from '../src/codemode/tool';
import type { AnyToolDefinition } from '../src/tools/common';

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

describe('documents.create after research', () => {
  const FOUND = 'Un préstamo entre particulares se presenta con el Modelo 600 en 30 días hábiles.';

  /** An app that runs each workflow to its end (no interfaces) and records what it hears. */
  function setup(options: { researchLog?: ResearchLog; withResearch?: boolean } = {}) {
    const created: string[] = [];
    const ended: Record<string, unknown>[] = [];
    let run = 0;
    const bridge: BridgeTransport = {
      async call<M extends BridgeMethod>(method: M, params: unknown, options?: BridgeCallOptions) {
        const answer = async (): Promise<unknown> => {
          switch (method) {
            case 'workflow.begin':
              run++;
              return {
                runId: `run_${run}`,
                resumed: false,
                procedures: [],
                state: { memo: {}, ui: {} },
              };
            case 'vault.createDocument':
              created.push((params as { name: string }).name);
              return { documentId: 'doc_1', name: (params as { name: string }).name, pages: 1 };
            case 'workflow.events':
              await new Promise((resolve) =>
                options?.signal?.addEventListener('abort', resolve, { once: true }),
              );
              return { events: [], ended: true };
            case 'workflow.end':
              ended.push((params as { outcome: Record<string, unknown> }).outcome);
              return {};
            default:
              return {};
          }
        };
        return (await answer()) as never;
      },
    };
    const search = {
      name: 'web_research',
      execute: async () => ({ content: [{ type: 'text', text: FOUND }] }),
    } as unknown as AnyToolDefinition;
    const engine = new WorkflowEngine({
      bridge,
      images: createImageStore(),
      imagesSupported: false,
      detachAfterMs: 10_000,
      ...(options.withResearch === false
        ? {}
        : { research: { kind: 'web_research' as const, search } }),
      ...(options.researchLog ? { researchLog: options.researchLog } : {}),
    });
    const tool = codemodeTool({
      engine,
      images: createImageStore(),
      imagesSupported: false,
      language: 'es',
    });
    const runTool = async (body: string) => {
      const result = await tool.execute(
        'call',
        { workflow: 'contrato', source: `export async function main(api) {\n${body}\n}` },
        undefined,
        undefined,
        undefined as never,
      );
      return {
        text: (result.content as { text: string }[]).map((c) => c.text).join('\n'),
        isError: !!(result as { isError?: boolean }).isError,
      };
    };
    return { engine, runTool, created, ended };
  }

  const CREATE = `return await api.documents.create('Contrato de préstamo', '# Contrato');`;

  it('refuses without a search in an earlier run', async () => {
    const { runTool, created } = setup();
    const result = await runTool(CREATE);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(RESEARCH_FIRST);
    expect(created).toEqual([]);
  });

  it("refuses when the search is in the same run, and shows the search it didn't return", async () => {
    const { runTool, created } = setup();
    // Like the real run: the research only in notes, the document a fixed template.
    const result = await runTool(`
  const research = await api.state.memo('research', () => api.search('préstamo entre particulares'));
  const notes = { research };
  await api.documents.create('Contrato', '# Contrato');
  return 'done';`);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(RESEARCH_FIRST);
    expect(result.text).toContain("Searches main didn't return (read them):");
    expect(result.text).toContain('### api.search: préstamo entre particulares');
    expect(result.text).toContain(FOUND);
    expect(created).toEqual([]);
  });

  it('allows it once a search reached the model in an earlier run', async () => {
    const { runTool, created, engine } = setup();
    const research = await runTool(`return { research: await api.search('préstamo') };`);
    expect(research.isError).toBe(false);
    // It returned the search: not shown a second time.
    expect(research.text).not.toContain("Searches main didn't return");
    expect(engine.researched()).toBe(true);
    const result = await runTool(CREATE);
    expect(result.isError).toBe(false);
    expect(created).toEqual(['Contrato de préstamo']);
  });

  it('keeps it in the research log, for the next process', async () => {
    const entries: string[] = [];
    const log: ResearchLog = { has: () => entries.length > 0, add: () => entries.push('seen') };
    const first = setup({ researchLog: log });
    await first.runTool(`await api.search('préstamo');`);
    expect(entries).toEqual(['seen']);
    const second = setup({ researchLog: log });
    expect((await second.runTool(CREATE)).isError).toBe(false);
  });

  it('needs no search when research is not configured', async () => {
    const { runTool, created } = setup({ withResearch: false });
    expect((await runTool(CREATE)).isError).toBe(false);
    expect(created).toEqual(['Contrato de préstamo']);
  });

  it("delivers a detached run's searches it didn't return with its outcome", async () => {
    const { engine, ended } = setup();
    const outcome = await engine.start(
      {
        workflowId: 'largo',
        source: `export async function main(api) { await api.search('préstamo'); return 'ok'; }`,
      },
      undefined,
      { detach: true },
    );
    expect(outcome.status).toBe('detached');
    for (let i = 0; i < 60 && !ended.length; i++) await sleep(50);
    expect(ended).toEqual([
      expect.objectContaining({ status: 'succeeded', searches: expect.stringContaining(FOUND) }),
    ]);
    expect(engine.researched()).toBe(true);
  });
});

describe('unreturnedSearches', () => {
  const search = { query: 'q', text: 'Línea uno\n"citada"\n'.repeat(30) };

  it('finds a search returned whole, cut or inside an object', () => {
    expect(unreturnedSearches([search], search.text)).toBe('');
    expect(unreturnedSearches([search], search.text.slice(0, 300))).toBe('');
    expect(unreturnedSearches([search], JSON.stringify({ r: search.text }, null, 2))).toBe('');
    expect(unreturnedSearches([search], 'Result:\n"ok"')).toContain('### api.search: q');
  });

  it('cuts a long one', () => {
    const shown = unreturnedSearches([{ query: 'q', text: 'x'.repeat(10_000) }], '');
    expect(shown).toContain('6000 more characters: return it to read all.');
    expect(shown.length).toBeLessThan(4_200);
  });
});
