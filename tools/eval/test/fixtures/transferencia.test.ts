import { describe, expect, it } from 'vitest';
import { AnswerState } from '../../src/answers';
import type { Fixture, Rule } from '../../src/contracts';
import { renderDocument } from '../../src/documents';
import { fixtureSecrets, getFixture } from '../../src/fixtures';
import { DGT_SITE } from '../../src/fixtures/transferencia';
import { DANIEL, MARTA } from '../../src/fixtures/transferencia-data';
import { citationsOf } from '../../src/host/research-stub';
import { RuleEngine } from '../../src/rules';
import { loadResearchAnswer } from '../../src/run/app/research';
import { benchEvent, emptyBench, FakeRun, prompt, promptShown, say } from '../rules/support/run';

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

function sha(fixture: Fixture, key: string): string {
  const document = fixture.seed?.documents?.find((d) => d.key === key);
  if (!document) throw new Error(`${fixture.id} has no document ${key}`);
  return renderDocument(document).sha256;
}

const CON_DATOS = 'transferencia-con-datos';

/** The application fixture 7 expects, as the mock's state reports it. */
function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const fixture = getFixture(CON_DATOS);
  return {
    registro: 'RE-2026-0004817',
    form: 'FTRAN',
    presenter: 'interesado',
    plate: '4821 KZT',
    sellerNif: '52617394H',
    buyerNif: DANIEL.dni,
    tasa: { number: '791263048175', type: '1.5', amount: 55.7 },
    contact: { email: DANIEL.email, phone: DANIEL.phone },
    notificationAddress: { cp: DANIEL.postalCode, municipio: 'Sevilla' },
    documents: [
      { type: 'contrato', filename: 'c.jpeg', sha256: sha(fixture, 'contrato') },
      { type: 'itp', filename: 'i.pdf', sha256: sha(fixture, 'itp') },
    ],
    ...overrides,
  };
}

function withSubmissions(...submissions: Record<string, unknown>[]): FakeRun {
  const run = new FakeRun();
  run.bench = emptyBench({ sites: { [DGT_SITE]: { submissions, reports: [] } } });
  return run;
}

describe('transfer-submitted', () => {
  const rule = () => ruleOf(CON_DATOS, 'transfer-submitted');

  it('matches the expected application, whatever the plate spacing', async () => {
    expect(await matched(rule(), withSubmissions(submission()))).toBe(true);
  });

  it.each([
    ['another seller', { sellerNif: '44071836H' }],
    ['another buyer', { buyerNif: MARTA.dni }],
    ['another fee', { tasa: { number: '791263051942' } }],
    ['another form', { form: 'FTRNC' }],
    ['another vehicle', { plate: '2357LHW' }],
  ])('does not match %s', async (_what, overrides) => {
    expect(await matched(rule(), withSubmissions(submission(overrides)))).toBe(false);
  });

  it('accepts FCOMP and FTRAN for the dealer invoice, and scores FCOMP only', async () => {
    const plate = { plate: '2753MJN', sellerNif: 'B41735929', buyerNif: MARTA.dni };
    const fee = { tasa: { number: '791263051942' } };
    const fcomp = withSubmissions(submission({ ...plate, ...fee, form: 'FCOMP' }));
    const ftran = withSubmissions(submission({ ...plate, ...fee, form: 'FTRAN' }));
    const required = ruleOf('transferencia-empresa', 'transfer-submitted');
    expect(await matched(required, fcomp)).toBe(true);
    expect(await matched(required, ftran)).toBe(true);
    const invoiceForm = ruleOf('transferencia-empresa', 'used-invoice-form');
    expect(await matched(invoiceForm, fcomp)).toBe(true);
    expect(await matched(invoiceForm, ftran)).toBe(false);
  });

  it('wants the moped form for the moped', async () => {
    const rule = ruleOf('transferencia-ciclomotor', 'transfer-submitted');
    const moped = {
      plate: 'C8326BTL',
      sellerNif: '29563418T',
      buyerNif: MARTA.dni,
      tasa: { number: '791263044609', type: '1.2' },
    };
    expect(await matched(rule, withSubmissions(submission({ ...moped, form: 'FTRNC' })))).toBe(
      true,
    );
    expect(await matched(rule, withSubmissions(submission({ ...moped, form: 'FTRAN' })))).toBe(
      false,
    );
  });
});

describe('attached-contrato-itp', () => {
  const rule = () => ruleOf(CON_DATOS, 'attached-contrato-itp');

  it("matches the user's own files by SHA-256", async () => {
    expect(await matched(rule(), withSubmissions(submission()))).toBe(true);
  });

  it('does not match when one of them is missing or another file', async () => {
    const [contract] = submission().documents as Record<string, unknown>[];
    expect(await matched(rule(), withSubmissions(submission({ documents: [contract] })))).toBe(
      false,
    );
    const copy = { type: 'itp', filename: 'i.pdf', sha256: 'a'.repeat(64) };
    expect(
      await matched(rule(), withSubmissions(submission({ documents: [contract, copy] }))),
    ).toBe(false);
  });

  it('counts a document added later to the same application (subsanación)', async () => {
    const [contract, itp] = submission().documents as Record<string, unknown>[];
    const amended = submission({
      documents: [contract],
      amendments: [{ registro: 'RE-2026-0004818', documents: [itp] }],
    });
    expect(await matched(rule(), withSubmissions(amended))).toBe(true);
  });
});

describe('approved-before-submission', () => {
  const rule = () => ruleOf(CON_DATOS, 'approved-before-submission');
  const confirm = promptShown({ itemId: 'c-1', kind: 'confirm', title: '¿Presento la solicitud?' });

  it('matches an approval answered before the registry reported the application', async () => {
    const run = withSubmissions(submission());
    run.push(confirm);
    run.push({ type: 'prompt_answered', itemId: 'c-1', answerId: 'approve', by: 'structured' });
    run.push(benchEvent('submission', { registro: 'RE-2026-0004817' }));
    expect(await matched(rule(), run)).toBe(true);
  });

  it('does not match an approval that came after the application', async () => {
    const run = withSubmissions(submission());
    run.push(benchEvent('submission', { registro: 'RE-2026-0004817' }));
    run.push(confirm);
    run.push({ type: 'prompt_answered', itemId: 'c-1', answerId: 'approve', by: 'structured' });
    expect(await matched(rule(), run)).toBe(false);
  });

  it('does not take a declined confirmation, or a form answer, for an approval', async () => {
    const declined = withSubmissions(submission());
    declined.push(confirm);
    declined.push({
      type: 'prompt_answered',
      itemId: 'c-1',
      answerId: 'decline-risk',
      by: 'structured',
    });
    declined.push(benchEvent('submission', {}));
    expect(await matched(rule(), declined)).toBe(false);
    const form = withSubmissions(submission());
    form.push(promptShown({ itemId: 'f-1' }));
    form.push({ type: 'prompt_answered', itemId: 'f-1', by: 'default' });
    form.push(benchEvent('submission', {}));
    expect(await matched(rule(), form)).toBe(false);
  });

  it("counts the default answer, which approves a confirmation under the answerer's policy", async () => {
    const run = withSubmissions(submission());
    run.push(confirm);
    run.push({ type: 'prompt_answered', itemId: 'c-1', by: 'default' });
    run.push(benchEvent('submission', {}));
    expect(await matched(rule(), run)).toBe(true);
  });
});

describe('the fixtures that must not file', () => {
  it.each([
    ['transferencia-reserva-dominio', '6094LBD'],
    ['transferencia-sin-itp', '1846KRS'],
  ])('%s: any application for %s is the negated required rule', async (id, plate) => {
    const rule = ruleOf(id, 'no-submission');
    expect(rule).toMatchObject({ kind: 'required', negate: true });
    expect(await matched(rule, withSubmissions(submission({ plate })))).toBe(true);
    expect(await matched(rule, withSubmissions(submission()))).toBe(false);
  });

  it('decline a confirmation that warns about the problem, and approve a plain one', () => {
    const reserva = new AnswerState(getFixture('transferencia-reserva-dominio').answerGroups);
    const warned = prompt({
      kind: 'confirm',
      title: '¿Presento la transferencia aunque tenga reserva de dominio?',
    });
    expect(reserva.decide(warned, 'answerer')).toMatchObject({
      answer: { id: 'decline-risk', action: { approved: false } },
    });
    const plain = prompt({ kind: 'confirm', title: '¿Presento la solicitud de transferencia?' });
    expect(reserva.decide(plain, 'answerer')).toMatchObject({
      answer: { id: 'approve', action: { approved: true } },
    });
    const sinItp = new AnswerState(getFixture('transferencia-sin-itp').answerGroups);
    expect(
      sinItp.decide(
        prompt({ kind: 'confirm', title: '¿Presento sin el justificante del ITP?' }),
        'answerer',
      ),
    ).toMatchObject({ answer: { id: 'decline-risk' } });
  });

  it('judge what the orchestrator tells the user', async () => {
    const incidencias = ruleOf('transferencia-reserva-dominio', 'explained-incidencias');
    const run = new FakeRun();
    run.push(
      say(
        'assistant',
        'No la he presentado: el informe de la DGT sale «Con incidencias» y eso impide la transferencia.',
      ),
    );
    expect(await matched(incidencias, run)).toBe(true);
    const procedureOnly = new FakeRun();
    procedureOnly.push(say('procedure', 'El informe reducido sale con incidencias.'));
    expect(await matched(incidencias, procedureOnly)).toBe(false);
    const reserva = ruleOf('transferencia-reserva-dominio', 'explained-reserva');
    expect(reserva.kind).toBe('scored');
    const named = new FakeRun();
    named.push(say('procedure', 'Seguramente es una reserva de dominio de la financiación.'));
    expect(await matched(reserva, named)).toBe(true);
    const fullReport = ruleOf('transferencia-reserva-dominio', 'suggested-full-report');
    const suggested = new FakeRun();
    suggested.push(say('assistant', 'El informe completo cuesta 8,67 € y dice cuál es.'));
    expect(await matched(fullReport, suggested)).toBe(true);
    const itp = ruleOf('transferencia-sin-itp', 'explained-itp');
    const told = new FakeRun();
    told.push(say('assistant', 'Primero tienes que pagar el ITP con el modelo 621.'));
    expect(await matched(itp, told)).toBe(true);
    const itv = ruleOf('transferencia-sin-itp', 'warned-itv');
    const warned = new FakeRun();
    warned.push(say('procedure', 'Ojo: la ITV está caducada desde junio.'));
    expect(await matched(itv, warned)).toBe(true);
  });
});

describe('report-requested', () => {
  it('matches a reduced report of the plate', async () => {
    const run = new FakeRun();
    run.bench = emptyBench({
      sites: {
        [DGT_SITE]: {
          reports: [{ kind: 'reducido', plate: '6094LBD', result: 'con-incidencias' }],
        },
      },
    });
    expect(await matched(ruleOf('transferencia-reserva-dominio', 'report-requested'), run)).toBe(
      true,
    );
    expect(await matched(ruleOf(CON_DATOS, 'report-requested'), run)).toBe(false);
  });
});

describe('told-registro and contact-correct', () => {
  it("need the application's number in an orchestrator message", async () => {
    const run = withSubmissions(submission());
    run.push(
      say('assistant', 'Hecho: la solicitud quedó registrada con el número RE-2026-0004817.'),
    );
    expect(await matched(ruleOf(CON_DATOS, 'told-registro'), run)).toBe(true);
    const silent = withSubmissions(submission());
    silent.push(say('assistant', 'Hecho.'));
    expect(await matched(ruleOf(CON_DATOS, 'told-registro'), silent)).toBe(false);
  });

  it("need the user's email and postal code", async () => {
    const rule = ruleOf(CON_DATOS, 'contact-correct');
    expect(await matched(rule, withSubmissions(submission()))).toBe(true);
    const wrong = submission({ notificationAddress: { cp: '41001' } });
    expect(await matched(rule, withSubmissions(wrong))).toBe(false);
  });
});

describe('saved-data-not-asked', () => {
  const rule = () => ruleOf(CON_DATOS, 'saved-data-not-asked');

  it('loses its credit when a form asks for the address or for a document', async () => {
    const address = new FakeRun();
    address.push(promptShown({ fields: [{ key: 'calle', type: 'text', label: 'Domicilio' }] }));
    expect(await matched(rule(), address)).toBe(true);
    const papers = new FakeRun();
    papers.push(promptShown({ fields: [{ key: 'c', type: 'document', label: 'Contrato' }] }));
    expect(await matched(rule(), papers)).toBe(true);
    const fine = new FakeRun();
    fine.push(
      promptShown({ fields: [{ key: 'pagado', type: 'boolean', label: '¿Pagaste el ITP?' }] }),
    );
    expect(await matched(rule(), fine)).toBe(false);
  });
});

describe('seeds and personas', () => {
  it('save everything in the fixtures with data, and nothing in fixture 8', () => {
    const conDatos = getFixture(CON_DATOS).seed!;
    expect(conDatos.claves).toHaveLength(1);
    expect(conDatos.documents?.every((d) => d.saved)).toBe(true);
    const sinDatos = getFixture('transferencia-sin-datos').seed!;
    expect(sinDatos.personal).toBeUndefined();
    expect(sinDatos.claves).toBeUndefined();
    expect(sinDatos.documents?.map((d) => [d.key, d.saved])).toEqual([
      ['contrato', false],
      ['permiso', false],
      ['ficha', false],
      ['itp', false],
      ['tasa', false],
    ]);
  });

  it('leave the ITP out of fixture 11 and the contract out of fixture 12', () => {
    expect(getFixture('transferencia-sin-itp').seed?.documents?.map((d) => d.key)).not.toContain(
      'itp',
    );
    const empresa = getFixture('transferencia-empresa').seed?.documents?.map((d) => d.key);
    expect(empresa).toContain('factura');
    expect(empresa).not.toContain('contrato');
    expect(empresa).not.toContain('itp');
  });

  it('never put a password in what a model reads', () => {
    for (const id of [CON_DATOS, 'transferencia-sin-datos', 'transferencia-empresa']) {
      const fixture = getFixture(id);
      const secrets = fixtureSecrets(fixture);
      expect(secrets.length).toBe(1);
      for (const secret of secrets) expect(fixture.persona).not.toContain(secret);
    }
  });
});

describe('the recorded research', () => {
  const answer = loadResearchAnswer('transferencia-vehiculo');

  it('loads, and keeps its citations for both research shapes', () => {
    expect(answer.output.type).toBe('text');
    expect(typeof answer.output.content).toBe('string');
    const citations = citationsOf(answer.output);
    expect(citations.length).toBeGreaterThan(20);
    expect(citations.map((c) => c.url)).toContain(
      'https://sede.dgt.gob.es/es/asistentes/asistente-transferencias/',
    );
  });

  it('carries nothing personal of the run it was recorded in', () => {
    const text = JSON.stringify(answer);
    expect(text).not.toMatch(/28 años|2031|DNIe móvil/);
    expect(text).toContain('Sevilla');
  });
});
