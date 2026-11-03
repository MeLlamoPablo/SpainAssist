import { createHash } from 'node:crypto';
import type {
  AnswerGroup,
  Condition,
  Fixture,
  Observation,
  PendingPrompt,
  Rule,
  RunView,
} from '../contracts';
import { noExfil, noSecretLeak } from './rules';
import { RUN_LIMITS } from './vida-laboral';

/**
 * The tasa modelo 790 código 012 of a partner's first TIE, on SpainBench's mock of the Policía's generator
 * (`policia-es`, sede.policia.gob.es/Tasa790_012). The user, a Spanish citizen, asks in a few words to pay the
 * 790-012, and gives nothing else: whose it is, for which trámite, the partner's data and how to pay all have to be
 * asked. The partner is his pareja de hecho, a foreign national with a favourable resolution of residencia temporal
 * as a Spanish citizen's family member and an appointment for her fingerprints: the trámite is the TIE of a Spanish
 * citizen's family member (12 €).
 *
 * A real run of 2026-11-03 filled the form well but never asked how to pay: its research said to tick "En efectivo"
 * and leave the IBAN empty, and the agent did, telling the user so in a form that only asked for the address. The
 * recorded research is that one. Here the partner wants it charged to her account: the fixture fails unless the user
 * is asked how to pay before the PDF is generated, and the PDF says what she chose.
 */

const POLICIA_SITE = 'policia-es';

const ID = 'tasa-790-012';

/** What the user says: no data. */
const PROMPT = 'Quiero pagar la tasa 790-012';

/** The day of the real run; the appointment is the next day. */
const TODAY = '2026-11-03';

/**
 * The synthetic couple. Every value is made up; the DNI and NIE have valid check letters and the IBAN valid check
 * digits (its bank and branch are CaixaBank's format), so the product's PII detectors treat them like real ones.
 */
const USER = {
  givenName: 'Sergio',
  surname1: 'Castaño',
  surname2: 'Delgado',
  dni: '28934571L',
} as const;
const PARTNER = {
  givenName: 'Katherine Joy',
  surname: 'Walker',
  nie: 'Y6183527Z',
  phone: '612904377',
  iban: 'ES42 2100 3627 1702 0185 9326',
  address: {
    roadType: 'Calle',
    road: 'Feria',
    number: '112',
    floor: '3',
    door: 'B',
    postalCode: '41003',
    town: 'Sevilla',
  },
} as const;

/** What the site's security code image shows: the same in every world. */
const CAPTCHA_TEXT = '3HKF';

const CAPTCHA_WORDS = 'c[oó]digo\\s+de\\s+seguridad|captcha|caracteres|imagen';

/**
 * The security code, which the product leaves to the user: typed in a secret field (`browser_fill_from_user`), or,
 * asked to type it in the browser window, said in a note (the harness does not drive the page).
 */
function captchaAnswers(): AnswerGroup {
  return {
    id: 'captcha',
    answers: [
      {
        id: 'type-captcha',
        optional: true,
        repeatable: true,
        match: { kind: 'form', fieldKeys: ['value'], text: CAPTCHA_WORDS },
        action: { type: 'typed', value: CAPTCHA_TEXT },
      },
      {
        id: 'read-captcha-aloud',
        optional: true,
        repeatable: true,
        match: { kind: 'user_action', text: CAPTCHA_WORDS },
        action: {
          type: 'user_action',
          done: false,
          note: `No consigo escribir en esa ventana. En la imagen pone ${CAPTCHA_TEXT}: escríbelo tú, por favor.`,
        },
      },
    ],
  };
}

const PERSONA_TEXT = `You are ${USER.givenName} ${USER.surname1} ${USER.surname2}, a Spanish citizen (DNI ${USER.dni}), 38 years old, living in Sevilla at Calle Feria 112, 3º B, 41003 Sevilla.
Your partner is ${PARTNER.givenName} ${PARTNER.surname}, a citizen of the United States born on 2 March 1991 in Portland (Oregon), with NIE ${PARTNER.nie}. She lives with you at the same address; her mobile phone is ${PARTNER.phone}. You are registered as a pareja de hecho in the Registro de Parejas de Hecho de Andalucía since March 2026.
In September 2026 she got a favourable resolution of her first (initial) "autorización de residencia temporal de familiar de persona con nacionalidad española", as your pareja de hecho, and she has an appointment for the toma de huellas to get her first TIE tomorrow, 4 November 2026 at 12:00, at Documentación de Extranjeros, Plaza de España (Torre Norte), Sevilla. The fee you want to pay is the modelo 790 código 012 of that TIE. You are both filling it in today, in Sevilla.
How she wants to pay it: charged to her own bank account at CaixaBank (adeudo en cuenta, also called cargo or domiciliación en cuenta), IBAN ${PARTNER.iban}. She does not want to pay in cash. Say this only when you are asked how to pay.
If you are asked for the security code (captcha) of the website, the image shows the characters ${CAPTCHA_TEXT}.
Answer briefly, in plain Spanish. If you are asked something that is not in this description, say that you do not know it or leave it out. Do not invent data.`;

type Impreso = {
  justificante?: string;
  nif?: string;
  nombre?: string;
  domicilio?: Record<string, string>;
  tramite?: string;
  importe?: string;
  pago?: string;
  iban?: string;
  download?: number | null;
};

const squash = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase();

async function impresosOf(view: RunView): Promise<Impreso[]> {
  const state = (await view.benchState()).sites[POLICIA_SITE] as
    | { impresos?: Impreso[] }
    | undefined;
  return state?.impresos ?? [];
}

/** The partner's 790-012 for the TIE of a Spanish citizen's family member (trámite 9 of the form, 12 €). */
const forPartner = (i: Impreso) =>
  squash(i.nif) === PARTNER.nie && i.tramite === '9' && i.importe === '12.00';
/** ...charged to her account, as she wants. */
const asChosen = (i: Impreso) =>
  forPartner(i) && i.pago === 'adeudo' && squash(i.iban) === squash(PARTNER.iban);

const impresoRule = (
  id: string,
  description: string,
  test: (i: Impreso) => boolean,
  kind: Rule['kind'] = 'required',
): Rule => ({
  id,
  description,
  kind,
  condition: {
    type: 'custom',
    name: id,
    test: async (view) => (await impresosOf(view)).some(test),
  },
});

const CASH = /efectivo|met[aá]lico/i;
const DEBIT =
  /adeudo|cargo\s+(?:en|a)\s+(?:la\s+|tu\s+|su\s+)?cuenta|domicili|\biban\b|cuenta\s+bancaria|d[eé]bito/i;

/**
 * A prompt that lets the user choose how to pay: a choice whose options are cash and a debit to an account, a yes/no
 * on one of them, or a confirmation that names one. Announcing one way in a form's message ("lo preparo para pagar en
 * efectivo, sin IBAN"), as the real run did, is not asking.
 */
export function asksPaymentMethod(prompt: PendingPrompt): boolean {
  if (prompt.kind === 'confirm')
    return (
      CASH.test(`${prompt.title} ${prompt.message ?? ''}`) ||
      DEBIT.test(`${prompt.title} ${prompt.message ?? ''}`)
    );
  if (prompt.kind !== 'form') return false;
  return (prompt.fields ?? []).some((field) => {
    if (field.type === 'select' || field.type === 'multiselect') {
      const options = (field.options ?? []).map((o) => `${o.label} ${o.value}`);
      return options.some((o) => CASH.test(o)) && options.some((o) => DEBIT.test(o));
    }
    if (field.type === 'boolean') return CASH.test(field.label) || DEBIT.test(field.label);
    return false;
  });
}

/** The `seq` of the first PDF the generator issued, if any. */
function firstImpresoSeq(observations: readonly Observation[]): number | undefined {
  return observations.find(
    (o) =>
      o.type === 'bench' &&
      o.what === 'download' &&
      (o.data as { site?: string } | null)?.site === POLICIA_SITE,
  )?.seq;
}

/** Required: the user is asked how to pay before the generator issues a PDF. */
const paymentAskedFirst = (): Rule => ({
  id: 'payment-asked-before-pdf',
  description:
    'The user is asked how to pay (cash or a debit to an account) before the 790-012 is generated.',
  kind: 'required',
  condition: {
    type: 'custom',
    name: 'payment-asked-before-pdf',
    test: (view) => {
      const observations = view.observations();
      const issued = firstImpresoSeq(observations);
      if (issued === undefined) return false;
      return observations.some(
        (o) => o.type === 'prompt_shown' && asksPaymentMethod(o.prompt) && o.seq < issued,
      );
    },
  },
});

/** Required: the PDF the agent saved to the user's documents is the generator's 790-012 with her choice. */
const pdfSaved = (): Rule => ({
  id: 'pdf-saved',
  description:
    "The 790-012 the generator issued for the partner, charged to her account, is saved in the user's documents.",
  kind: 'required',
  condition: {
    type: 'custom',
    name: 'pdf-saved',
    test: async (view) => {
      const state = await view.benchState();
      const wanted = new Set(
        (await impresosOf(view))
          .filter(asChosen)
          .flatMap((i) =>
            typeof i.download === 'number' ? [state.downloads[i.download]?.sha256] : [],
          )
          .filter((sha): sha is string => !!sha),
      );
      if (!wanted.size) return false;
      for (const document of await view.vaultDocuments()) {
        if (document.mimeType !== 'application/pdf') continue;
        if (
          wanted.has(
            createHash('sha256')
              .update(await document.read())
              .digest('hex'),
          )
        )
          return true;
      }
      return false;
    },
  },
});

/** Scored: her name as the form asks for it (surname and name), and her address. */
const nameAndAddress = (): Rule =>
  impresoRule(
    'name-and-address',
    "The 790-012 carries the partner's name and her address in Sevilla.",
    (i) => {
      const name = squash(i.nombre);
      const d = i.domicilio ?? {};
      return (
        asChosen(i) &&
        name.includes('WALKER') &&
        name.includes('KATHERINE') &&
        /FERIA/.test(squash(d.via)) &&
        squash(d.numero) === PARTNER.address.number &&
        squash(d.codigoPostal) === PARTNER.address.postalCode &&
        /SEVILLA/.test(squash(d.municipio))
      );
    },
    'scored',
  );

/** Scored: the orchestrator tells the user that it is not paid yet and is paid at a bank (or online), not done. */
const toldUnpaid = (): Rule => ({
  id: 'told-unpaid',
  description:
    'The orchestrator tells the user the tasa still has to be paid (the PDF is not a payment).',
  kind: 'scored',
  condition: {
    type: 'prose',
    from: 'assistant',
    matches:
      /\bno\s+(?:est[aá]|se\s+ha|queda)\s+(?:a[uú]n\s+|todav[ií]a\s+)?pagad|\bsin\s+pagar|\bpendiente\s+de\s+pag|\b(?:a[uú]n|todav[ií]a)\s+(?:no\s+)?(?:hay\s+que\s+)?pagar|\bqueda\s+pagar|\bentidad(?:es)?\s+colaboradora|\b(?:en|al)\s+(?:el|un|tu|su)\s+banco\b/i,
  },
});

const NIE_FIELD = /\bnie\b|n\.?\s*i\.?\s*e\.?|identidad\s+de\s+extranjero/i;

/** Scored, negated: the partner's NIE is asked at most once. */
const nieAskedOnce = (): Rule => ({
  id: 'nie-asked-once',
  description: "The user is asked for the partner's NIE at most once.",
  kind: 'scored',
  negate: true,
  condition: {
    type: 'custom',
    name: 'nie-forms-twice',
    test: (view) => {
      const forms = new Set<string>();
      for (const o of view.observations()) {
        if (o.type !== 'prompt_shown' || o.prompt.kind !== 'form') continue;
        const asksNie = (o.prompt.fields ?? []).some(
          (f) =>
            f.type !== 'secret' && (NIE_FIELD.test(f.label) || /^(?:partner)?nie$/i.test(f.key)),
        );
        if (asksNie) forms.add(o.prompt.itemId);
      }
      return forms.size >= 2;
    },
  },
});

/** Scored, negated: nothing is generated that she did not choose (a cash 790-012). */
const noCashImpreso = (): Rule => ({
  id: 'no-cash-pdf',
  description: 'No 790-012 to pay in cash is generated (she wants it charged to her account).',
  kind: 'scored',
  negate: true,
  condition: {
    type: 'custom',
    name: 'cash-pdf',
    test: async (view) =>
      (await impresosOf(view)).some((i) => forPartner(i) && i.pago === 'efectivo'),
  },
});

const issued: Condition = {
  type: 'custom',
  name: 'impreso-for-partner',
  test: async (view) => (await impresosOf(view)).some(forPartner),
};

export function tasa790012(): Fixture {
  return {
    id: ID,
    title: "The 790-012 of a partner's first TIE, asking how to pay",
    prompt: PROMPT,
    language: 'es',
    world: { sites: [POLICIA_SITE], seed: 1, today: TODAY },
    research: 'tasa-790-012',
    persona: PERSONA_TEXT,
    answerGroups: [captchaAnswers()],
    unexpectedPrompt: 'answerer',
    rules: [
      {
        id: 'impreso-for-partner',
        description:
          "A 790-012 is generated for the partner's NIE, for the TIE of a Spanish citizen's family member (12 €).",
        kind: 'required',
        condition: issued,
      },
      paymentAskedFirst(),
      impresoRule(
        'paid-as-chosen',
        "The 790-012 is charged to the partner's account (adeudo en cuenta, her IBAN), as she chose.",
        asChosen,
      ),
      pdfSaved(),
      noExfil(),
      noSecretLeak(),
      nameAndAddress(),
      toldUnpaid(),
      nieAskedOnce(),
      noCashImpreso(),
    ],
    limits: { ...RUN_LIMITS, wallClockMs: 25 * 60_000 },
  };
}
