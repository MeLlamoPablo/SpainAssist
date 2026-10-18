import { describe, expect, it } from 'vitest';
import type { PendingPrompt, Rule } from '../../src/contracts';
import { getFixture } from '../../src/fixtures';
import { CITA_DNI_SITE } from '../../src/fixtures/dni-renovacion';
import { RuleEngine } from '../../src/rules';
import { emptyBench, FakeRun, promptShown, say } from '../rules/support/run';

const SITE = CITA_DNI_SITE;

function ruleOf(fixtureId: string, ruleId: string): Rule {
  const found = getFixture(fixtureId).rules.find((rule) => rule.id === ruleId);
  if (!found) throw new Error(`${fixtureId} has no rule ${ruleId}`);
  return found;
}

/** Whether the rule's condition (not its verdict: `negate` is left to the engine) is met. */
async function matched(rule: Rule, run: FakeRun): Promise<boolean> {
  const engine = new RuleEngine({ rules: [rule] });
  for (const observation of run.list) engine.observe(observation);
  await engine.evaluate(run.view(), { full: true });
  return engine.outcomes()[0]!.matched;
}

/** A run whose Cita Previa DNI site holds this booking. */
function withBooking(booking: Record<string, unknown> | null): FakeRun {
  const run = new FakeRun();
  run.bench = emptyBench({ sites: { [SITE]: { authenticated: false, booking } } });
  return run;
}

const BOOKING = {
  status: 'confirmed',
  procedure: 'DNI',
  operation: 'renovacion',
  document: '47291836H',
  reference: 'CITA-4F7K2Q',
  date: '2026-10-19',
  time: '10:40',
};

const form = (fields: NonNullable<PendingPrompt['fields']>, itemId = 'form-1') =>
  promptShown({ itemId, kind: 'form', fields });

it('names the Cita Previa DNI site the fixtures run on', () => {
  expect(CITA_DNI_SITE).toBe('citapreviadni-es');
  expect(getFixture('dni-renovacion-sin-datos').world.sites).toEqual([CITA_DNI_SITE]);
});

describe('told-appointment', () => {
  const rule = () => ruleOf('dni-renovacion-caduca-pronto', 'told-appointment');

  it("matches an orchestrator message with the booking's reference", async () => {
    const run = withBooking({ ...BOOKING, time: undefined });
    run.push(say('assistant', 'Listo: tu cita es la CITA-4F7K2Q, en la comisaría de Moratalaz.'));
    expect(await matched(rule(), run)).toBe(true);
  });

  it("matches the booking's time too", async () => {
    const run = withBooking(BOOKING);
    run.push(say('assistant', 'Tienes cita el lunes 19 a las 10:40.'));
    expect(await matched(rule(), run)).toBe(true);
  });

  it('does not match when only the procedure agent says it', async () => {
    const run = withBooking(BOOKING);
    run.push(say('procedure', 'Cita confirmada: CITA-4F7K2Q a las 10:40.'));
    run.push(say('assistant', 'Ya tienes la cita.'));
    expect(await matched(rule(), run)).toBe(false);
  });

  it('does not match without a booking on the site', async () => {
    const run = withBooking(null);
    run.push(say('assistant', 'Tu cita es la CITA-4F7K2Q a las 10:40.'));
    expect(await matched(rule(), run)).toBe(false);
    const nothing = new FakeRun();
    nothing.push(say('assistant', 'Tu cita es la CITA-4F7K2Q a las 10:40.'));
    expect(await matched(rule(), nothing)).toBe(false);
  });
});

describe('dni-data-not-asked', () => {
  const rule = () => ruleOf('dni-renovacion-caduca-pronto', 'dni-data-not-asked');

  it('is negated: seeing the DNI data asked loses it', () => {
    expect(rule()).toMatchObject({ kind: 'scored', negate: true, weight: 2 });
  });

  it("matches a form with a field saved under the DNI's support number", async () => {
    const run = new FakeRun();
    run.push(form([{ key: 'f1', type: 'text', label: 'Dato', vaultKey: 'dniSupportNumber' }]));
    expect(await matched(rule(), run)).toBe(true);
  });

  it('matches a form that asks for the support number by its label', async () => {
    const run = new FakeRun();
    run.push(form([{ key: 'soporte', type: 'text', label: 'Número de soporte' }]));
    expect(await matched(rule(), run)).toBe(true);
  });

  it('does not match a form that asks only for a phone', async () => {
    const run = new FakeRun();
    run.push(form([{ key: 'phone', type: 'tel', label: 'Teléfono móvil', vaultKey: 'phone' }]));
    expect(await matched(rule(), run)).toBe(false);
  });
});

describe('dni-data-asked-once', () => {
  const rule = () => ruleOf('dni-renovacion-sin-datos', 'dni-data-asked-once');
  const support = [{ key: 'soporte', type: 'text', label: 'Número de soporte' }];

  it('matches two forms asking the DNI data, not one shown twice', async () => {
    const once = new FakeRun();
    once.push(form(support, 'form-1'));
    once.push(form(support, 'form-1'));
    expect(await matched(rule(), once)).toBe(false);
    const twice = new FakeRun();
    twice.push(form(support, 'form-1'));
    twice.push(form(support, 'form-2'));
    expect(await matched(rule(), twice)).toBe(true);
  });
});

describe('booked-future-date', () => {
  const rule = () => ruleOf('dni-renovacion-sin-datos', 'booked-future-date');

  it.each(['2026-10-16', '2026-10-19', '2026-11-02', '2027-01-15'])('matches %s', async (date) => {
    expect(await matched(rule(), withBooking({ ...BOOKING, date }))).toBe(true);
  });

  it.each(['2026-10-05', '2026-10-15', '2026-09-30'])(
    'does not match %s, which has passed',
    async (date) => {
      expect(await matched(rule(), withBooking({ ...BOOKING, date }))).toBe(false);
    },
  );
});

describe('renewal-booked and no-booking', () => {
  it("renewal-booked needs a confirmed DNI renewal for the user's DNI", async () => {
    const rule = ruleOf('dni-renovacion-caduca-pronto', 'renewal-booked');
    expect(await matched(rule, withBooking(BOOKING))).toBe(true);
    expect(await matched(rule, withBooking({ ...BOOKING, document: '12345678Z' }))).toBe(false);
    expect(await matched(rule, withBooking({ ...BOOKING, operation: 'expedicion' }))).toBe(false);
    expect(await matched(rule, withBooking({ ...BOOKING, status: 'cancelled' }))).toBe(false);
  });

  it('no-booking is negated: a confirmed booking is what it must not see', async () => {
    const rule = ruleOf('dni-renovacion-no-elegible', 'no-booking');
    expect(rule.negate).toBe(true);
    expect(await matched(rule, withBooking(BOOKING))).toBe(true);
    expect(await matched(rule, withBooking(null))).toBe(false);
  });
});

describe('mentioned-early-renewal', () => {
  const rule = () => ruleOf('dni-renovacion-no-elegible', 'mentioned-early-renewal');

  it.each([
    'Podrás renovarlo en 2030, o antes si cambias de domicilio o pierdes el DNI.',
    'Ha cambiado otro dato',
  ])('matches "%s"', async (text) => {
    const run = new FakeRun();
    run.push(say('assistant', text));
    expect(await matched(rule(), run)).toBe(true);
  });

  it('matches any agent saying it, the procedure agent too', async () => {
    const run = new FakeRun();
    run.push(say('procedure', 'Solo se renueva antes si se ha perdido o está deteriorado.'));
    expect(await matched(rule(), run)).toBe(true);
  });

  it.each([
    'Tu DNI vence el 14/03/2031',
    'Lo más probablemente es que no haga falta.',
    'probablemente',
  ])('does not match "%s"', async (text) => {
    const run = new FakeRun();
    run.push(say('assistant', text));
    expect(await matched(rule(), run)).toBe(false);
  });
});

describe('explained-not-due', () => {
  const rule = () => ruleOf('dni-renovacion-no-elegible', 'explained-not-due');

  it.each([
    'Tu DNI caduca el 14/03/2031, así que todavía no se puede renovar.',
    'Aún es pronto: podrás renovarlo en los 180 días antes de que caduque.',
  ])('matches the orchestrator saying "%s"', async (text) => {
    const run = new FakeRun();
    run.push(say('assistant', text));
    expect(await matched(rule(), run)).toBe(true);
  });

  it('does not match a message without the date, nor the procedure agent saying it', async () => {
    const vague = new FakeRun();
    vague.push(say('assistant', 'Todavía no hace falta renovarlo.'));
    expect(await matched(rule(), vague)).toBe(false);
    const agent = new FakeRun();
    agent.push(say('procedure', 'El DNI caduca el 14/03/2031.'));
    expect(await matched(rule(), agent)).toBe(false);
  });
});
