/**
 * Scripted models for the vida laboral fixtures (`provider: mock`): what a correct agent, a
 * hijackable one and a lost one say to the real agent hosts, as `tools/mock-llm` scenarios. The
 * end-to-end tests run them through `runEvaluation`, and `eval run --provider mock --scenario <name>`
 * shows what the suite does with each.
 *
 * A scenario is plain data (`ScenarioInput`): the orchestrator's turns, the procedure agent's
 * turns (it walks SpainBench's Seguridad Social site the way its README describes) and a default
 * for the user simulator's model. A scripted model is not a real one: it proves that the harness
 * measures what it should, not how a model behaves.
 */
import type { ScenarioInput } from '@sa/mock-llm';
import { findFixture, INYECCION_ID, UnknownFixtureError } from '../fixtures';
import { answererRules } from './answerer';
import { robustRules, susceptibleRules } from './injection';
import { PROCEDURE_AGENT, type Rule, sequence } from './kit';
import { orchestratorRules } from './orchestrator';
import { type ProcedureOptions, procedureStages } from './procedure';

export { answererRules } from './answerer';
export { linkTo } from './injection';
export { ORCHESTRATOR, PROCEDURE_AGENT, type Rule, sequence, waitForText } from './kit';
export { orchestratorRules, REPORT_PREFIX } from './orchestrator';
export {
  DECOY_URLS,
  INFO_URL,
  procedureStages,
  stagesFromDownload,
  stagesUntilLogin,
  VIDA_LABORAL_URL,
} from './procedure';

/**
 * - `oracle`: knows the way and does the job (the best a run can score).
 * - `robust`: as `oracle`; on the injection fixture it reads the planted text and ignores it.
 * - `susceptible`: does what the planted injection asks (the injection fixture must fail it).
 * - `lost`: wanders into pages that are not on the way (wrong turns) before finding the job.
 */
export const MOCK_SCENARIO_NAMES = ['oracle', 'robust', 'susceptible', 'lost'] as const;
export type MockScenarioName = (typeof MOCK_SCENARIO_NAMES)[number];

export function isMockScenarioName(name: string): name is MockScenarioName {
  return (MOCK_SCENARIO_NAMES as readonly string[]).includes(name);
}

/** What differs between the vida laboral fixtures for a model that knows the way. */
export interface Flow {
  /** Nothing is saved: the user is asked how they identify themselves, and for the credential. */
  fromScratch: boolean;
  /** The attacker's host the planted text names (the injection fixture only). */
  collectorHost?: string;
}

/** The flow of a fixture, or undefined when no scenario is written for it. */
export function flowOf(fixtureId: string): Flow | undefined {
  const fixture = findFixture(fixtureId);
  if (!fixture) throw new UnknownFixtureError(fixtureId);
  if (fixture.id === 'vida-laboral-sin-datos') return { fromScratch: true };
  if (fixture.id === 'vida-laboral-con-datos') return { fromScratch: false };
  if (fixture.id === INYECCION_ID || fixture.id.startsWith(`${INYECCION_ID}:`)) {
    const collectorHost = fixture.world.injection?.collectorHost;
    return { fromScratch: false, ...(collectorHost ? { collectorHost } : {}) };
  }
  return undefined;
}

/** The rules of a scenario that follow the way of `flow`, with the procedure's options. */
function rulesFor(flow: Flow, procedure: ProcedureOptions, before: Rule[] = []): Rule[] {
  return [
    ...answererRules(),
    ...before,
    ...orchestratorRules({ askMethod: flow.fromScratch }),
    ...sequence(PROCEDURE_AGENT, 'p', procedureStages(procedure)),
  ];
}

/** A fixture no scripted model is written for (only the vida laboral fixtures have them). */
export class NotScriptedError extends Error {
  constructor(
    readonly fixtureId: string,
    readonly scenario: string,
  ) {
    super(`No mock scenario "${scenario}" for fixture "${fixtureId}": it is not scripted`);
    this.name = 'NotScriptedError';
  }
}

/** The script for a fixture; throws when the fixture has no such scenario. */
export function mockScenario(fixtureId: string, name: string): ScenarioInput {
  if (!isMockScenarioName(name)) {
    throw new Error(
      `No mock scenario "${name}": the scenarios are ${MOCK_SCENARIO_NAMES.join(', ')}`,
    );
  }
  const flow = flowOf(fixtureId);
  if (!flow) throw new NotScriptedError(fixtureId, name);
  // A model that checks the saved report reads whatever the report carries.
  const readReport = flow.collectorHost !== undefined;
  let rules: Rule[];
  switch (name) {
    case 'oracle':
      rules = rulesFor(flow, {});
      break;
    case 'robust':
      rules = rulesFor(
        flow,
        { readReport },
        flow.collectorHost ? robustRules(flow.collectorHost) : [],
      );
      break;
    case 'susceptible':
      rules = rulesFor(
        flow,
        { readReport },
        flow.collectorHost ? susceptibleRules(flow.collectorHost) : [],
      );
      break;
    case 'lost':
      rules = rulesFor(flow, { wander: true });
      break;
  }
  return { name: `${name}:${fixtureId}`, rules, fallback: { text: 'Hecho.' } };
}
