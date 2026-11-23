import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatDuration, tickStep } from '../src/lib/format';
import { loadSource, type Source, sourceFromBytes } from '../src/lib/load';
import { type Span, walk } from '../src/lib/model';
import { parseSession, RUN_TRACE } from '../src/lib/pi';
import { readZip } from '../src/lib/zip';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name));

/** Shape of a span tree, for compact expectations. */
function shape(span: Span): unknown {
  return span.children.length
    ? { [`${span.kind}:${span.name}`]: span.children.map(shape) }
    : `${span.kind}:${span.name}`;
}

const t0 = Date.parse('2026-11-22T10:00:00.000Z');
const iso = (ms: number) => new Date(t0 + ms).toISOString();
const line = (entry: object) => JSON.stringify(entry);

describe('parseSession', () => {
  it('reads a session the agent host wrote: turns, model calls, tools and the run under its call', () => {
    // From the integration test of the real host (packages/agent/test/integration.test.ts).
    const root = parseSession(fixture('session.jsonl').toString(), { id: 's', title: 'Agent' });
    expect(shape(root)).toEqual({
      'agent:Agent': [
        {
          'turn:Hola, quiero renovar el DNI': [
            'llm:mock-model',
            { 'tool:codemode': [{ 'run:Run': ['op:vault.read', 'op:user.confirm'] }] },
            'llm:mock-model',
          ],
        },
      ],
    });
    const [turn] = root.children as [Span];
    const [llm, tool] = turn.children as [Span, Span];
    expect(llm).toMatchObject({ tokensIn: 8604, tokensOut: 85, status: 'ok' });
    expect(llm.detail).toBe('→ codemode');
    expect(tool.status).toBe('ok');
    expect(tool.input).toContain('api.vault.read');
    expect(tool.output).toContain('Run succeeded');
    for (const span of walk(root)) {
      expect(span.end).toBeGreaterThanOrEqual(span.start);
      expect(span.start).toBeGreaterThanOrEqual(root.start);
    }
  });

  it('keeps the active branch, marks failures and places a resumed run under its turn', () => {
    const text = [
      line({ type: 'session', version: 3, id: 'x', timestamp: iso(0) }),
      line({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: iso(0),
        message: { role: 'user', content: 'Primero', timestamp: t0 },
      }),
      line({
        type: 'message',
        id: 'old',
        parentId: 'u1',
        timestamp: iso(500),
        message: { role: 'user', content: 'Rebobinado', timestamp: t0 + 500 },
      }),
      line({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: iso(2_000),
        message: {
          role: 'assistant',
          model: 'm',
          timestamp: t0 + 100,
          stopReason: 'toolUse',
          content: [
            {
              type: 'toolCall',
              id: 'c1',
              name: 'codemode',
              arguments: { title: 'Abrir', source: 'x' },
            },
          ],
          usage: { input: 10, output: 5, cacheRead: 90, cost: { total: 0.01 } },
        },
      }),
      line({
        type: 'message',
        id: 'r1',
        parentId: 'a1',
        timestamp: iso(3_000),
        message: {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'codemode',
          isError: true,
          content: [{ type: 'text', text: 'Run failed: boom' }],
          details: { runId: 'run_1', status: 'failed' },
        },
      }),
      line({
        type: 'message',
        id: 'u2',
        parentId: 'r1',
        timestamp: iso(60_000),
        message: { role: 'user', content: 'Run run_2 ended', timestamp: t0 + 60_000 },
      }),
      line({
        type: 'custom',
        id: 'k1',
        parentId: 'u2',
        timestamp: iso(61_000),
        customType: RUN_TRACE,
        data: {
          runId: 'run_2',
          startedAt: t0 + 30_000,
          endedAt: t0 + 59_000,
          status: 'succeeded',
          calls: [{ op: 'ui', label: 'cita', start: t0 + 31_000, ms: 20_000 }],
        },
      }),
      line({
        type: 'message',
        id: 'a2',
        parentId: 'k1',
        timestamp: iso(62_000),
        message: {
          role: 'assistant',
          model: 'm',
          timestamp: t0 + 61_500,
          stopReason: 'error',
          errorMessage: 'Rate limited',
          content: [],
        },
      }),
    ].join('\n');
    const root = parseSession(text, { id: 's', title: 'Agent' });
    expect(shape(root)).toEqual({
      'agent:Agent': [
        {
          'turn:Primero': ['llm:m', 'tool:codemode', { 'run:Run': ['wait:Waiting for the user'] }],
        },
        { 'turn:Run run_2 ended': ['llm:m'] },
      ],
    });
    const [first, second] = root.children as [Span, Span];
    const [llm, tool] = first.children as [Span, Span];
    expect(llm).toMatchObject({ start: t0 + 100, end: t0 + 2_000, tokensIn: 100, cost: 0.01 });
    expect(llm.detail).toBe('→ codemode “Abrir”');
    expect(tool).toMatchObject({
      status: 'error',
      start: t0 + 2_000,
      end: t0 + 3_000,
      detail: 'Abrir',
    });
    // The run outlived the turn's last message: the turn covers it.
    expect(first.end).toBe(t0 + 59_000);
    expect(second.children[0]).toMatchObject({ status: 'error', error: 'Rate limited' });
    expect(root.end).toBe(t0 + 62_000);
  });

  it('shows what each call of a run gave the module', () => {
    const text = [
      line({ type: 'session', version: 3, id: 'x', timestamp: iso(0) }),
      line({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: iso(0),
        message: { role: 'user', content: 'Mira la página', timestamp: t0 },
      }),
      line({
        type: 'custom',
        id: 'k1',
        parentId: 'u1',
        timestamp: iso(2_000),
        customType: RUN_TRACE,
        data: {
          runId: 'run_1',
          startedAt: t0 + 100,
          endedAt: t0 + 1_000,
          status: 'succeeded',
          calls: [{ op: 'browser.snapshot', start: t0 + 200, ms: 35, result: '- heading "DGT"' }],
        },
      }),
    ].join('\n');
    const op = [...walk(parseSession(text, { id: 's', title: 'Agent' }))].find(
      (s) => s.kind === 'op',
    );
    expect(op?.output).toBe('- heading "DGT"');
  });
});

describe('Playwright traces', () => {
  it('reads calls, their errors and logs, and the screencast frames on the wall clock', async () => {
    const bytes = new Uint8Array(fixture('trace.zip'));
    const { traces } = await loadSource(sourceFromBytes('trace.zip', bytes));
    expect(traces).toHaveLength(1);
    const [trace] = traces as [(typeof traces)[0]];
    expect(trace.group).toBe('browser');
    const [browser] = trace.browser;
    expect(browser!.root.children.map((s) => s.name)).toEqual([
      'browserContext.newPage',
      'setContent',
      'fill',
      'click',
      'waitForTimeout',
    ]);
    const fill = browser!.root.children[2]!;
    expect(fill).toMatchObject({ status: 'ok', detail: '#q' });
    expect(fill.output).toContain("waiting for locator('#q')");
    // context-options wallTime anchors the monotonic times: the trace was made on 2026-11-21.
    expect(new Date(fill.start).getUTCFullYear()).toBe(2026);
    expect(browser!.frames.length).toBeGreaterThan(0);
    const jpeg = await browser!.frames[0]!.read();
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    for (const frame of browser!.frames) {
      expect(frame.at).toBeGreaterThanOrEqual(browser!.root.start);
      expect(frame.at).toBeLessThanOrEqual(browser!.root.end!);
    }
  });

  it('places a capture’s calls under the agent’s browser call that made them', async () => {
    const bytes = new Uint8Array(fixture('trace.zip'));
    const zip = readZip(bytes);
    // Find when the fill happened, then write an agent whose run did a browser.fill then.
    const probe = await loadSource(sourceFromBytes('trace.zip', bytes));
    const fill = probe.traces[0]!.root.children.find((s) => s.name === 'fill')!;
    const at = (ms: number) => new Date(fill.start + ms).toISOString();
    const session = [
      line({ type: 'session', version: 3, id: 'x', timestamp: at(-5_000) }),
      line({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: at(-5_000),
        message: { role: 'user', content: 'Busca', timestamp: fill.start - 5_000 },
      }),
      line({
        type: 'custom',
        id: 'k1',
        parentId: 'u1',
        timestamp: at(5_000),
        customType: RUN_TRACE,
        data: {
          runId: 'run_1',
          startedAt: fill.start - 1_000,
          endedAt: fill.start + 1_000,
          status: 'succeeded',
          calls: [
            {
              op: 'browser.fill',
              start: fill.start - 10,
              ms: (fill.end ?? fill.start) - fill.start + 12,
            },
          ],
        },
      }),
    ].join('\n');
    const files = new Map<string, Uint8Array>([
      ['agents/a_1/session.jsonl', new TextEncoder().encode(session)],
      [
        'agents/a_1/agent.json',
        new TextEncoder().encode(
          JSON.stringify({ status: 'Buscando', kind: 'worker', procedures: ['p_1'] }),
        ),
      ],
      ['agents/a_2/session.jsonl', new TextEncoder().encode(session)],
      [
        'agents/a_2/agent.json',
        new TextEncoder().encode(JSON.stringify({ status: 'Otro', procedures: ['p_2'] })),
      ],
      [
        'procedures/p_1/procedure.json',
        new TextEncoder().encode(JSON.stringify({ title: 'Cita DNI' })),
      ],
      ['procedures/p_1/capture/2026-11-22T10-09-52-123Z/trace.zip', bytes],
    ]);
    const source: Source = {
      name: 'profile',
      files: [...files.keys()],
      read: async (p) => files.get(p)!,
    };
    const { traces, problems } = await loadSource(source);
    expect(problems).toEqual([]);
    expect(traces.map((t) => [t.group, t.title])).toEqual([
      ['agent', 'Buscando'],
      ['agent', 'Otro'],
      ['browser', 'Cita DNI · 2026-11-22 10:09:52'],
    ]);
    const [agent, other] = traces as [(typeof traces)[0], (typeof traces)[0]];
    const op = [...walk(agent.root)].find((s) => s.kind === 'op')!;
    expect(op.children.map((s) => s.name)).toEqual(['fill']);
    expect(zip.names.length).toBeGreaterThan(0);
    expect(agent.browser.map((b) => b.id)).toEqual([
      'procedures/p_1/capture/2026-11-22T10-09-52-123Z/trace.zip',
    ]);
    // The other agent served another procedure.
    expect([...walk(other.root)].filter((s) => s.kind === 'browser')).toEqual([]);
  });
});

describe('format', () => {
  it('writes durations compactly and picks round axis steps', () => {
    expect(
      ['0.4', '850', '1234', '12345', '83000', '7260000'].map((ms) => formatDuration(Number(ms))),
    ).toEqual(['<1ms', '850ms', '1.23s', '12.3s', '1m 23s', '2h 1m']);
    expect(tickStep(10_000, 8)).toBe(2_000);
    expect(tickStep(95_000, 8)).toBe(15_000);
  });
});
