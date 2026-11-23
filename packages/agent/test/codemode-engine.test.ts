import { type BridgeMethod, UI_FAILED } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { type BridgeCallOptions, BridgeError, type BridgeTransport } from '../src/bridge/client';
import {
  type ResearchLog,
  RunEngine,
  type RunTrace,
  type RunTraceCall,
  unreturnedSearches,
} from '../src/codemode/engine';
import { createImageStore, RESEARCH_FIRST } from '../src/codemode/host-ops';
import { codemodeTool } from '../src/codemode/tool';
import type { AnyToolDefinition } from '../src/tools/common';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RunEngine', () => {
  it('dispatches events that came before their interface reopened, once it opens', async () => {
    // A resumed run replays (here a slow procedure call) before it presents its interface
    // again; the user's event, sent while no process ran it, is already queued in the app.
    let polls = 0;
    const ended: unknown[] = [];
    const bridge: BridgeTransport = {
      async call<M extends BridgeMethod>(method: M, params: unknown, options?: BridgeCallOptions) {
        const answer = async (): Promise<unknown> => {
          switch (method) {
            case 'run.begin':
              return {
                runId: 'run_1',
                procedures: [],
                state: { memo: {}, ui: { q: { status: 'open', rev: 1 } } },
              };
            case 'procs.getOrCreate':
              await sleep(300);
              return { id: 'p_aaaaaaaaaaaaaaaa' };
            case 'run.events':
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
            case 'run.end':
              ended.push((params as { outcome: unknown }).outcome);
              return {};
            default:
              return {};
          }
        };
        return (await answer()) as never;
      },
    };
    const engine = new RunEngine({
      bridge,
      images: createImageStore(),
      imagesSupported: false,
      detachAfterMs: 10_000,
    });
    await engine.start({
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

describe('run traces', () => {
  it('times each call of a run, failures with their error, and hands the trace over at its end', async () => {
    const traces: RunTrace[] = [];
    const bridge: BridgeTransport = {
      async call<M extends BridgeMethod>(method: M, _params: unknown, options?: BridgeCallOptions) {
        const answer = async (): Promise<unknown> => {
          switch (method) {
            case 'run.begin':
              return { runId: 'run_1', procedures: [], state: { memo: {}, ui: {} } };
            case 'procs.getOrCreate':
              await sleep(40);
              return { id: 'p_aaaaaaaaaaaaaaaa' };
            case 'browser.open':
              throw new BridgeError('policy_denied', 'Not an official domain', 'browser.open');
            case 'run.events':
              await new Promise((resolve) =>
                options?.signal?.addEventListener('abort', resolve, { once: true }),
              );
              return { events: [], ended: true };
            default:
              return {};
          }
        };
        return (await answer()) as never;
      },
    };
    const engine = new RunEngine({
      bridge,
      images: createImageStore(),
      imagesSupported: false,
      detachAfterMs: 10_000,
      onRunTrace: (trace) => traces.push(trace),
    });
    const outcome = await engine.start({
      title: 'Abrir la sede',
      source: `export async function main(api) {
  await api.procedures.getOrCreate({ id: 'tramite', title: 'Trámite' });
  const page = await api.browser.currentPage({ procedureId: 'p_aaaaaaaaaaaaaaaa' });
  try { await page.goto('https://example.com/x'); } catch {}
  return 'ok';
}`,
    });
    expect(outcome.status).toBe('succeeded');
    for (let i = 0; i < 40 && !traces.length; i++) await sleep(25);
    expect(traces).toEqual([
      expect.objectContaining({ runId: 'run_1', title: 'Abrir la sede', status: 'succeeded' }),
    ]);
    const [trace] = traces as [RunTrace];
    expect(trace.calls.map((c) => [c.op, c.label, c.error])).toEqual([
      ['procedures.getOrCreate', undefined, undefined],
      ['browser.goto', 'https://example.com/x', expect.stringContaining('Not an official domain')],
    ]);
    const [first, second] = trace.calls as [RunTraceCall, RunTraceCall];
    expect(first.result).toBe('{"id":"p_aaaaaaaaaaaaaaaa"}');
    expect(second.result).toBeUndefined();
    expect(first.ms).toBeGreaterThanOrEqual(35);
    expect(second.start).toBeGreaterThanOrEqual(first.start + first.ms);
    expect(trace.startedAt).toBeLessThanOrEqual(first.start);
    expect(trace.endedAt).toBeGreaterThanOrEqual(second.start + second.ms);
  });
});

describe('documents.create after research', () => {
  const FOUND = 'Un préstamo entre particulares se presenta con el Modelo 600 en 30 días hábiles.';

  /** An app that runs each module to its end (no interfaces) and records what it hears. */
  function setup(
    options: { researchLog?: ResearchLog; withResearch?: boolean; procedures?: string[] } = {},
  ) {
    const created: string[] = [];
    const linkedTo: (string | undefined)[] = [];
    const procedures = options.procedures ?? [];
    const ended: Record<string, unknown>[] = [];
    let run = 0;
    const bridge: BridgeTransport = {
      async call<M extends BridgeMethod>(method: M, params: unknown, options?: BridgeCallOptions) {
        const answer = async (): Promise<unknown> => {
          switch (method) {
            case 'run.begin':
              run++;
              return {
                runId: `run_${run}`,
                procedures,
                state: { memo: {}, ui: {} },
              };
            case 'vault.createDocument':
              created.push((params as { name: string }).name);
              linkedTo.push(options?.procedureId);
              return { documentId: 'doc_1', name: (params as { name: string }).name, pages: 1 };
            case 'run.events':
              await new Promise((resolve) =>
                options?.signal?.addEventListener('abort', resolve, { once: true }),
              );
              return { events: [], ended: true };
            case 'run.end':
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
    const engine = new RunEngine({
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
        {
          source: `export async function main(api) {
${body}
}`,
        },
        undefined,
        undefined,
        undefined as never,
      );
      return {
        text: (result.content as { text: string }[]).map((c) => c.text).join('\n'),
        isError: !!(result as { isError?: boolean }).isError,
      };
    };
    return { engine, runTool, created, linkedTo, ended };
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

  it("goes to the agent's latest procedure when the run touched none itself", async () => {
    // Run 1 made the card; run 2 writes the document before touching any procedure.
    const { runTool, linkedTo } = setup({
      withResearch: false,
      procedures: ['p_7dec0dd256376396'],
    });
    expect((await runTool(CREATE)).isError).toBe(false);
    expect(linkedTo).toEqual(['p_7dec0dd256376396']);
  });

  it("delivers a detached run's searches it didn't return with its outcome", async () => {
    const { engine, ended } = setup();
    const outcome = await engine.start(
      {
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

  it("can't be cut inside the module: slicing research gives it back whole", async () => {
    // Real runs wrote r.slice(0, 6000), research.slice(2800, 9000) and String(legal).slice(0, 1500).
    const { runTool } = setup({ withResearch: true });
    const result = await runTool(`
  const research = await api.search('préstamo');
  return {
    cut: research.slice(2800, 9000), sub: research.substring(0, 3), substr: research.substr(0, 3),
    viaString: String(research).slice(0, 1500), inTemplate: \`Notas: \${String(research).slice(0, 5)}\`,
    text: research + '', json: JSON.stringify({ research }), length: research.length,
    plain: String('abc').slice(0, 1), made: new String('ab').length, number: String(12),
  };`);
    expect(JSON.parse(result.text.replace(/^Run succeeded\.\n\nResult:\n/, ''))).toEqual({
      cut: FOUND,
      sub: FOUND,
      substr: FOUND,
      viaString: FOUND,
      inTemplate: `Notas: ${FOUND}`,
      text: FOUND,
      json: JSON.stringify({ research: FOUND }),
      length: FOUND.length,
      plain: 'a',
      made: 2,
      number: '12',
    });
  });

  it('cuts what main returns at the one result limit, in the tool result and in the message', async () => {
    const { runTool, engine, ended } = setup({ withResearch: false });
    const result = await runTool(`return 'x'.repeat(60_000);`);
    expect(result.text).toContain('… cut at 50000 characters: return less.');
    expect(result.text.length).toBeLessThan(50_100);
    await engine.start(
      { source: `export async function main(api) { return 'y'.repeat(60_000); }` },
      undefined,
      { detach: true },
    );
    for (let i = 0; i < 60 && !ended.length; i++) await sleep(50);
    expect(String(ended[0]?.value).length).toBe(50_000);
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

describe('output.image', () => {
  /** Saved photos the module reads; the first ones answer last, like the eval's parallel reads. */
  function setup() {
    const docs = ['doc_a', 'doc_b', 'doc_c', 'doc_d', 'doc_e', 'doc_f'];
    const bridge: BridgeTransport = {
      async call<M extends BridgeMethod>(method: M, params: unknown, options?: BridgeCallOptions) {
        const answer = async (): Promise<unknown> => {
          switch (method) {
            case 'run.begin':
              return { runId: 'run_1', procedures: [], state: { memo: {}, ui: {} } };
            case 'vault.document': {
              const id = (params as { documentId: string }).documentId;
              await sleep((docs.length - docs.indexOf(id)) * 15);
              return {
                id,
                name: `Foto ${id}.jpg`,
                mimeType: 'image/jpeg',
                dataBase64: Buffer.from(id).toString('base64'),
              };
            }
            case 'run.events':
              await new Promise((resolve) =>
                options?.signal?.addEventListener('abort', resolve, { once: true }),
              );
              return { events: [], ended: true };
            default:
              return {};
          }
        };
        return (await answer()) as never;
      },
    };
    const images = createImageStore();
    const engine = new RunEngine({ bridge, images, imagesSupported: true, detachAfterMs: 10_000 });
    const tool = codemodeTool({ engine, images, imagesSupported: true, language: 'es' });
    return async (body: string) => {
      const result = await tool.execute(
        'call',
        { source: `export async function main(api) {\n${body}\n}` },
        undefined,
        undefined,
        undefined as never,
      );
      // After the run's text: captions as they are, images as <their bytes>.
      return (
        result.content as ({ type: 'text'; text: string } | { type: 'image'; data: string })[]
      )
        .slice(1)
        .map((c) => (c.type === 'text' ? c.text : `<${Buffer.from(c.data, 'base64').toString()}>`));
    };
  }

  it('captions each image with its label and document, in the order they were shown', async () => {
    const run = setup();
    const shown = await run(`
  await Promise.all(['doc_a', 'doc_b', 'doc_c'].map(async (id, i) => {
    const r = await api.documents.read(id);
    api.output.image(r.image, i === 1 ? undefined : 'Foto ' + (i + 1));
  }));`);
    // doc_c finished first: the captions, not the order, say which image is which.
    expect(shown).toEqual([
      'Image 1: Foto 3 — document "Foto doc_c.jpg" (id doc_c)',
      '<doc_c>',
      'Image 2: document "Foto doc_b.jpg" (id doc_b)',
      '<doc_b>',
      'Image 3: Foto 1 — document "Foto doc_a.jpg" (id doc_a)',
      '<doc_a>',
    ]);
  });

  it('names the images past the limit instead of dropping them', async () => {
    const run = setup();
    const shown = await run(`
  for (const id of ['doc_a', 'doc_b', 'doc_c', 'doc_d', 'doc_e', 'doc_f'])
    api.output.image((await api.documents.read(id)).image, id);`);
    expect(shown.filter((s) => s.startsWith('<'))).toEqual([
      '<doc_a>',
      '<doc_b>',
      '<doc_c>',
      '<doc_d>',
    ]);
    expect(shown.at(-1)).toBe(
      'Not shown (at most 4 images per run; show the rest in another run):\n' +
        'Image 5: doc_e — document "Foto doc_e.jpg" (id doc_e)\n' +
        'Image 6: doc_f — document "Foto doc_f.jpg" (id doc_f)',
    );
  });
});
