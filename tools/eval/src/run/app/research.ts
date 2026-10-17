/**
 * The recorded web research of a fixture (`tools/eval/fixtures/research/<name>.json`), in the
 * form the eval host's config takes (`HostEvalConfig.research.answers`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ResearchOutput } from '@sa/shared';
import { z } from 'zod';
import type { ResearchAnswer } from '../../contracts';

const RECORDING_FORMAT = 'sa-eval-research/1';

const Recording = z.looseObject({
  format: z.literal(RECORDING_FORMAT),
  run: z.looseObject({ id: z.uuid() }),
  output: ResearchOutput,
});

/** `tools/eval/fixtures/research`. */
function researchDir(): string {
  return join(import.meta.dirname, '..', '..', '..', 'fixtures', 'research');
}

/** Fixture names are file names: no separators, nothing that leaves the folder. */
const NAME = /^[a-z0-9][a-z0-9_-]*$/;

export function loadResearchAnswer(name: string, dir: string = researchDir()): ResearchAnswer {
  if (!NAME.test(name)) throw new Error(`Invalid research recording name "${name}"`);
  const file = join(dir, `${name}.json`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(
      `The research recording "${name}" is missing (${file}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = Recording.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`The research recording ${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return { id: parsed.data.run.id, output: parsed.data.output };
}
