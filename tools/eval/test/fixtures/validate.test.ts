import { describe, expect, it } from 'vitest';
import type { Fixture } from '../../src/contracts';
import {
  assertValidFixture,
  CLAVE_PASSWORD,
  fixtureSecrets,
  getFixture,
  validateFixture,
} from '../../src/fixtures';

function clone(id = 'vida-laboral-sin-datos'): Fixture {
  // Rules hold regexes and functions, so only the plain parts are cloned.
  const base = getFixture(id);
  return {
    ...base,
    limits: { ...base.limits },
    world: { ...base.world },
    answerGroups: base.answerGroups.map((g) => ({ ...g, answers: [...g.answers] })),
    rules: [...base.rules],
  };
}

function issuesOf(change: (fixture: Fixture) => void, id?: string): string {
  const fixture = clone(id);
  change(fixture);
  return validateFixture(fixture).join('\n');
}

describe('validateFixture', () => {
  it('accepts the registered fixtures', () => {
    for (const id of [
      'vida-laboral-sin-datos',
      'vida-laboral-con-datos',
      'vida-laboral-inyeccion',
      'dni-renovacion-sin-datos',
      'dni-renovacion-caduca-pronto',
      'dni-renovacion-no-elegible',
    ]) {
      expect(validateFixture(getFixture(id)), id).toEqual([]);
    }
  });

  it('checks the basic fields', () => {
    expect(issuesOf((f) => (f.id = 'Bad Id'))).toContain('invalid id');
    expect(issuesOf((f) => (f.title = ''))).toContain('missing title');
    expect(issuesOf((f) => (f.prompt = ' '))).toContain('missing prompt');
    expect(issuesOf((f) => (f.persona = ''))).toContain('missing persona');
    expect(issuesOf((f) => (f.research = 'Vida Laboral!'))).toContain('research must be a key');
    expect(issuesOf((f) => (f.language = 'fr' as never))).toContain('language must be');
    expect(issuesOf((f) => (f.unexpectedPrompt = 'ignore' as never))).toContain('unexpectedPrompt');
  });

  it('checks the limits and the scoring config', () => {
    expect(issuesOf((f) => (f.limits.wallClockMs = 0))).toContain('wallClockMs');
    expect(issuesOf((f) => (f.limits.maxCostUsd = -1))).toContain('maxCostUsd');
    expect(issuesOf((f) => (f.limits.maxToolCalls = 1.5))).toContain('maxToolCalls');
    expect(issuesOf((f) => (f.limits.maxPrompts = 0))).toContain('maxPrompts');
    expect(issuesOf((f) => (f.scoring = { wrongTurnPenalty: 3 }))).toContain('wrongTurnPenalty');
  });

  it('checks the world', () => {
    expect(issuesOf((f) => (f.world = { today: '16/10/2026' }))).toContain('YYYY-MM-DD');
    expect(issuesOf((f) => (f.world = { seed: 1.5 }))).toContain('seed must be an integer');
    expect(issuesOf((f) => (f.world = { sites: [] }))).toContain('world.sites');
    expect(
      issuesOf((f) => (f.world = { injection: { variant: 'v 1', collectorHost: 'x.com' } })),
    ).toContain('invalid injection variant');
    expect(
      issuesOf(
        (f) =>
          (f.world = { injection: { variant: 'page-title', collectorHost: 'https://x.com/' } }),
      ),
    ).toContain('collectorHost');
    expect(
      issuesOf(
        (f) => (f.world = { injection: { variant: 'page-title', collectorHost: '127.0.0.1' } }),
      ),
    ).toContain('collectorHost');
  });

  it('checks the seed', () => {
    expect(issuesOf((f) => (f.seed = { personal: { givenName: '' } }))).toContain(
      'seed.personal.givenName',
    );
    expect(issuesOf((f) => (f.seed = { claves: [{ username: '', password: 'x' }] }))).toContain(
      'needs a username and a password',
    );
  });

  it('requires a positive required rule and unique rule ids', () => {
    expect(
      issuesOf((f) => (f.rules = f.rules.filter((r) => r.negate || r.kind !== 'required'))),
    ).toContain('needs a positive required rule');
    expect(issuesOf((f) => f.rules.push(f.rules[0]!))).toContain(
      'duplicate rule id "pdf-saved-complete"',
    );
    expect(
      issuesOf((f) =>
        f.rules.push({
          id: 'broken',
          description: 'x',
          kind: 'scored',
          condition: { type: 'all', of: [] },
        }),
      ),
    ).toContain('rule broken: all needs at least one condition');
  });

  it('checks the answers', () => {
    const answer = (extra: Partial<Fixture['answerGroups'][number]['answers'][number]>) =>
      ({
        id: 'a1',
        match: { kind: 'form' },
        action: { type: 'freeform', instructions: 'be brief' },
        ...extra,
      }) as Fixture['answerGroups'][number]['answers'][number];
    const withAnswer = (a: ReturnType<typeof answer>) => (f: Fixture) => {
      f.answerGroups = [{ id: 'g', answers: [a] }];
    };
    expect(issuesOf(withAnswer(answer({ match: {} })))).toContain('the matcher is empty');
    expect(issuesOf(withAnswer(answer({ match: { kind: 'form', text: '(' } })))).toContain(
      'invalid regular expression',
    );
    expect(issuesOf(withAnswer(answer({ match: { kind: 'confirm' } })))).toContain(
      'a freeform action needs match.kind "form"',
    );
    expect(
      issuesOf(
        withAnswer(
          answer({
            action: { type: 'credential', username: '', password: '' },
            match: { kind: 'credential' },
          }),
        ),
      ),
    ).toContain('needs a username and a password');
    expect(
      issuesOf(withAnswer(answer({ action: { type: 'freeform', instructions: ' ' } }))),
    ).toContain('instructions are empty');
    expect(issuesOf(withAnswer(answer({ action: { type: 'values', values: {} } })))).toContain(
      'values is empty',
    );
    expect(
      issuesOf(withAnswer(answer({ action: { type: 'select', optionLabel: '[' } }))),
    ).toContain('invalid regular expression');
    expect(issuesOf(withAnswer(answer({ action: { type: 'typed', value: 'SPAIN' } })))).toBe('');
    expect(issuesOf(withAnswer(answer({ action: { type: 'typed', value: '' } })))).toContain(
      'a typed action needs a value',
    );
    expect(
      issuesOf(
        withAnswer(
          answer({ action: { type: 'typed', value: 'SPAIN' }, match: { kind: 'user_action' } }),
        ),
      ),
    ).toContain('a typed action needs match.kind "form"');
    expect(
      issuesOf((f) => {
        f.answerGroups = [
          { id: 'g', answers: [answer({})] },
          { id: 'g', answers: [answer({})] },
        ];
      }),
    ).toMatch(/duplicate group id "g"[\s\S]*duplicate answer id "a1"/);
  });

  it('refuses secrets in anything a model reads', () => {
    const issues = issuesOf((f) => {
      f.persona = `${f.persona} Her password is SpainBench2026!`;
      f.prompt = 'sácame la vida laboral con SpainBench2026!';
      f.rules[0] = { ...f.rules[0]!, description: 'uses SpainBench2026!' };
      f.answerGroups = [
        {
          id: 'g',
          answers: [
            {
              id: 'ff',
              match: { kind: 'form' },
              action: { type: 'freeform', instructions: 'say SpainBench2026!' },
            },
            ...f.answerGroups.flatMap((g) => g.answers),
          ],
        },
      ];
    });
    expect(issues).toContain('the persona contains a secret');
    expect(issues).toContain('the prompt contains a secret');
    expect(issues).toContain('the rule pdf-saved-complete description contains a secret');
    expect(issues).toContain('the answer ff instructions contains a secret');
  });

  it('assertValidFixture throws one error with every problem', () => {
    const fixture = clone();
    fixture.title = '';
    fixture.prompt = '';
    expect(() => assertValidFixture(fixture)).toThrow(/missing title[\s\S]*missing prompt/);
    expect(assertValidFixture(getFixture('vida-laboral-con-datos'))).toBe(
      getFixture('vida-laboral-con-datos'),
    );
  });
});

describe('fixtureSecrets', () => {
  it('lists the passwords of the seeded credentials and of the credential answers, once', () => {
    expect(fixtureSecrets(getFixture('vida-laboral-sin-datos'))).toEqual([CLAVE_PASSWORD]);
    expect(fixtureSecrets(getFixture('vida-laboral-con-datos'))).toEqual([CLAVE_PASSWORD]);
    const both = clone('vida-laboral-con-datos');
    both.answerGroups = clone('vida-laboral-sin-datos').answerGroups;
    expect(fixtureSecrets(both)).toEqual([CLAVE_PASSWORD]);
  });

  it('is empty for a fixture without credentials and ignores very short values', () => {
    const none = clone();
    none.answerGroups = [];
    expect(fixtureSecrets(none)).toEqual([]);
    none.seed = { claves: [{ username: 'x', password: 'abc' }] };
    expect(fixtureSecrets(none)).toEqual([]);
  });
});
