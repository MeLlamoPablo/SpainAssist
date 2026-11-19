import type { Fixture, FixtureSeed, Rule, RunLimits, RunView } from '../contracts';
import { type FixtureDocument, renderDocument } from '../documents';
import {
  type FilledForm,
  type FormField,
  foldText,
  formFields,
  readFilledForm,
} from '../rules/pdf-form';
import { finalMessageLinksDocument, noExfil, noSecretLeak } from './rules';

/**
 * Filling in a PDF form (`api.documents.fill`): the real EX-15 (solicitud de NIE) in the user's
 * documents, once fillable (its own AcroForm fields) and once flat (the Ministerio's own version
 * with no fields: dotted lines, □ and table-cell squares), so the agent has to point at the page
 * either way; and once not in the documents at all (`pdf-ex15-web`): the agent finds the form
 * where it is published (SpainBench's `inclusion-es`, the Ministerio de Inclusión's "Modelos
 * generales", and the Policía's page on the NIE, which links it) and downloads it first. Each value the persona's data or the request gives is a scored rule, read the way a
 * person reads the printed page (`src/rules/pdf-form.ts`); what must stay empty loses credit when
 * written. The blank PDFs are SpainBench's (`forms/`), pinned by SHA-256.
 */

const FILLABLE: FixtureDocument = {
  key: 'ex15',
  name: 'EX-15.pdf',
  saved: true,
  match: 'ex-?15|solicitud',
  spec: {
    kind: 'blankForm',
    file: 'ex15.pdf',
    sha256: '68d7e5ccdef75235af29e9cd20eeeade066ba4df7405f2f0ebb9b57c4958eb2b',
  },
};

const FLAT: FixtureDocument = {
  ...FILLABLE,
  spec: {
    kind: 'blankForm',
    file: 'ex15-plano.pdf',
    sha256: '2defc88df4530464a4dd24e4cad394dff952f60764eb395db95af7fe29d35ed2',
  },
};

/** The site that publishes the EX-15 (both PDFs), and what its scoring state reports. */
const INCLUSION_SITE = 'inclusion-es';
interface InclusionState {
  downloads: { form: string; path: string; at: string }[];
}

/** The synthetic persona: a Polish citizen on a stay in Madrid. Every value is made up. */
const SEED: FixtureSeed = {
  personal: {
    givenName: 'Agnieszka',
    surname1: 'Wiśniewska',
    birthDate: '1990-06-14',
    sex: 'F',
    nationality: 'POL',
    birthPlace: 'Cracovia (Polonia)',
    fatherName: 'Tomasz',
    motherName: 'Ewa',
    maritalStatus: 'married',
    passportNumber: 'EP4831926',
    email: 'agnieszka.wisniewska@example.pl',
    phone: '+34 612 345 678',
    addressStreet: 'Calle de Embajadores, 41, 3º B',
    addressPostalCode: '28012',
    addressMunicipality: 'Madrid',
    addressProvince: 'Madrid',
    addressCountry: 'España',
  },
};

const PERSONA = `You are Agnieszka Wiśniewska, a Polish citizen born in Kraków on 14 June 1990, married, staying in Madrid for a few months (you are not a resident). You are buying a flat in Madrid and need a NIE for it.
You asked your assistant app to fill in the EX-15 form you saved in the app; you will hand it in yourself at a police station (comisaría de policía).
Everything about you that the form asks for is saved in the app. You have no second surname, no NIE yet and no representative. Answer briefly, in Spanish. If you are asked something that is not in this description, say that you do not know it. Do not invent data.`;

const PROMPT =
  'Tengo el EX-15 en blanco en Mis documentos. Rellénamelo para pedir el NIE: es por intereses económicos (me voy a comprar un piso), estoy de estancia, no soy residente, y lo entregaré yo en la comisaría.';

const PERSONA_WEB = PERSONA.replace(
  'You asked your assistant app to fill in the EX-15 form you saved in the app;',
  'You asked your assistant app to get the official EX-15 form (solicitud de NIE) and fill it in for you; you do not have the form;',
);

const PROMPT_WEB =
  'Necesito pedir el NIE. Descárgate el formulario EX-15 oficial y rellénamelo: es por intereses económicos (me voy a comprar un piso), estoy de estancia, no soy residente, y lo entregaré yo en la comisaría.';

/**
 * A run fills in about 30 values on two pages and looks at them: a few tens of model requests
 * with page images. The limits stop runaway loops, not careful work.
 */
const LIMITS: RunLimits = {
  wallClockMs: 20 * 60_000,
  maxToolCalls: 200,
  maxRequests: 80,
  maxCostUsd: 2,
  maxPrompts: 6,
};

/** A text field and what it must say (folded: accents and case ignored). */
interface TextExpectation {
  field: string;
  what: string;
  expect: RegExp;
}

const TEXTS: readonly TextExpectation[] = [
  { field: 'Texto1', what: 'passport number', expect: /^ep ?4831926$/ },
  { field: 'Texto5', what: 'first surname', expect: /^wisniewska$/ },
  { field: 'Texto7', what: 'given name', expect: /^agnieszka$/ },
  { field: 'Texto8', what: 'day of birth', expect: /^14$/ },
  { field: 'Texto9', what: 'month of birth', expect: /^0?6$/ },
  { field: 'Texto10', what: 'year of birth', expect: /^1990$/ },
  { field: 'Texto11', what: 'place of birth', expect: /^(cracovia|krakow)( \(?polonia\)?)?$/ },
  { field: 'Texto12', what: 'country of birth', expect: /^polonia$/ },
  { field: 'Texto13', what: 'nationality', expect: /^(polaca|polonia)$/ },
  { field: 'Texto14', what: "father's name", expect: /^tomasz$/ },
  { field: 'Texto15', what: "mother's name", expect: /^ewa$/ },
  { field: 'Texto16', what: 'street', expect: /^(c\/|calle) (de )?embajadores$/ },
  { field: 'Texto17', what: 'street number', expect: /^41$/ },
  { field: 'Texto18', what: 'floor', expect: /^3 ?(º|o)? ?b$/ },
  { field: 'Texto19', what: 'town', expect: /^madrid$/ },
  { field: 'Texto20', what: 'postal code', expect: /^28012$/ },
  { field: 'Texto21', what: 'province', expect: /^madrid$/ },
  { field: 'Texto22', what: 'mobile phone', expect: /^(\+?34)? ?612 ?345 ?678$/ },
  { field: 'Texto23', what: 'email', expect: /^agnieszka\.wisniewska@example\.pl$/ },
];

/** A group of boxes of which exactly one must be ticked. */
interface TickExpectation {
  id: string;
  what: string;
  tick: string;
  others: readonly string[];
}

const box = (n: number) => `Casilla de verificación${n}`;

const TICKS: readonly TickExpectation[] = [
  { id: 'sex', what: 'sex: M (mujer)', tick: box(29), others: [box(27), box(28)] },
  {
    id: 'marital-status',
    what: 'marital status: C (casada)',
    tick: box(31),
    others: [box(30), box(32), box(33), box(34)],
  },
  {
    id: 'document',
    what: 'document: NIE (not a certificate)',
    tick: box(36),
    others: [box(37), box(38), box(39)],
  },
  {
    id: 'motive',
    what: 'motive: intereses económicos',
    tick: box(40),
    others: [box(41), box(42), box(43)],
  },
  {
    id: 'where',
    what: 'handed in at: comisaría de policía',
    tick: box(45),
    others: [box(44), box(46)],
  },
  { id: 'situation', what: 'situation in Spain: estancia', tick: box(47), others: [box(48)] },
];

/** Parts that must stay empty, by field (text written there, or a tick). */
const EMPTY: readonly { id: string; what: string; fields: readonly string[] }[] = [
  { id: 'nie', what: 'the NIE (she has none yet)', fields: ['Texto2', 'Texto3', 'Texto4'] },
  { id: 'second-surname', what: 'the second surname (she has none)', fields: ['Texto6'] },
  {
    id: 'representative',
    what: 'the legal representative and section 2 (she has none)',
    fields: [
      'Texto24',
      'Texto25',
      'Texto26',
      ...Array.from({ length: 13 }, (_, i) => `Texto${49 + i}`),
    ],
  },
  { id: 'signature', what: 'the signature box (she signs herself)', fields: ['Texto77'] },
];

// ---------------------------------------------------------------------------------------------
// Reading the runs' filled-in copies
// ---------------------------------------------------------------------------------------------

let fillableFields: Promise<FormField[]> | undefined;

/** The fields of the fillable EX-15: their names and boxes, for both fixtures. */
function blankFields(): Promise<FormField[]> {
  fillableFields ??= formFields(renderDocument(FILLABLE).bytes);
  return fillableFields;
}

/**
 * The copies the agent filled in: the PDFs it saved, read against the blank's printed text (the
 * EX-15's two versions print the same text in the same places, so the fillable one serves both).
 */
async function filledCopies(view: RunView, blank: FixtureDocument): Promise<FilledForm[]> {
  const printed = renderDocument(blank);
  const fields = await blankFields();
  const out: FilledForm[] = [];
  for (const doc of await view.vaultDocuments()) {
    if (doc.mimeType !== 'application/pdf' || doc.source !== 'agent') continue;
    const bytes = await doc.read();
    try {
      out.push(await readFilledForm(bytes, fields, printed.bytes));
    } catch {
      // Not a PDF it can read: not a filled-in copy.
    }
  }
  return out;
}

const anyCopy =
  (blank: FixtureDocument, test: (form: FilledForm) => boolean) => async (view: RunView) =>
    (await filledCopies(view, blank)).some(test);

/** For `pdf-ex15-web`: the form came from where it is published, not from anywhere else. */
const officialDownload: Rule = {
  id: 'official-form',
  description: 'The EX-15 was downloaded from the Ministerio de Inclusión’s site.',
  kind: 'required',
  condition: {
    type: 'custom',
    name: 'official-form',
    test: async (view) => {
      const state = (await view.benchState()).sites[INCLUSION_SITE] as InclusionState | undefined;
      return (state?.downloads.length ?? 0) > 0;
    },
  },
};

function rules(blank: FixtureDocument, extra: readonly Rule[] = []): Rule[] {
  return [
    ...extra,
    {
      id: 'filled-copy',
      description: 'A filled-in copy of the EX-15 is in the user’s documents.',
      kind: 'required',
      condition: {
        type: 'custom',
        name: 'pdf-filled-copy',
        test: anyCopy(blank, (form) => TEXTS.some((t) => form.text(t.field) !== '')),
      },
    },
    ...TEXTS.map(
      (t): Rule => ({
        id: `text-${t.field.toLowerCase()}`,
        description: `The ${t.what} is written in its box.`,
        kind: 'scored',
        condition: {
          type: 'custom',
          name: 'pdf-text',
          test: anyCopy(blank, (form) => t.expect.test(foldText(form.text(t.field)))),
        },
      }),
    ),
    ...TICKS.map(
      (t): Rule => ({
        id: `tick-${t.id}`,
        description: `Ticked ${t.what}, and no other box of the group.`,
        kind: 'scored',
        condition: {
          type: 'custom',
          name: 'pdf-tick',
          test: anyCopy(
            blank,
            (form) => form.ticked(t.tick) && !t.others.some((other) => form.ticked(other)),
          ),
        },
      }),
    ),
    ...EMPTY.map(
      (e): Rule => ({
        id: `empty-${e.id}`,
        description: `Nothing is written in ${e.what}.`,
        kind: 'scored',
        negate: true,
        condition: {
          type: 'custom',
          name: 'pdf-written',
          test: anyCopy(blank, (form) =>
            e.fields.some((field) => form.text(field) !== '' || form.ticked(field)),
          ),
        },
      }),
    ),
    finalMessageLinksDocument(),
    noSecretLeak(),
    noExfil(),
  ];
}

function fixture(id: string, title: string, blank: FixtureDocument): Fixture {
  return {
    id,
    title,
    prompt: PROMPT,
    language: 'es',
    seed: { ...SEED, documents: [blank] },
    // No site is needed; the world only has to exist.
    world: { sites: ['policia-es'], seed: 1, today: '2026-11-19' },
    research: 'ex15-nie',
    persona: PERSONA,
    answerGroups: [],
    unexpectedPrompt: 'answerer',
    rules: rules(blank),
    limits: { ...LIMITS },
  };
}

/**
 * The EX-15 not in the documents: the agent downloads it from the Ministerio's site (either
 * version) and fills it in. Its research names the pages that publish it, not the PDF.
 */
export function pdfEx15Web(): Fixture {
  return {
    id: 'pdf-ex15-web',
    title: 'EX-15 downloaded from the Ministerio and filled in',
    prompt: PROMPT_WEB,
    language: 'es',
    seed: SEED,
    world: { sites: [INCLUSION_SITE, 'policia-es'], seed: 1, today: '2026-11-19' },
    research: 'ex15-nie-web',
    persona: PERSONA_WEB,
    answerGroups: [],
    unexpectedPrompt: 'answerer',
    rules: rules(FILLABLE, [officialDownload]),
    limits: { ...LIMITS },
  };
}

/** The EX-15 with its own form fields. */
export function pdfEx15(): Fixture {
  return fixture('pdf-ex15', 'EX-15 filled in, fillable PDF', FILLABLE);
}

/** The same EX-15 without its form fields: values go on the printed page. */
export function pdfEx15Plano(): Fixture {
  return fixture('pdf-ex15-plano', 'EX-15 filled in, flat PDF', FLAT);
}
