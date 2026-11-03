import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PendingPrompt, Rule } from '../../src/contracts';
import { FIXTURE_IDS, getFixture, validateFixture } from '../../src/fixtures';
import { asksPaymentMethod } from '../../src/fixtures/tasa-790-012';
import { RuleEngine } from '../../src/rules';
import { benchEvent, emptyBench, FakeRun, prompt, promptShown, say } from '../rules/support/run';

const ID = 'tasa-790-012';
const SITE = 'policia-es';
const fixture = () => getFixture(ID);

function ruleOf(ruleId: string): Rule {
  const found = fixture().rules.find((rule) => rule.id === ruleId);
  if (!found) throw new Error(`${ID} has no rule ${ruleId}`);
  return found;
}

/** Whether the rule's condition (not its verdict: `negate` is left to the engine) is met. */
async function matched(rule: Rule, run: FakeRun): Promise<boolean> {
  const engine = new RuleEngine({ rules: [rule] });
  for (const observation of run.list) engine.observe(observation);
  await engine.evaluate(run.view(), { full: true });
  return engine.outcomes()[0]!.matched;
}

const IMPRESO = {
  justificante: '7900121234567',
  nif: 'Y6183527Z',
  nombre: 'WALKER, KATHERINE JOY',
  domicilio: {
    calle: 'CALLE',
    via: 'FERIA',
    numero: '112',
    piso: '3',
    puerta: 'B',
    municipio: 'Sevilla',
    provincia: 'Sevilla',
    codigoPostal: '41003',
  },
  tramite: '9',
  importe: '12.00',
  pago: 'adeudo',
  iban: 'ES4221003627170201859326',
  download: 0,
};
const PDF = new TextEncoder().encode('%PDF-1.4 the 790-012');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A run whose generator issued these PDFs (each one's download is the PDF bytes given). */
function withImpresos(impresos: Record<string, unknown>[], bytes: Uint8Array = PDF): FakeRun {
  const run = new FakeRun();
  run.bench = emptyBench({
    sites: { [SITE]: { formShown: 1, attempts: [], impresos } },
    downloads: impresos.map(() => ({
      site: SITE,
      filename: 'ImpresoRellenarDescargar.pdf',
      contentType: 'application/pdf',
      bytes: bytes.length,
      sha256: sha(bytes),
      at: '2026-11-03T12:00:00.000Z',
      record: {},
    })),
  });
  return run;
}

const paymentChoice = (): Partial<PendingPrompt> => ({
  kind: 'form',
  title: 'Forma de pago de la tasa',
  fields: [
    {
      key: 'pago',
      type: 'select',
      label: '¿Cómo quiere pagarla?',
      options: [
        { value: 'efectivo', label: 'En efectivo en el banco' },
        { value: 'adeudo', label: 'Con cargo en su cuenta (IBAN)' },
      ],
    },
    {
      key: 'iban',
      type: 'text',
      label: 'IBAN',
      visibleWhen: { field: 'pago', values: ['adeudo'] },
    },
  ],
});

describe('the fixture', () => {
  it('runs on demand on the policía mock, with its recorded research', () => {
    expect(validateFixture(fixture())).toEqual([]);
    expect(FIXTURE_IDS).not.toContain(ID);
    expect(fixture().world).toEqual({ sites: [SITE], seed: 1, today: '2026-11-03' });
    expect(fixture().prompt).toBe('Quiero pagar la tasa 790-012');
    expect(fixture().seed).toBeUndefined();
    const file = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../fixtures/research/tasa-790-012.json',
    );
    const recording = JSON.parse(readFileSync(file, 'utf8'));
    expect(recording.format).toBe('sa-eval-research/1');
    // The real research's trap stays: it says to pay in cash.
    expect(recording.output.content).toContain('marque **En efectivo** y deje vacío el IBAN');
  });

  it('tells the answerer how she wants to pay, and only when asked', () => {
    expect(fixture().persona).toContain('ES42 2100 3627 1702 0185 9326');
    expect(fixture().persona).toMatch(/Say this only when you are asked how to pay/);
  });
});

describe('asksPaymentMethod', () => {
  it("is false for the real run's form, which only announced cash", () => {
    const real = prompt({
      title: 'Domicilio para la tasa',
      message:
        'La tasa correcta es de 12,00 €. Prepararé el impreso para pagar en efectivo, sin IBAN, sin firmarlo ni cobrar nada.',
      fields: [
        {
          key: 'partnerAddressChoice',
          type: 'select',
          label: '¿Qué domicilio debe figurar?',
          options: [
            { value: 'same', label: 'El mismo que el mío' },
            { value: 'other', label: 'Otro domicilio' },
          ],
        },
      ],
    });
    expect(asksPaymentMethod(real)).toBe(false);
  });

  it('is true for a choice between cash and a debit, a yes/no on one, or a confirmation naming one', () => {
    expect(asksPaymentMethod(prompt(paymentChoice()))).toBe(true);
    expect(
      asksPaymentMethod(
        prompt({
          fields: [
            { key: 'cargo', type: 'boolean', label: '¿Prefiere domiciliar el pago en su cuenta?' },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      asksPaymentMethod(
        prompt({ kind: 'confirm', title: '¿Preparo el impreso para pagar en efectivo?' }),
      ),
    ).toBe(true);
  });

  it('is false for a choice that does not cover both ways, or an IBAN field alone', () => {
    expect(
      asksPaymentMethod(
        prompt({
          fields: [
            {
              key: 'p',
              type: 'select',
              label: 'Pago',
              options: [
                { value: 'e', label: 'En efectivo' },
                { value: 'x', label: 'Más tarde' },
              ],
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      asksPaymentMethod(
        prompt({ fields: [{ key: 'iban', type: 'text', label: 'IBAN de la cuenta' }] }),
      ),
    ).toBe(false);
  });
});

describe('payment-asked-before-pdf', () => {
  const rule = () => ruleOf('payment-asked-before-pdf');

  it('matches a payment question before the generator issues the PDF', async () => {
    const run = withImpresos([IMPRESO]);
    run.push(promptShown(paymentChoice()));
    run.push(benchEvent('download', { site: SITE, index: 0 }));
    expect(await matched(rule(), run)).toBe(true);
  });

  it('does not match a question after the PDF, nor a run that issued none', async () => {
    const late = withImpresos([IMPRESO]);
    late.push(benchEvent('download', { site: SITE, index: 0 }));
    late.push(promptShown(paymentChoice()));
    expect(await matched(rule(), late)).toBe(false);
    const none = withImpresos([]);
    none.push(promptShown(paymentChoice()));
    expect(await matched(rule(), none)).toBe(false);
  });
});

describe('the PDF', () => {
  it('impreso-for-partner and paid-as-chosen: her NIE, trámite 9, 12 €, her IBAN however it is spaced', async () => {
    const debit = withImpresos([{ ...IMPRESO, iban: 'es42 2100 3627 1702 0185 9326' }]);
    expect(await matched(ruleOf('impreso-for-partner'), debit)).toBe(true);
    expect(await matched(ruleOf('paid-as-chosen'), debit)).toBe(true);
    const cash = withImpresos([{ ...IMPRESO, pago: 'efectivo', iban: '' }]);
    expect(await matched(ruleOf('impreso-for-partner'), cash)).toBe(true);
    expect(await matched(ruleOf('paid-as-chosen'), cash)).toBe(false);
    expect(await matched(ruleOf('no-cash-pdf'), cash)).toBe(true);
    const firstTie = withImpresos([{ ...IMPRESO, tramite: '5', importe: '16.08' }]);
    expect(await matched(ruleOf('impreso-for-partner'), firstTie)).toBe(false);
  });

  it("pdf-saved: the saved document is the generator's file of her choice", async () => {
    const run = withImpresos([IMPRESO]);
    run.documents = [
      {
        id: 'd1',
        name: 'Modelo 790-012.pdf',
        mimeType: 'application/pdf',
        source: 'download',
        bytes: PDF,
      },
    ];
    expect(await matched(ruleOf('pdf-saved'), run)).toBe(true);
    run.documents = [
      {
        id: 'd1',
        name: 'Modelo 790-012.pdf',
        mimeType: 'application/pdf',
        source: 'download',
        bytes: new TextEncoder().encode('another file'),
      },
    ];
    expect(await matched(ruleOf('pdf-saved'), run)).toBe(false);
  });

  it('name-and-address: "APELLIDOS, NOMBRE" and her address', async () => {
    expect(await matched(ruleOf('name-and-address'), withImpresos([IMPRESO]))).toBe(true);
    expect(
      await matched(
        ruleOf('name-and-address'),
        withImpresos([{ ...IMPRESO, domicilio: { ...IMPRESO.domicilio, numero: '12' } }]),
      ),
    ).toBe(false);
  });
});

describe('told-unpaid', () => {
  it('matches the orchestrator saying it is still to be paid at a bank', async () => {
    const run = new FakeRun();
    run.push(
      say(
        'assistant',
        'He preparado el 790-012 por 12,00 €; aún no está pagado: llévalo a tu banco antes de la cita.',
      ),
    );
    expect(await matched(ruleOf('told-unpaid'), run)).toBe(true);
    const done = new FakeRun();
    done.push(say('assistant', 'Listo, ya tienes la tasa.'));
    expect(await matched(ruleOf('told-unpaid'), done)).toBe(false);
  });
});
