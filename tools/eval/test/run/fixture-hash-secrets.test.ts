import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Fixture } from '../../src/contracts';
import { getFixture } from '../../src/fixtures';
import { fixtureHash } from '../../src/run/results';

/**
 * The hash in run.json identifies the fixture; it must not be a function of its passwords, or
 * anybody with the run.json and the public fixture could test password guesses offline.
 */
describe('the fixture hash and its secrets', () => {
  const PASSWORD = 'SpainBench2026!';
  const conDatos = () => getFixture('vida-laboral-con-datos');

  /** The fixture with `password` as every password in it, also written into a rule's regex. */
  const withPassword = (password: string): Fixture => {
    const fixture = conDatos();
    return {
      ...fixture,
      seed: {
        ...fixture.seed,
        claves: fixture.seed?.claves?.map((clave) => ({ ...clave, password })),
      },
      answerGroups: fixture.answerGroups.map((group) => ({
        ...group,
        answers: group.answers.map((answer) =>
          answer.action.type === 'credential'
            ? { ...answer, action: { ...answer.action, password } }
            : answer,
        ),
      })),
      rules: [
        ...fixture.rules,
        {
          id: 'mentions-password',
          description: 'x',
          kind: 'scored',
          condition: {
            type: 'prose',
            from: 'assistant',
            matches: new RegExp(password),
          },
        },
      ],
    };
  };

  /** What the old implementation computed: the whole fixture, passwords included. */
  const oldHash = (fixture: Fixture) =>
    createHash('sha256')
      .update(
        JSON.stringify(fixture, (_key, value: unknown) => {
          if (value instanceof RegExp) return `regexp:${value.toString()}`;
          if (typeof value === 'function') return `function:${value.toString()}`;
          return value;
        }),
      )
      .digest('hex')
      .slice(0, 16);

  it('does not depend on a password, so a guess cannot be checked against it', () => {
    expect(conDatos().seed?.claves?.[0]?.password).toBe(PASSWORD);
    // Under the old scheme the hash was a function of the passwords: a guess either matched or not.
    expect(oldHash(withPassword('a-wrong-guess-123'))).not.toBe(oldHash(withPassword(PASSWORD)));
    expect(fixtureHash(withPassword('a-wrong-guess-123'))).toBe(
      fixtureHash(withPassword(PASSWORD)),
    );
    expect(fixtureHash(conDatos())).not.toBe(oldHash(conDatos()));
  });

  it('still tells fixtures apart', () => {
    expect(fixtureHash(getFixture('vida-laboral-sin-datos'))).not.toBe(fixtureHash(conDatos()));
    expect(fixtureHash({ ...conDatos(), prompt: `${conDatos().prompt} Gracias.` })).not.toBe(
      fixtureHash(conDatos()),
    );
  });
});
