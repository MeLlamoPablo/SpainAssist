// Regenerates test/fixtures/pdf/tasas.pdf:
//   corepack pnpm exec tsx packages/agent/test/fixtures/make-pdf-fixture.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePdf } from '../helpers/pdf';

const dir = join(import.meta.dirname, 'pdf');
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, 'tasas.pdf'),
  makePdf(
    [
      ['Tasas de expedición del DNI', 'Renovación: 12,00 euros', 'Pago en efectivo o con tarjeta.'],
      ['Página de anexos', 'Familia numerosa: exento.'],
    ],
    'Tasas DNI (fixture)',
  ),
);
console.log('wrote', join(dir, 'tasas.pdf'));
