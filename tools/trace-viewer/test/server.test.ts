import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readableSelector } from '../src/lib/playwright';
import { formatModule, openSource } from '../src/server/api';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('openSource', () => {
  it('lists only what traces are made of, never the vault, media, work files or logs', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sa-traces-'));
    const put = async (path: string) => {
      await mkdir(dirname(join(dir!, path)), { recursive: true });
      await writeFile(join(dir!, path), 'x');
    };
    for (const path of [
      'assistant/session-v2.jsonl',
      'assistant/work/notes.jsonl',
      'agents/a_1/session.jsonl',
      'agents/a_1/agent.json',
      'agents/a_1/state.json',
      'procedures/p_1/procedure.json',
      'procedures/p_1/media/shot.png',
      'procedures/p_1/capture/run/trace.zip',
      'procedures/p_1/capture/run/pages/0001.html',
      'vault/credentials.jsonl',
      'logs/main.log',
      '.hidden/session.jsonl',
      'settings.json',
    ])
      await put(path);
    expect(openSource(dir).files).toEqual([
      'agents/a_1/agent.json',
      'agents/a_1/session.jsonl',
      'assistant/session-v2.jsonl',
      'procedures/p_1/capture/run/trace.zip',
      'procedures/p_1/procedure.json',
    ]);
    expect(openSource(join(dir, 'agents/a_1/session.jsonl'))).toMatchObject({
      kind: 'file',
      files: ['session.jsonl'],
    });
  });
});

describe('readableSelector', () => {
  it('writes Playwright’s internal selectors as locators read', () => {
    expect(readableSelector('internal:role=button[name="Entrar"i]')).toBe('role=button "Entrar"');
    expect(readableSelector('internal:label="DNI o NIE"i')).toBe('label "DNI o NIE"');
    expect(readableSelector('#form >> internal:text="Continuar"s')).toBe(
      '#form › text "Continuar"',
    );
    expect(readableSelector('[name="oficina"]')).toBe('[name="oficina"]');
  });
});

describe('formatModule', () => {
  it('lays out a codemode module, and gives up on one that does not parse', async () => {
    expect(
      await formatModule(
        'export async function main(api) { const vault = await api.vault.read({}); return vault.documents.map(d => ({id: d.id, name: d.name})) }',
      ),
    ).toBe(
      [
        'export async function main(api) {',
        '  const vault = await api.vault.read({});',
        '  return vault.documents.map((d) => ({ id: d.id, name: d.name }));',
        '}',
        '',
      ].join('\n'),
    );
    expect(await formatModule('return 1 +')).toBeUndefined();
  });
});
