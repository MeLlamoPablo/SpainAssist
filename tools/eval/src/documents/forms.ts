/**
 * Blank official forms, read from SpainBench (`SPAINBENCH_DIR/forms/`): real PDFs are captured
 * material, so they never live in this repo.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BlankFormSpec } from './spec';

/** Where a blank form is: SpainBench's `forms/` folder. Throws without `SPAINBENCH_DIR`. */
function blankFormPath(file: string): string {
  const dir = process.env.SPAINBENCH_DIR?.trim();
  if (!dir)
    throw new Error(
      `The blank form ${file} is a file of SpainBench: set SPAINBENCH_DIR to its checkout.`,
    );
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/.test(file)) throw new Error(`Invalid form file ${file}`);
  return resolve(dir, 'forms', file);
}

/** The form's bytes, checked against the SHA-256 the fixture pins. */
export function readBlankForm(spec: BlankFormSpec): Uint8Array {
  const bytes = readFileSync(blankFormPath(spec.file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== spec.sha256)
    throw new Error(`SpainBench's forms/${spec.file} is not the one the fixture pins (${sha256}).`);
  return new Uint8Array(bytes);
}
