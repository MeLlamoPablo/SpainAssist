/** `eval list`: the fixtures, and the injection variants a SpainBench lists. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBenchTarget, runnable } from '../../bench';
import type { BenchVersion, Fixture } from '../../contracts';
import { INYECCION_ID, listFixtures } from '../../fixtures';
import { parseCommandArgs } from '../args';
import type { CliDeps } from '../deps';
import { messageOf } from '../exit';
import { columns, wrap } from '../format';
import { LIST_SPEC } from '../specs';

/** What the list knows about SpainBench. */
type BenchView =
  | { asked: true; version: BenchVersion; how: string }
  | { asked: false; reason: string };

const WIDTH = 96;

function ruleLines(label: string, descriptions: readonly string[]): string[] {
  const lines: string[] = [];
  descriptions.forEach((description, index) => {
    const head = index === 0 ? `      ${`${label}:`.padEnd(10)}` : `      ${' '.repeat(10)}`;
    lines.push(`${head}${wrap(description, WIDTH - 16, ' '.repeat(16))}`);
  });
  return lines;
}

function describeFixture(fixture: Fixture): string[] {
  const required = fixture.rules.filter((rule) => rule.kind === 'required');
  const scored = fixture.rules.filter((rule) => rule.kind === 'scored');
  const lines = [`      ${'prompt:'.padEnd(10)}${fixture.prompt}`];
  lines.push(
    ...ruleLines(
      'must',
      required.filter((rule) => !rule.negate).map((rule) => rule.description),
    ),
    ...ruleLines(
      'never',
      required.filter((rule) => rule.negate).map((rule) => rule.description),
    ),
  );
  lines.push(
    ...ruleLines('scored', scored.length > 0 ? [scored.map((rule) => rule.id).join(', ')] : []),
  );
  const needs = (fixture.preconditions ?? []).map((rule) => rule.description);
  lines.push(...ruleLines('needs', needs));
  return lines;
}

function verdictOf(fixture: Fixture, bench: BenchView): string {
  if (!bench.asked) return '';
  const verdict = runnable(fixture, bench.version);
  return verdict.ok ? '  [runnable]' : `  [NOT runnable: ${verdict.reason}]`;
}

/** The text of `eval list`. */
function renderList(bench: BenchView): string {
  const lines = ['Fixtures'];
  for (const fixture of listFixtures()) {
    lines.push(`  ${fixture.id}  ${fixture.title}${verdictOf(fixture, bench)}`);
    lines.push(...describeFixture(fixture));
  }
  lines.push('', `Injection variants (${INYECCION_ID}:<variant>; the plain id plants its default)`);
  if (bench.asked) {
    const variants = bench.version.injections;
    if (variants.length === 0) {
      lines.push('  SpainBench lists none: the injection fixture cannot run.');
    } else {
      lines.push(
        ...columns(variants.map((variant) => [`  ${INYECCION_ID}:${variant.id}`, variant.summary])),
      );
    }
    lines.push('', `SpainBench ${bench.version.version} (${bench.how}) was asked.`);
  } else {
    lines.push(
      `  Any variant id SpainBench lists works (for example ${INYECCION_ID}:page-title).`,
      `  ${wrap(`SpainBench was not asked: ${bench.reason}`, WIDTH - 2, '  ')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Asks the configured SpainBench for its version (starting it when needed, then stopping it). */
async function askBench(deps: CliDeps): Promise<BenchView> {
  let target: ReturnType<typeof resolveBenchTarget>;
  try {
    target = resolveBenchTarget(deps.env, { cwd: deps.cwd });
  } catch (error) {
    return { asked: false, reason: messageOf(error) };
  }
  if (target.mode === 'none') {
    return {
      asked: false,
      reason: 'set SPAINBENCH_DIR (the private repo) or SPAINBENCH_URL to ask it for the variants.',
    };
  }
  const logDir = mkdtempSync(join(tmpdir(), 'sa-eval-list-'));
  try {
    const server = await deps.openBench(target, { logFile: join(logDir, 'bench-server.log') });
    try {
      return {
        asked: true,
        version: server.version,
        how: server.mode === 'launch' ? 'started here' : 'connected',
      };
    } finally {
      await server.stop().catch(() => undefined);
    }
  } catch (error) {
    return { asked: false, reason: `it could not be reached: ${messageOf(error)}` };
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
}

export async function listCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  parseCommandArgs(LIST_SPEC, args, { min: 0, max: 0, names: '' });
  deps.stdout(renderList(await askBench(deps)));
  return 0;
}
