import type { BridgeMethod } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import type { BridgeCallOptions, BridgeTransport } from '../src/bridge/client';
import { buildDeclarations } from '../src/codemode/declarations';
import { createHostOps, createImageStore, encodeTarget } from '../src/codemode/host-ops';
import { buildCodemodePrompt } from '../src/prompt/codemode';
import { startRun } from './helpers/codemode';

/** A bridge that records calls and answers from a table. */
function stubBridge(answers: Partial<Record<BridgeMethod, unknown>> = {}) {
  const calls: { method: string; params: unknown; procedureId?: string }[] = [];
  const bridge: BridgeTransport = {
    async call(method, params, options?: BridgeCallOptions) {
      calls.push({
        method,
        params,
        ...(options?.procedureId ? { procedureId: options.procedureId } : {}),
      });
      return (answers[method] ?? {}) as never;
    },
  };
  return { bridge, calls };
}

const OBSERVATION = {
  url: 'https://sede.example.gob.es/cita',
  title: 'Cita previa',
  snapshot: '- button "Entrar" [ref=e1]',
  truncated: false,
  tabs: [],
  downloads: [{ downloadId: 'd1', name: 'justificante.pdf', mimeType: 'application/pdf' }],
  signatures: [],
  dialogs: [],
  pageErrors: [],
  notes: [],
};

function ops(
  answers: Partial<Record<BridgeMethod, unknown>> = {},
  procedures = ['p_aaaaaaaaaaaaaaaa'],
) {
  const { bridge, calls } = stubBridge(answers);
  const call = createHostOps({
    bridge,
    images: createImageStore(),
    runId: () => 'run_1',
    procedures: () => procedures,
    imagesSupported: true,
  });
  const run = (op: string, args: unknown) =>
    call(op, args, { signal: new AbortController().signal });
  return { run, calls };
}

describe('encodeTarget', () => {
  it('keeps refs as they are and sends locator chains as loc: JSON', () => {
    expect(encodeTarget([['ref', 'e12']])).toBe('e12');
    expect(encodeTarget([['getByRole', 'button', { name: 'Enviar' }], ['first']])).toBe(
      'loc:[["getByRole","button",{"name":"Enviar"}],["first"]]',
    );
    expect(() => encodeTarget([])).toThrow(/locator or a ref/);
  });
});

describe('host operations', () => {
  it('act on the workflow’s procedure: its browser and its prompts', async () => {
    const { run, calls } = ops({
      'browser.type': OBSERVATION,
      'prompt.confirm': { kind: 'confirm', approved: true },
    });
    const result = await run('browser.fill', {
      procedureId: 'p_aaaaaaaaaaaaaaaa',
      target: [['getByLabel', 'NIF', null]],
      value: '12345678Z',
      submit: false,
    });
    expect(result).toEqual({
      url: OBSERVATION.url,
      title: OBSERVATION.title,
      downloads: OBSERVATION.downloads,
      signatures: [],
      dialogs: [],
      notes: [],
      pageErrors: [],
    });
    expect(await run('browser.downloads', { procedureId: 'p_aaaaaaaaaaaaaaaa' })).toEqual(
      OBSERVATION.downloads,
    );
    expect(
      await run('user.confirm', { title: 'Enviar', message: 'Envío tu solicitud a la Policía' }),
    ).toEqual({
      kind: 'confirm',
      approved: true,
    });
    expect(calls).toEqual([
      {
        method: 'browser.type',
        params: { ref: 'loc:[["getByLabel","NIF",null]]', text: '12345678Z', submit: false },
        procedureId: 'p_aaaaaaaaaaaaaaaa',
      },
      {
        method: 'prompt.confirm',
        params: {
          confirmKind: 'action',
          title: 'Enviar',
          message: 'Envío tu solicitud a la Policía',
        },
        procedureId: 'p_aaaaaaaaaaaaaaaa',
      },
    ]);
  });

  it('return structured values: procedures, page reads, research', async () => {
    const { run, calls } = ops({
      'procs.list': { procedures: [{ id: 'p_1', title: 'DNI', version: 3 }] },
      'browser.query': { value: ['Madrid', 'Sevilla'] },
    });
    expect(await run('procedures.list', {})).toEqual([{ id: 'p_1', title: 'DNI', version: 3 }]);
    expect(
      await run('browser.allTextContents', {
        procedureId: 'p_aaaaaaaaaaaaaaaa',
        target: [['locator', 'select#oficina option', null]],
      }),
    ).toEqual(['Madrid', 'Sevilla']);
    expect(calls[1]).toEqual({
      method: 'browser.query',
      params: {
        target: 'loc:[["locator","select#oficina option",null]]',
        op: 'allTextContents',
        args: {},
      },
      procedureId: 'p_aaaaaaaaaaaaaaaa',
    });
  });

  it('refuse unknown operations without starting anything', async () => {
    const { run } = ops();
    await expect(run('shell.exec', {})).rejects.toMatchObject({
      code: 'bad_request',
      effect: 'not_started',
    });
  });
});

describe('the API declaration', () => {
  it('documents the agents’ API, compactly', () => {
    const d = buildDeclarations({
      search: true,
      feedback: { submit: true, vote: true },
      dniePhone: true,
    });
    expect(d).toContain('interface Api {');
    expect(d).toContain('browser: Browser;');
    expect(d).not.toContain('agents: Agents;');
    expect(d).not.toContain('classify');
    expect(d).not.toContain('subagents');
    // Measured, not guessed (docs/codemode.md): about 4 characters a token.
    expect(d.length).toBeLessThan(48_000);
  });

  it('every API in the declaration exists in the sandbox', async () => {
    const d = buildDeclarations({ search: true, feedback: { submit: true, vote: true } });
    const api = /interface Api \{([\s\S]*?)\n\}/.exec(d)?.[1] ?? '';
    const names = [...api.matchAll(/^ {2}(?:readonly )?(\w+)[(:?]/gm)].map((m) => m[1]);
    // Several namespaces on one line: "state: State; ui: Ui; …".
    for (const extra of api.matchAll(/; (\w+): [A-Z]\w*;/g)) names.push(extra[1]);
    const outcome = await startRun(
      `export async function main(api) { return ${JSON.stringify(names)}.filter((n) => { try { return api[n] === undefined; } catch (e) { return true; } }); }`,
    ).done;
    expect(outcome.status === 'succeeded' && JSON.parse(outcome.value ?? '')).toEqual([]);
  });

  it('goes into the agents’ system prompt with the rules', () => {
    const declarations = buildDeclarations({ search: true });
    const prompt = buildCodemodePrompt({
      language: 'es',
      research: 'web_research',
      declarations,
      now: new Date('2026-11-08T10:00:00Z'),
    });
    expect(prompt).toContain('Today is Sunday 2026-11-08 (Europe/Madrid).');
    expect(prompt).toContain('REPORT for the coordinator');
    expect(prompt).toContain('api.user.confirm');
    // The agent drives its own page and asks for approval only before binding steps.
    expect(prompt).toContain("You drive your procedure's page yourself.");
    expect(prompt).toContain('Nothing else needs approval');
    expect(prompt).not.toMatch(/subagent|Act only as the user/);
    expect(prompt.endsWith(`${declarations}\n\`\`\``)).toBe(true);
    // The coordinator never asks: agents narrow the request down and create the procedures.
    expect(prompt).toContain('the coordinator never asks them anything');
    expect(prompt).toContain('Never ask them to pick a version, format or login method');
    expect(prompt).toContain('Create the procedures with api.procedures.getOrCreate once you know');
    // Calling procedures "cards" made agents write "tarjeta" to the user (only paying by card stays).
    expect(prompt).not.toMatch(/\b(the|a|procedure|plan|several) cards?\b|card's|ProcedureCard/i);
  });
});
