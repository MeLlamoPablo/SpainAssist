/**
 * Writes `vectors/v1.json`: fixed inputs and the exact bytes the TypeScript channel produces
 * from them. The Kotlin app's tests check its implementation against this file, so both sides
 * stay byte-compatible. Run `corepack pnpm --filter @sa/companion vectors` after changing the
 * channel; `test/vectors.test.ts` fails while the file is out of date.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildVectors } from '../test/vectors';

const target = fileURLToPath(new URL('../vectors/v1.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(await buildVectors(), null, 2)}\n`);
console.log(`wrote ${target}`);
