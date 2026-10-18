import { isEmptyMatcher, validateMatcher } from '../answers/matcher';
import { compilePattern } from '../answers/text';
import type { Answer, AnswerAction, Fixture, PromptKind } from '../contracts';
import { MIN_SECRET_LENGTH } from '../llm/redact';
import { validateRule } from '../rules/compile';
import { resolveScoring } from '../scoring/score';

const ID = /^[a-z0-9][a-z0-9_-]*(:[A-Za-z0-9][A-Za-z0-9_-]*)?$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The prompt kind each kind of answer action replies to. */
const ACTION_PROMPT_KIND: Record<AnswerAction['type'], PromptKind> = {
  select: 'form',
  values: 'form',
  typed: 'form',
  freeform: 'form',
  credential: 'credential',
  confirm: 'confirm',
  user_action: 'user_action',
};

/** Shorter values are not registered as secrets (they would mangle every log), so they are refused. */
const shortPassword = `a password shorter than ${MIN_SECRET_LENGTH} characters cannot be kept out of the logs`;

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function answerIssues(answer: Answer, where: string): string[] {
  const issues: string[] = [];
  if (!answer.id) issues.push(`${where}: missing id`);
  issues.push(...validateMatcher(answer.match, where));
  if (isEmptyMatcher(answer.match)) {
    issues.push(`${where}: the matcher is empty (it would answer every prompt)`);
  }
  const expected = ACTION_PROMPT_KIND[answer.action.type];
  if (!expected) {
    issues.push(`${where}: unknown action type`);
    return issues;
  }
  if (answer.match.kind !== expected) {
    issues.push(`${where}: a ${answer.action.type} action needs match.kind "${expected}"`);
  }
  const action = answer.action;
  switch (action.type) {
    case 'select':
      try {
        compilePattern(action.optionLabel, `${where}.action.optionLabel`);
      } catch (error) {
        issues.push((error as Error).message);
      }
      break;
    case 'values':
      if (Object.keys(action.values).length === 0) issues.push(`${where}: values is empty`);
      break;
    case 'typed':
      if (!action.value) issues.push(`${where}: a typed action needs a value`);
      break;
    case 'credential':
      if (!action.username || !action.password) {
        issues.push(`${where}: a credential action needs a username and a password`);
      } else if (action.password.length < MIN_SECRET_LENGTH) {
        issues.push(`${where}: ${shortPassword}`);
      }
      break;
    case 'freeform':
      if (!action.instructions.trim()) issues.push(`${where}: freeform instructions are empty`);
      break;
    default:
      break;
  }
  return issues;
}

/**
 * The secrets of a fixture: the passwords of its seeded Cl@ve credentials and of its credential
 * answers. They must never appear in text a model reads (prompt, persona, instructions, rule
 * descriptions), and the run registers them so every log masks them and `secretLeak` finds them.
 */
export function fixtureSecrets(fixture: Fixture): string[] {
  const secrets = new Set<string>();
  for (const clave of fixture.seed?.claves ?? []) secrets.add(clave.password);
  for (const group of fixture.answerGroups) {
    for (const answer of group.answers) {
      if (answer.action.type === 'credential') secrets.add(answer.action.password);
    }
  }
  return [...secrets].filter((secret) => secret.length >= MIN_SECRET_LENGTH);
}

/**
 * Problems of a fixture that would make a run meaningless or unsafe. Empty when it is fine:
 * well-formed ids, rules that compile, answers whose matchers and actions agree, persona and
 * instructions free of the fixture's secrets, positive limits, a usable world.
 */
export function validateFixture(fixture: Fixture): string[] {
  const issues: string[] = [];
  const where = `fixture ${fixture.id}`;
  if (!ID.test(fixture.id ?? '')) issues.push(`${where}: invalid id`);
  if (!fixture.title) issues.push(`${where}: missing title`);
  if (!fixture.prompt?.trim()) issues.push(`${where}: missing prompt`);
  if (!fixture.persona?.trim()) issues.push(`${where}: missing persona`);
  if (fixture.language !== undefined && fixture.language !== 'es' && fixture.language !== 'en') {
    issues.push(`${where}: language must be "es" or "en"`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(fixture.research ?? '')) {
    issues.push(`${where}: research must be a key such as "vida-laboral"`);
  }
  if (!['answerer', 'dismiss', 'fail'].includes(fixture.unexpectedPrompt)) {
    issues.push(`${where}: unexpectedPrompt must be "answerer", "dismiss" or "fail"`);
  }

  const { limits } = fixture;
  if (!Number.isFinite(limits?.wallClockMs) || limits.wallClockMs <= 0) {
    issues.push(`${where}: limits.wallClockMs must be positive`);
  }
  if (!Number.isFinite(limits?.maxCostUsd) || limits.maxCostUsd <= 0) {
    issues.push(`${where}: limits.maxCostUsd must be positive`);
  }
  for (const key of ['maxToolCalls', 'maxRequests', 'maxPrompts'] as const) {
    if (!positiveInteger(limits?.[key]))
      issues.push(`${where}: limits.${key} must be a positive integer`);
  }

  try {
    resolveScoring(fixture.scoring);
  } catch (error) {
    issues.push(`${where}: ${(error as Error).message}`);
  }

  const world = fixture.world;
  if (world.today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(world.today)) {
    issues.push(`${where}: world.today must be YYYY-MM-DD`);
  }
  if (world.seed !== undefined && !Number.isInteger(world.seed)) {
    issues.push(`${where}: world.seed must be an integer`);
  }
  if (world.sites !== undefined && (world.sites.length === 0 || world.sites.some((s) => !s))) {
    issues.push(`${where}: world.sites must list site ids`);
  }
  if (world.injection) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(world.injection.variant)) {
      issues.push(`${where}: invalid injection variant`);
    }
    if (!HOSTNAME.test(world.injection.collectorHost)) {
      issues.push(`${where}: injection.collectorHost must be a lowercase host name`);
    }
  }

  for (const [key, value] of Object.entries(fixture.seed?.personal ?? {})) {
    if (!key || typeof value !== 'string' || !value) {
      issues.push(`${where}: seed.personal.${key} must be a non-empty string`);
    }
  }
  for (const clave of fixture.seed?.claves ?? []) {
    if (!clave.username || !clave.password) {
      issues.push(`${where}: a seeded Cl@ve needs a username and a password`);
    } else if (clave.password.length < MIN_SECRET_LENGTH) {
      issues.push(`${where}: ${shortPassword}`);
    }
  }

  // Rules and preconditions.
  const ruleIds = new Set<string>();
  const all = [...fixture.rules, ...(fixture.preconditions ?? [])];
  for (const rule of all) {
    issues.push(...validateRule(rule).map((issue) => `${where}: ${issue}`));
    if (ruleIds.has(rule.id)) issues.push(`${where}: duplicate rule id "${rule.id}"`);
    ruleIds.add(rule.id);
  }
  if (!fixture.rules.some((rule) => rule.kind === 'required' && !rule.negate)) {
    issues.push(`${where}: needs a positive required rule (what the run must achieve)`);
  }

  // Answers.
  const answerIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const group of fixture.answerGroups) {
    if (!group.id || groupIds.has(group.id))
      issues.push(`${where}: duplicate group id "${group.id}"`);
    groupIds.add(group.id);
    for (const answer of group.answers) {
      if (answerIds.has(answer.id)) issues.push(`${where}: duplicate answer id "${answer.id}"`);
      answerIds.add(answer.id);
      issues.push(...answerIssues(answer, `${where}, answer ${answer.id}`));
    }
  }

  // Secrets only in structured answers and the seed, never in text a model reads.
  const modelText: [string, string][] = [
    ['prompt', fixture.prompt ?? ''],
    ['persona', fixture.persona ?? ''],
    ...fixture.rules.map((rule): [string, string] => [
      `rule ${rule.id} description`,
      rule.description,
    ]),
  ];
  for (const group of fixture.answerGroups) {
    for (const answer of group.answers) {
      if (answer.action.type === 'freeform') {
        modelText.push([`answer ${answer.id} instructions`, answer.action.instructions]);
      }
    }
  }
  for (const secret of fixtureSecrets(fixture)) {
    for (const [name, text] of modelText) {
      if (text.includes(secret))
        issues.push(`${where}: the ${name} contains a secret of the fixture`);
    }
  }
  return issues;
}

/** Returns the fixture, or throws one error that lists every problem. */
export function assertValidFixture(fixture: Fixture): Fixture {
  const issues = validateFixture(fixture);
  if (issues.length > 0) throw new Error(`Invalid fixture:\n- ${issues.join('\n- ')}`);
  return fixture;
}
