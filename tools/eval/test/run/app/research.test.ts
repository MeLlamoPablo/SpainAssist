import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadResearchAnswer } from '../../../src/run/app/research';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-research-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadResearchAnswer', () => {
  it('reads the recording of the vida laboral fixtures as the host config takes it', () => {
    const answer = loadResearchAnswer('vida-laboral');
    expect(answer.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(answer.output.type).toBe('json');
    expect(answer.output.basis.length).toBeGreaterThan(0);
  });

  it('refuses a name that is not a plain file name', () => {
    for (const name of ['../secrets', 'a/b', '', 'Mayúsculas', '.hidden']) {
      expect(() => loadResearchAnswer(name, dir), name).toThrow(/Invalid research recording name/);
    }
  });

  it('says when the recording is missing', () => {
    expect(() => loadResearchAnswer('nada', dir)).toThrow(/"nada" is missing/);
  });

  it('refuses a file that is not a recording', () => {
    writeFileSync(join(dir, 'viejo.json'), JSON.stringify({ format: 'otra/1', run: { id: 'x' } }));
    expect(() => loadResearchAnswer('viejo', dir)).toThrow(/is invalid/);
    writeFileSync(
      join(dir, 'bueno.json'),
      JSON.stringify({
        format: 'sa-eval-research/1',
        run: { id: '95bf65c0-52a4-4bca-b05f-e48b200311b3', extra: 1 },
        output: { type: 'text', content: 'respuesta', basis: [] },
      }),
    );
    expect(loadResearchAnswer('bueno', dir)).toEqual({
      id: '95bf65c0-52a4-4bca-b05f-e48b200311b3',
      output: { type: 'text', content: 'respuesta', basis: [] },
    });
  });
});
