import type { Fixture } from '../contracts';
import {
  dniRenovacionCaducaPronto,
  dniRenovacionNoElegible,
  dniRenovacionSinDatos,
} from './dni-renovacion';
import { assertValidFixture } from './validate';
import {
  createInjectionFixture,
  INJECTION_VARIANT_PATTERN,
  INJECTION_VARIANTS,
  INYECCION_ID,
  vidaLaboralConDatos,
  vidaLaboralSinDatos,
} from './vida-laboral';

/**
 * The fixtures of the default full run, in the order of docs/EVAL.md: fixtures 1 and 2, fixture 3
 * once per injection variant, then the DNI renewal fixtures 4 to 6.
 */
const BASE: readonly Fixture[] = [
  vidaLaboralSinDatos(),
  vidaLaboralConDatos(),
  ...INJECTION_VARIANTS.map((variant) => createInjectionFixture(variant)),
  dniRenovacionSinDatos(),
  dniRenovacionCaducaPronto(),
  dniRenovacionNoElegible(),
].map(assertValidFixture);

const byId = new Map(
  [...BASE, assertValidFixture(createInjectionFixture())].map((fixture) => [fixture.id, fixture]),
);
const variants = new Map<string, Fixture>();

/**
 * Ids of the registered fixtures: what `eval suite` plays without arguments. The plain
 * `vida-laboral-inyeccion` (its default variant) and any `vida-laboral-inyeccion:<variant>`
 * SpainBench lists are also available.
 */
export const FIXTURE_IDS: readonly string[] = BASE.map((fixture) => fixture.id);

export class UnknownFixtureError extends Error {
  constructor(readonly id: string) {
    super(
      `Unknown fixture "${id}". Known: ${FIXTURE_IDS.join(', ')} (and ${INYECCION_ID}:<variant>).`,
    );
    this.name = 'UnknownFixtureError';
  }
}

/** The injection variant of a dynamic fixture id (`vida-laboral-inyeccion:page-title` -> `page-title`). */
export function injectionVariantOf(id: string): string | undefined {
  const prefix = `${INYECCION_ID}:`;
  if (!id.startsWith(prefix)) return undefined;
  const variant = id.slice(prefix.length);
  return INJECTION_VARIANT_PATTERN.test(variant) ? variant : undefined;
}

/** The fixture with this id, or undefined. Treat the result as read-only: it is shared. */
export function findFixture(id: string): Fixture | undefined {
  const known = byId.get(id);
  if (known) return known;
  const variant = injectionVariantOf(id);
  if (variant === undefined) return undefined;
  let fixture = variants.get(id);
  if (!fixture) {
    fixture = assertValidFixture(createInjectionFixture(variant));
    variants.set(id, fixture);
  }
  return fixture;
}

/** The fixture with this id. Throws `UnknownFixtureError` when there is none. */
export function getFixture(id: string): Fixture {
  const fixture = findFixture(id);
  if (!fixture) throw new UnknownFixtureError(id);
  return fixture;
}

/** The registered fixtures: the default full run (not the plain injection id, nor other variants). */
export function listFixtures(): Fixture[] {
  return [...BASE];
}
