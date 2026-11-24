import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeMethod } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import type { BridgeCallOptions, BridgeTransport } from '../src/bridge/client';
import { buildDeclarations } from '../src/codemode/declarations';
import { createHostOps, createImageStore, encodeTarget } from '../src/codemode/host-ops';
import { buildCodemodePrompt } from '../src/prompt/codemode';
import { buildCoordinatorPrompt } from '../src/prompt/coordinator';
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
  imagesSupported = true,
) {
  const { bridge, calls } = stubBridge(answers);
  const images = createImageStore();
  const call = createHostOps({
    bridge,
    images,
    procedures: () => procedures,
    imagesSupported,
  });
  const run = (op: string, args: unknown) =>
    call(op, args, { signal: new AbortController().signal });
  return { run, calls, images };
}

const PDF_DOCUMENT = {
  name: 'Tasas.pdf',
  mimeType: 'application/pdf',
  dataBase64: readFileSync(join(import.meta.dirname, 'fixtures', 'pdf', 'tasas.pdf')).toString(
    'base64',
  ),
};

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
  it('read a PDF whole, or one page with its image', async () => {
    const { run, images } = ops({ 'vault.document': PDF_DOCUMENT });
    const whole = (await run('documents.read', { name: 'Tasas' })) as Record<string, unknown>;
    expect(whole).toMatchObject({ name: 'Tasas.pdf', pages: 2 });
    expect(whole).not.toHaveProperty('id');
    expect(whole.text).toContain('Renovación: 12,00 euros');
    expect(whole.text).toContain('Familia numerosa: exento.');
    expect(whole).not.toHaveProperty('image');
    expect(whole).not.toHaveProperty('truncated');

    const second = (await run('documents.read', { name: 'Tasas.pdf', page: 2 })) as {
      text: string;
      pages: number;
      image: { imageId: string; mimeType: string };
    };
    expect(second.pages).toBe(2);
    expect(second.text).toContain('Familia numerosa: exento.');
    expect(second.text).not.toContain('Renovación');
    expect(second.image.mimeType).toBe('image/png');
    const png = Buffer.from(images.get(second.image.imageId)?.dataBase64 ?? '', 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    // A4 portrait: the longer side is the height.
    expect(png.readUInt32BE(20)).toBe(1600);

    await expect(run('documents.read', { name: 'Tasas.pdf', page: 3 })).rejects.toMatchObject({
      code: 'bad_request',
      message: "This PDF has 2 pages; page 3 doesn't exist.",
    });
  });

  it('fill a PDF where the agent pointed on its page images, and show the pages filled', async () => {
    const { run, calls } = ops({
      'vault.document': PDF_DOCUMENT,
      'vault.fillDocument': {
        name: 'Tasas (rellenado).pdf',
        pages: [2],
        warnings: ['Value 1 ("Ana"): written smaller to fit.'],
      },
    });
    const page = (await run('documents.read', { name: 'Tasas.pdf', page: 1 })) as {
      image: { width: number; height: number };
    };
    // US Letter portrait: 612 × 792 points, 1600 px high.
    expect(page.image).toMatchObject({ width: 1236, height: 1600 });

    const filled = await run('documents.fill', {
      name: 'Tasas.pdf',
      values: [
        { page: 1, x: 618.18, y: 400, text: 'Ana' },
        { page: 2, x: 0, y: 1600, check: true },
      ],
      copyName: 'Tasas rellenas',
    });
    const fill = calls.find((c) => c.method === 'vault.fillDocument');
    expect(fill).toMatchObject({
      procedureId: 'p_aaaaaaaaaaaaaaaa',
      params: { document: 'Tasas.pdf', name: 'Tasas rellenas' },
    });
    // The filled copy's pages come from the copy, by its name.
    expect(calls.filter((c) => c.method === 'vault.document').at(-1)?.params).toEqual({
      document: 'Tasas (rellenado).pdf',
    });
    const values =
      (fill?.params as { values: Record<string, unknown>[] } | undefined)?.values ?? [];
    expect(values[0]).toMatchObject({ page: 1, text: 'Ana' });
    expect(values[0]?.x).toBeCloseTo(0.5, 3);
    expect(values[0]?.y).toBeCloseTo(0.25, 3);
    expect(values[1]).toEqual({ page: 2, x: 0, y: 1, check: true });
    expect(filled).not.toHaveProperty('documentId');
    expect(filled).toMatchObject({
      name: 'Tasas (rellenado).pdf',
      pages: [{ page: 2, image: { mimeType: 'image/png', width: 1236, height: 1600 } }],
      warnings: ['Value 1 ("Ana"): written smaller to fit.'],
    });

    await expect(
      run('documents.fill', {
        name: 'Tasas.pdf',
        values: [{ page: 1, x: 1300, y: 10, text: 'x' }],
      }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: "Value 1: (1300, 10) is outside page 1's image (1236×1600 px).",
    });
    await expect(
      run('documents.fill', { name: 'Tasas.pdf', values: [{ page: 1, x: 10, y: 10 }] }),
    ).rejects.toMatchObject({ code: 'bad_request', message: 'Value 1: give text or check: true.' });
  });

  it('fill nothing for a model that cannot see the pages', async () => {
    const { run, calls } = ops({ 'vault.document': PDF_DOCUMENT }, undefined, false);
    await expect(
      run('documents.fill', { name: 'Tasas.pdf', values: [{ page: 1, x: 10, y: 10, text: 'x' }] }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect(calls).toEqual([]);
  });

  it('read a PDF page as text only for a model that cannot see images', async () => {
    const { run } = ops({ 'vault.document': PDF_DOCUMENT }, undefined, false);
    const page = await run('documents.read', { name: 'Tasas.pdf', page: 1 });
    expect(page).toMatchObject({ pages: 2 });
    expect(page).not.toHaveProperty('image');
  });

  it('act on the run’s procedure: its browser and its prompts', async () => {
    const { run, calls } = ops({
      'browser.type': OBSERVATION,
      'downloads.list': { downloads: OBSERVATION.downloads },
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
      // From the app's temporary downloads: a later run still finds them.
      { method: 'downloads.list', params: {}, procedureId: 'p_aaaaaaaaaaaaaaaa' },
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
      language: 'es',
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
    const d = buildDeclarations({
      language: 'es',
      search: true,
      feedback: { submit: true, vote: true },
    });
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
    const declarations = buildDeclarations({ language: 'es', search: true });
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

  it('gives an English user only English examples', () => {
    // Models copy the examples' language over any rule: Spanish ones made statuses, procedures
    // and replies Spanish for English users. Only official names stay in Spanish.
    const declarations = buildDeclarations({
      language: 'en',
      search: true,
      feedback: { submit: true, vote: true },
      dniePhone: true,
    });
    const prompts = [
      buildCodemodePrompt({
        language: 'en',
        research: 'exa',
        certificateRequests: true,
        declarations,
      }),
      buildCoordinatorPrompt({ language: 'en' }),
    ].join('\n');
    const officialNames = /"trámites"|Cl@ve Móvil|"Enviar petición"/g;
    expect(prompts.replace(officialNames, '')).not.toMatch(/[áéíóúñ¿¡]/);
    expect(prompts).not.toMatch(/Buscando|Gratis|Saltar|answer in theirs|Mis datos/);
    expect(prompts).toContain('"Checking the Correos page…"');
  });
});
