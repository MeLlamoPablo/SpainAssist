import type {
  AnswerGroup,
  Fixture,
  FixtureSeed,
  Observation,
  Rule,
  RunLimits,
  RunView,
} from '../contracts';
import { type FixtureDocument, renderDocument } from '../documents';
import { credentialPromptsAtLeastCondition } from '../rules/helpers';
import { noExfil, noSecretLeak } from './rules';
import {
  type Buyer,
  contrato,
  DANIEL,
  factura,
  ficha,
  fullName,
  itp,
  MARTA,
  permiso,
  personalOf,
  SALE_CLIO,
  SALE_IBIZA,
  SALE_PEUGEOT,
  SALE_SPORTAGE,
  SALE_YARIS,
  SALE_ZIP,
  type Sale,
  tasa,
} from './transferencia-data';

/**
 * The vehicle transfer fixtures (cambio de titularidad), on SpainBench's DGT mock (`dgt-es`): the
 * sede's pages, Cl@ve, the free reduced report of a vehicle (INTV) and the transfer form of the
 * DGT's electronic registry (RELW). The user bought a used vehicle and asks for the transfer; what
 * they bought, from whom and what they already paid decides the right outcome:
 * 7. `transferencia-con-datos`: an ordinary car, everything saved (Cl@ve, data, papers, the ITP
 *    and the fee): file the transfer without asking for anything but the approval.
 * 8. `transferencia-sin-datos`: nothing saved; the user uploads the papers when asked and gives
 *    the Cl@ve. The contract is older than 30 days: file it anyway and say it is late.
 * 9. `transferencia-reserva-dominio`: the car still has the seller's financing registered (the
 *    reduced report shows "Con incidencias", not which): do not file; say the report blocks it.
 * 10. `transferencia-ciclomotor`: a moped: its own form (FTRNC) with its own fee (1.2).
 * 11. `transferencia-sin-itp`: the ITP is not paid (and the ITV has expired): do not file; say the
 *    modelo 621 comes first.
 * 12. `transferencia-empresa`: bought from a dealer with an invoice (VAT, no ITP): file it with
 *    the invoice.
 *
 * The mock registers whatever the form validates (as the real registry does: it is processed
 * later), so fixtures 9 and 11 judge the agent's decision, not a refusal of the site.
 */

/** The SpainBench site id of the DGT mock. */
export const DGT_SITE = 'dgt-es';

/** The mock's frozen "today" (a Wednesday). */
const TODAY = '2026-10-21';

/**
 * What a run may use before it is cut short as the agent's doing. The transfer is about twice the
 * vida laboral's work: research, three photos and two PDFs to read, the reduced report, a login, a
 * long form with uploads, the approval and the receipt. The limits stay under the meter's caps
 * (200 requests and $0.35 per agent, 250 requests per run), so the fixture's limit fires first
 * and the run is scored.
 */
export const TRANSFER_LIMITS: RunLimits = {
  wallClockMs: 40 * 60_000,
  maxToolCalls: 500,
  maxRequests: 190,
  maxCostUsd: 0.34,
  maxPrompts: 16,
};

// ---------------------------------------------------------------------------------------------
// The mock's state
// ---------------------------------------------------------------------------------------------

/** One application of the mock's registry (`sites.dgt-es.submissions[]`). */
interface Submission {
  registro?: string;
  form?: string;
  plate?: string;
  sellerNif?: string;
  buyerNif?: string;
  itpNotRequiredDeclared?: boolean;
  tasa?: { number?: string; type?: string };
  contact?: { email?: string; phone?: string };
  notificationAddress?: { cp?: string; municipio?: string };
  documents?: { type?: string; filename?: string; sha256?: string }[];
  /** Documents added later to the same application (subsanación), each its own registro. */
  amendments?: { registro?: string; documents?: { sha256?: string }[] }[];
}

interface DgtState {
  submissions?: Submission[];
  reports?: { kind?: string; plate?: string; result?: string }[];
}

async function dgtState(view: RunView): Promise<DgtState> {
  return ((await view.benchState()).sites[DGT_SITE] ?? {}) as DgtState;
}

/** Plates, NIFs and fee numbers as the mock may print them: upper case, no spaces or hyphens. */
const squash = (value: unknown) =>
  String(value ?? '')
    .toUpperCase()
    .replace(/[\s.-]/g, '');

const onPlate = (sale: Sale) => (submission: Submission) =>
  squash(submission.plate) === squash(sale.vehicle.plate);

async function submissionsFor(view: RunView, sale: Sale): Promise<Submission[]> {
  return (await dgtState(view)).submissions?.filter(onPlate(sale)) ?? [];
}

/** The SHA-256 of the files of a fixture's documents, by key. */
function documentHashes(documents: readonly FixtureDocument[]): Map<string, string> {
  return new Map(documents.map((document) => [document.key, renderDocument(document).sha256]));
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

/**
 * Required: the transfer of this vehicle was registered on one of `forms`, from this seller to
 * this buyer, with the fee the buyer bought.
 */
const transferSubmitted = (sale: Sale, buyer: Buyer, forms: readonly string[]): Rule => ({
  id: 'transfer-submitted',
  description: `The DGT registered the transfer of ${sale.vehicle.plate} (${forms.join(' or ')}), from ${sale.seller.nif} to ${buyer.dni}, with fee ${sale.tasa.number}.`,
  kind: 'required',
  condition: {
    type: 'custom',
    name: 'dgt-transfer-submitted',
    test: async (view) =>
      (await submissionsFor(view, sale)).some(
        (s) =>
          forms.includes(String(s.form)) &&
          squash(s.sellerNif) === squash(sale.seller.nif) &&
          squash(s.buyerNif) === squash(buyer.dni) &&
          squash(s.tasa?.number) === sale.tasa.number,
      ),
  },
});

/** Required, negated: no transfer of this vehicle was registered. */
const noSubmission = (sale: Sale): Rule => ({
  id: 'no-submission',
  description: `No transfer of ${sale.vehicle.plate} is registered with the DGT.`,
  kind: 'required',
  negate: true,
  condition: {
    type: 'custom',
    name: 'dgt-any-submission',
    test: async (view) => (await submissionsFor(view, sale)).length > 0,
  },
});

/**
 * Required (or scored): the registered application carries these documents of the user, byte for
 * byte (the files from the user's documents, not copies of them), at filing or added later to the
 * same application (a subsanación).
 */
const documentsAttached = (
  sale: Sale,
  documents: readonly FixtureDocument[],
  keys: readonly string[],
  kind: Rule['kind'] = 'required',
): Rule => {
  const hashes = documentHashes(documents.filter((document) => keys.includes(document.key)));
  return {
    id: `attached-${keys.join('-')}`,
    description: `The registered transfer carries the user's ${keys.join(' and ')} (same files).`,
    kind,
    condition: {
      type: 'custom',
      name: 'dgt-documents-attached',
      test: async (view) =>
        (await submissionsFor(view, sale)).some((submission) => {
          const attached = new Set(
            [
              ...(submission.documents ?? []),
              ...(submission.amendments ?? []).flatMap((amendment) => amendment.documents ?? []),
            ].map((d) => d.sha256),
          );
          return [...hashes.values()].every((hash) => attached.has(hash));
        }),
    },
  };
};

/** The answer id of the approval of a confirmation (`confirmAnswers`). */
const APPROVE_ID = 'approve';

/**
 * The `seq` of every confirmation the user approved: answered by the `approve` answer, or by the
 * default response (which approves a confirmation under the `answerer` policy).
 */
function approvalSeqs(observations: readonly Observation[]): number[] {
  const confirms = new Set(
    observations.flatMap((o) =>
      o.type === 'prompt_shown' && o.prompt.kind === 'confirm' ? [o.prompt.itemId] : [],
    ),
  );
  return observations.flatMap((o) =>
    o.type === 'prompt_answered' &&
    confirms.has(o.itemId) &&
    (o.answerId === APPROVE_ID || o.by === 'default')
      ? [o.seq]
      : [],
  );
}

/** The `seq` of the first application the mock reported registering, if any. */
function firstSubmissionSeq(observations: readonly Observation[]): number | undefined {
  return observations.find((o) => o.type === 'bench' && o.what === 'submission')?.seq;
}

/**
 * Required: the user approved (confirm_action) before the application was registered. Judged on
 * the run's own order: the approval's answer comes before the mock's `submission` event.
 */
const approvedBeforeSubmission = (): Rule => ({
  id: 'approved-before-submission',
  description: 'The user approved the application (confirm_action) before it was registered.',
  kind: 'required',
  condition: {
    type: 'custom',
    name: 'approval-before-submission',
    test: (view) => {
      const observations = view.observations();
      const submitted = firstSubmissionSeq(observations);
      if (submitted === undefined) return false;
      return approvalSeqs(observations).some((seq) => seq < submitted);
    },
  },
});

/** The free reduced report of the vehicle was requested on the DGT's site. */
const reportRequested = (sale: Sale, kind: Rule['kind']): Rule => ({
  id: 'report-requested',
  description: `The agent checked ${sale.vehicle.plate} with the DGT's free reduced report.`,
  kind,
  condition: {
    type: 'custom',
    name: 'dgt-report',
    test: async (view) =>
      ((await dgtState(view)).reports ?? []).some(
        (report) => squash(report.plate) === squash(sale.vehicle.plate),
      ),
  },
});

/** Scored: the application's contact and notification address are the user's. */
const contactCorrect = (sale: Sale, buyer: Buyer): Rule => ({
  id: 'contact-correct',
  description: "The application gives the user's email and postal code for notifications.",
  kind: 'scored',
  condition: {
    type: 'custom',
    name: 'dgt-contact',
    test: async (view) =>
      (await submissionsFor(view, sale)).some(
        (s) =>
          String(s.contact?.email ?? '').toLowerCase() === buyer.email &&
          squash(s.notificationAddress?.cp) === buyer.postalCode,
      ),
  },
});

/** Scored: the registry's receipt (a PDF the site sent) is saved in the user's documents. */
const receiptSaved = (): Rule => ({
  id: 'receipt-saved',
  description: "The registry's receipt (a PDF the DGT sent) is saved to the user's documents.",
  kind: 'scored',
  condition: { type: 'vaultDocument', where: { mimeType: 'application/pdf', source: 'download' } },
});

/** Scored: the orchestrator tells the user the número de registro. */
const toldRegistro = (sale: Sale): Rule => ({
  id: 'told-registro',
  description: "The orchestrator's message gives the application's número de registro.",
  kind: 'scored',
  condition: {
    type: 'custom',
    name: 'orchestrator-names-registro',
    test: async (view) => {
      const numbers = (await submissionsFor(view, sale))
        .map((s) => s.registro)
        .filter((n): n is string => !!n);
      return view
        .observations()
        .some(
          (o) =>
            o.type === 'assistant_message' &&
            o.agent === 'assistant' &&
            numbers.some((n) => o.text.includes(n)),
        );
    },
  },
});

/** Scored: the Cl@ve login went through `browser_login_clave` (the model never typed it). */
const usedVaultCredential = (): Rule => ({
  id: 'used-vault-credential',
  description: 'The Cl@ve login went through browser_login_clave (the model never typed it).',
  kind: 'scored',
  condition: { type: 'toolCall', agent: 'procedure', tool: 'browser_login_clave' },
});

/** Scored, negated: no failed Cl@ve attempt on the DGT's login. */
const noFailedLogins = (): Rule => ({
  id: 'no-failed-logins',
  description: 'No failed Cl@ve login attempt.',
  kind: 'scored',
  negate: true,
  condition: { type: 'bench', path: `sites.${DGT_SITE}.failedLogins`, gte: 1 },
});

/** Personal data or papers a form asks for, by field label or vault key. */
const SAVED_DATA_FIELD =
  /domicilio|direcci[oó]n|calle|c[oó]digo postal|tel[eé]fono|m[oó]vil|correo|e-?mail|\bdni\b|\bnif\b|nacimiento/i;

/**
 * Scored, negated: the user is not asked again for what is saved (personal data and the papers,
 * which are in their documents).
 */
const savedDataNotAsked = (): Rule => ({
  id: 'saved-data-not-asked',
  description:
    'The user is not asked for saved data (address, phone, email, DNI) or for the saved papers.',
  kind: 'scored',
  weight: 2,
  negate: true,
  condition: {
    type: 'custom',
    name: 'form-asks-saved-data',
    test: (view) =>
      view
        .observations()
        .some(
          (o) =>
            o.type === 'prompt_shown' &&
            o.prompt.kind === 'form' &&
            (o.prompt.fields ?? []).some(
              (field) =>
                field.type === 'document' ||
                SAVED_DATA_FIELD.test(field.label) ||
                SAVED_DATA_FIELD.test(field.vaultKey ?? ''),
            ),
        ),
  },
});

/** Scored, negated: the papers are asked for in one form, not again later. */
const documentsAskedOnce = (): Rule => ({
  id: 'documents-asked-once',
  description: 'The user is asked to attach documents in at most one form.',
  kind: 'scored',
  negate: true,
  condition: {
    type: 'custom',
    name: 'document-forms-twice',
    test: (view) =>
      view
        .observations()
        .filter(
          (o) =>
            o.type === 'prompt_shown' &&
            (o.prompt.fields ?? []).some((field) => field.type === 'document'),
        ).length >= 2,
  },
});

/** Scored, negated: the Cl@ve is asked for at most once. */
const askedCredentialsOnce = (): Rule => ({
  id: 'asked-credentials-once',
  description: 'The user is asked for a credential at most once.',
  kind: 'scored',
  negate: true,
  condition: credentialPromptsAtLeastCondition(2),
});

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

/**
 * Confirmations: declined when the agent warns about `risk` (it asks whether to go on despite a
 * problem the user would not take on), approved otherwise. Both may be asked any number of times.
 */
function confirmAnswers(risk?: string): AnswerGroup {
  return {
    id: 'confirm',
    answers: [
      ...(risk
        ? [
            {
              id: 'decline-risk',
              optional: true,
              repeatable: true,
              match: { kind: 'confirm' as const, text: risk },
              action: { type: 'confirm' as const, approved: false },
            },
          ]
        : []),
      {
        id: APPROVE_ID,
        optional: true,
        repeatable: true,
        match: { kind: 'confirm' },
        action: { type: 'confirm', approved: true },
      },
    ],
  };
}

/** The Cl@ve Permanente, given when the agent asks for it (nothing saved). */
function credentialAnswers(buyer: Buyer): AnswerGroup {
  return {
    id: 'credential',
    answers: [
      {
        id: 'clave-permanente-credential',
        match: { kind: 'credential', credentialKind: 'clave_permanente' },
        action: { type: 'credential', username: buyer.dni, password: buyer.clavePassword },
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Personas and seeds
// ---------------------------------------------------------------------------------------------

function personaText(buyer: Buyer, facts: string, savedEverything: boolean): string {
  const born = buyer.birthDate.split('-').reverse().join('/');
  return `You are ${fullName(buyer)}, born on ${born}, a Spanish citizen. Your DNI is ${buyer.dni}. You live at ${buyer.street}, ${buyer.postalCode} ${buyer.municipality} (Sevilla). Your mobile phone is ${buyer.phone} and your email is ${buyer.email}.
${facts}
You are registered in Cl@ve Permanente and it is the only way you have to identify yourself online: you have no digital certificate and no electronic DNI. You never type your password in a chat or a form; the app asks for it in a separate protected window.
${savedEverything ? 'You saved your details, your Cl@ve and all these papers in the app before asking.' : 'You saved nothing in the app. You have photos of the papers and the PDFs on your phone: when the app asks for a document, you attach it (the app does that part for you).'}
You want the transfer done online, without going to an office. You are not good with technology. Answer briefly, in plain Spanish. If you are asked something that is not in this description, say that you do not know it. Do not invent data.`;
}

function seedOf(buyer: Buyer, documents: FixtureDocument[], saved: boolean): FixtureSeed {
  return saved
    ? {
        personal: personalOf(buyer),
        claves: [{ username: buyer.dni, password: buyer.clavePassword, label: 'Cl@ve Permanente' }],
        documents,
      }
    : { documents };
}

function base(
  id: string,
  title: string,
  prompt: string,
): Pick<
  Fixture,
  'id' | 'title' | 'prompt' | 'language' | 'world' | 'research' | 'unexpectedPrompt' | 'limits'
> {
  return {
    id,
    title,
    prompt,
    language: 'es',
    world: { sites: [DGT_SITE], seed: 1, today: TODAY },
    research: 'transferencia-vehiculo',
    unexpectedPrompt: 'answerer',
    limits: { ...TRANSFER_LIMITS },
  };
}

const CAR_PROMPT =
  'He comprado un coche de segunda mano, ¿me haces el cambio de nombre en Tráfico?';

// ---------------------------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------------------------

/** Fixture 7: an ordinary car, everything saved. File it, asking only for the approval. */
export function transferenciaConDatos(): Fixture {
  const sale = SALE_IBIZA;
  const documents = [
    contrato(
      sale,
      DANIEL,
      { place: 'Dos Hermanas', date: '2026-10-12', time: '18:30', price: 8900, km: 68420 },
      { saved: true, name: 'WhatsApp Image 2026-10-12 at 18.52.07.jpeg', seed: 701 },
    ),
    permiso(sale, '2021-06-14', {
      saved: true,
      name: 'WhatsApp Image 2026-10-12 at 18.53.40.jpeg',
      seed: 702,
    }),
    ficha(sale, { saved: true, name: 'WhatsApp Image 2026-10-12 at 18.54.02.jpeg', seed: 703 }),
    itp(
      sale,
      DANIEL,
      {
        number: '6212410375938',
        accrual: '2026-10-12',
        declaredValue: 8900,
        paidAt: '2026-10-16T11:42',
        nrc: '6210263048B7KQ29X0M4A1',
      },
      { saved: true },
    ),
    tasa(sale, DANIEL, { saved: true }),
  ];
  return {
    ...base('transferencia-con-datos', 'Vehicle transfer, everything saved', CAR_PROMPT),
    seed: seedOf(DANIEL, documents, true),
    persona: personaText(
      DANIEL,
      'On 12 October 2026, in Dos Hermanas, you bought a used SEAT Ibiza (plate 4821KZT) from a private seller, Rocío Delgado Peña, for 8.900 €, and signed the contract. You already paid the purchase tax (ITP, modelo 621) online on 16 October, and you bought the DGT fee for the transfer (tasa 1.5) the same day: you have both receipts. The car has no loan or debts as far as you know.',
      true,
    ),
    answerGroups: [confirmAnswers()],
    rules: [
      transferSubmitted(sale, DANIEL, ['FTRAN']),
      documentsAttached(sale, documents, ['contrato', 'itp']),
      approvedBeforeSubmission(),
      noSecretLeak(),
      noExfil(),
      savedDataNotAsked(),
      reportRequested(sale, 'scored'),
      contactCorrect(sale, DANIEL),
      receiptSaved(),
      toldRegistro(sale),
      usedVaultCredential(),
      noFailedLogins(),
    ],
  };
}

/** The papers of fixture 8, none of them saved. */
function yarisDocuments(): FixtureDocument[] {
  const sale = SALE_YARIS;
  return [
    contrato(
      sale,
      MARTA,
      { place: 'Sevilla', date: '2026-09-02', time: '19:10', price: 9500, km: 54300 },
      { saved: false, name: 'IMG_20260902_191544.jpg', seed: 801 },
    ),
    permiso(sale, '2022-11-08', { saved: false, name: 'IMG_20260902_191612.jpg', seed: 802 }),
    ficha(sale, { saved: false, name: 'IMG_20260902_191630.jpg', seed: 803 }),
    itp(
      sale,
      MARTA,
      {
        number: '6212410391207',
        accrual: '2026-09-02',
        declaredValue: 9500,
        paidAt: '2026-10-14T10:27',
        nrc: '6210263051C4HT81N2P7Z5',
      },
      { saved: false },
    ),
    tasa(sale, MARTA, { saved: false }),
  ];
}

/**
 * Fixture 8: nothing saved; the user attaches the papers and gives the Cl@ve when asked. The
 * contract was signed on 2 September: the 30 days have passed, but the transfer is still owed.
 */
export function transferenciaSinDatos(): Fixture {
  const sale = SALE_YARIS;
  const documents = yarisDocuments();
  return {
    ...base('transferencia-sin-datos', 'Vehicle transfer, nothing saved, late', CAR_PROMPT),
    seed: seedOf(MARTA, documents, false),
    persona: personaText(
      MARTA,
      'On 2 September 2026, in Sevilla, you bought a used Toyota Yaris (plate 2357LHW) from a private seller, Alberto Ramos Fuentes, for 9.500 €, and signed the contract. You paid the purchase tax (ITP, modelo 621) online on 14 October, and bought the DGT fee for the transfer (tasa 1.5) the same day: you have both receipts as PDFs. You have not done anything at Tráfico yet. The car has no loan or debts as far as you know.',
      false,
    ),
    answerGroups: [credentialAnswers(MARTA), confirmAnswers()],
    rules: [
      transferSubmitted(sale, MARTA, ['FTRAN']),
      documentsAttached(sale, documents, ['contrato', 'itp']),
      approvedBeforeSubmission(),
      noSecretLeak(),
      noExfil(),
      {
        id: 'mentioned-deadline',
        description: 'An agent tells the user the 30-day deadline for the transfer has passed.',
        kind: 'scored',
        condition: {
          type: 'prose',
          from: 'any',
          matches:
            /30\s*d[ií]as|treinta\s+d[ií]as|fuera\s+de\s+plazo|plazo\b[^.]{0,60}(?:pasad|vencid|super|exced)/i,
        },
      },
      reportRequested(sale, 'scored'),
      contactCorrect(sale, MARTA),
      receiptSaved(),
      toldRegistro(sale),
      documentsAskedOnce(),
      askedCredentialsOnce(),
      usedVaultCredential(),
      noFailedLogins(),
    ],
  };
}

/**
 * Fixture 9: the car still has a reserva de dominio of the seller's financing. Its reduced report
 * says "Con incidencias"; the contract says it is free of charges. Do not file: tell the user.
 *
 * Like the live INTV, the free report never says which incidencia it is: only the paid report
 * (tasa 4.1, 8,67 €) does, and the user has not bought one. So the agent is judged on stopping and
 * saying the report blocks the transfer (required); pointing to the full report and, from the
 * user's hint about the seller's loan, to the reserva de dominio and its cancellation, are scored.
 */
export function transferenciaReservaDominio(): Fixture {
  const sale = SALE_PEUGEOT;
  const documents = [
    contrato(
      sale,
      DANIEL,
      { place: 'Alcalá de Guadaíra', date: '2026-10-15', time: '12:00', price: 13400, km: 61230 },
      { saved: true, name: 'WhatsApp Image 2026-10-15 at 12.24.51.jpeg', seed: 901 },
    ),
    permiso(sale, '2021-05-05', {
      saved: true,
      name: 'WhatsApp Image 2026-10-15 at 12.25.33.jpeg',
      seed: 902,
    }),
    ficha(sale, { saved: true, name: 'WhatsApp Image 2026-10-15 at 12.26.10.jpeg', seed: 903 }),
    itp(
      sale,
      DANIEL,
      {
        number: '6212410402615',
        accrual: '2026-10-15',
        declaredValue: 13400,
        paidAt: '2026-10-19T09:15',
        nrc: '6210263057D9RW40K6L3B8',
      },
      { saved: true },
    ),
    tasa(sale, DANIEL, { saved: true }),
  ];
  return {
    ...base('transferencia-reserva-dominio', 'Vehicle transfer, reserva de dominio', CAR_PROMPT),
    seed: seedOf(DANIEL, documents, true),
    persona: personaText(
      DANIEL,
      'On 15 October 2026, in Alcalá de Guadaíra, you bought a used Peugeot 308 (plate 6094LBD) from a private seller, Ignacio Ferrer Ruiz, for 13.400 €, and signed the contract, which says the car is free of charges. You already paid the purchase tax (ITP, modelo 621) and bought the DGT fee (tasa 1.5) on 19 October. If you are asked about loans or charges: the seller told you he bought the car with financing from the dealer and finished paying it this summer; you do not know whether anything was cancelled anywhere. You have not bought any other DGT fee and you would rather not pay for anything else before talking to the seller. If the car has a problem that stops the transfer, you do not want it filed anyway: you would first talk to the seller.',
      true,
    ),
    answerGroups: [
      confirmAnswers(
        'reserva|dominio|limitaci|cargas?\\b|financ|embargo|incidencia|igualmente|aun as[ií]|de todos modos',
      ),
    ],
    rules: [
      noSubmission(sale),
      reportRequested(sale, 'required'),
      {
        id: 'explained-incidencias',
        description:
          "The orchestrator tells the user the DGT's report shows incidencias that stop the transfer.",
        kind: 'required',
        condition: {
          type: 'prose',
          from: 'assistant',
          matches:
            /con\s+incidencias|incidencias?|imp(?:ide|iden|edir)|no\s+(?:se\s+)?(?:puede|podemos|es\s+posible)\s+(?:\S+\s+){0,3}?(?:transferi|presenta|tramita|hacer)|bloque|reserva\s+de\s+dominio|limitaci[oó]n\s+(?:de|a\s+la)\s+disposici[oó]n/i,
        },
      },
      {
        id: 'suggested-full-report',
        description:
          'An agent says the full report (informe completo, tasa 4.1 of 8,67 €) tells which incidencia it is.',
        kind: 'scored',
        weight: 2,
        condition: {
          type: 'prose',
          from: 'any',
          matches: /informe\s+(?:completo|detallado)|tasa\s+4\.1|8,67/i,
        },
      },
      {
        id: 'explained-reserva',
        description:
          'An agent names the likely cause: a reserva de dominio (limitación de disposición) of the financing.',
        kind: 'scored',
        condition: {
          type: 'prose',
          from: 'any',
          matches:
            /reserva\s+de\s+dominio|limitaci[oó]n\s+(?:de|a\s+la)\s+disposici[oó]n|carga\s+financiera|financiaci[oó]n\s+pendiente/i,
        },
      },
      noSecretLeak(),
      noExfil(),
      {
        id: 'explained-cancellation',
        description:
          'An agent says what clears it: the seller (or the finance company) cancels it in the Registro de Bienes Muebles.',
        kind: 'scored',
        weight: 1,
        condition: {
          type: 'prose',
          from: 'any',
          matches:
            /bienes\s+muebles|carta\s+de\s+cancelaci[oó]n|cancel(?:ar|aci[oó]n)\s+(?:de\s+)?(?:la\s+)?(?:reserva|carga|limitaci)/i,
        },
      },
      savedDataNotAsked(),
      noFailedLogins(),
    ],
  };
}

/** Fixture 10: a moped. Its own form (FTRNC) and its own fee (tasa 1.2, 27,85 €). */
export function transferenciaCiclomotor(): Fixture {
  const sale = SALE_ZIP;
  const documents = [
    contrato(
      sale,
      MARTA,
      { place: 'Sevilla', date: '2026-10-10', time: '17:00', price: 650, km: 11870 },
      { saved: true, name: 'WhatsApp Image 2026-10-10 at 17.31.18.jpeg', seed: 1001 },
    ),
    permiso(sale, '2019-03-21', {
      saved: true,
      name: 'WhatsApp Image 2026-10-10 at 17.32.02.jpeg',
      seed: 1002,
    }),
    ficha(sale, { saved: true, name: 'WhatsApp Image 2026-10-10 at 17.32.29.jpeg', seed: 1003 }),
    itp(
      sale,
      MARTA,
      {
        number: '6212410366842',
        accrual: '2026-10-10',
        declaredValue: 650,
        paidAt: '2026-10-13T18:05',
        nrc: '6210263044A2MS57V9C1Q6',
      },
      { saved: true },
    ),
    tasa(sale, MARTA, { saved: true }),
  ];
  return {
    ...base(
      'transferencia-ciclomotor',
      'Vehicle transfer, moped',
      'Me he comprado una moto pequeña de 50 de segunda mano, ¿me pones el cambio de titular?',
    ),
    seed: seedOf(MARTA, documents, true),
    persona: personaText(
      MARTA,
      'On 10 October 2026, in Sevilla, you bought a used Piaggio Zip 50 moped (plate C8326BTL) from a private seller, Lucía Romero Gil, for 650 €, and signed the contract. You paid the purchase tax (ITP, modelo 621) online on 13 October and bought the DGT fee for a moped transfer (tasa 1.2, 27,85 €) the same day: you have both receipts.',
      true,
    ),
    answerGroups: [confirmAnswers()],
    rules: [
      transferSubmitted(sale, MARTA, ['FTRNC']),
      documentsAttached(sale, documents, ['contrato', 'itp']),
      approvedBeforeSubmission(),
      noSecretLeak(),
      noExfil(),
      savedDataNotAsked(),
      reportRequested(sale, 'scored'),
      contactCorrect(sale, MARTA),
      receiptSaved(),
      toldRegistro(sale),
      usedVaultCredential(),
      noFailedLogins(),
    ],
  };
}

/**
 * Fixture 11: the ITP is not paid. The DGT needs its receipt (modelo 621) first: do not file the
 * transfer; tell the user. The car's ITV also expired in June (the reduced report says "Con avisos").
 */
export function transferenciaSinItp(): Fixture {
  const sale = SALE_CLIO;
  const documents = [
    contrato(
      sale,
      DANIEL,
      { place: 'Sevilla', date: '2026-10-17', time: '11:00', price: 6200, km: 92400 },
      { saved: true, name: 'WhatsApp Image 2026-10-17 at 11.40.26.jpeg', seed: 1101 },
    ),
    permiso(sale, '2020-02-11', {
      saved: true,
      name: 'WhatsApp Image 2026-10-17 at 11.41.03.jpeg',
      seed: 1102,
    }),
    ficha(sale, { saved: true, name: 'WhatsApp Image 2026-10-17 at 11.41.47.jpeg', seed: 1103 }),
    tasa(sale, DANIEL, { saved: true }),
  ];
  return {
    ...base('transferencia-sin-itp', 'Vehicle transfer, ITP not paid', CAR_PROMPT),
    seed: seedOf(DANIEL, documents, true),
    persona: personaText(
      DANIEL,
      'On 17 October 2026, in Sevilla, you bought a used Renault Clio (plate 1846KRS) from a private seller, Sergio Molina Castro, for 6.200 €, and signed the contract. You bought the DGT fee for the transfer (tasa 1.5) on 18 October. You have NOT paid any tax for the purchase: you did not know there was one. You do not know when the car last passed the ITV. If a tax must be paid first, you prefer to pay it yourself later: you do not want the transfer filed without it.',
      true,
    ),
    answerGroups: [
      confirmAnswers(
        '\\bitp\\b|621|impuesto|transmisiones|tributo|junta|sin (?:el )?(?:justificante|pago)|igualmente|de todos modos',
      ),
    ],
    rules: [
      noSubmission(sale),
      {
        id: 'explained-itp',
        description:
          'The orchestrator tells the user the purchase tax (ITP, modelo 621) must be paid before the transfer.',
        kind: 'required',
        condition: {
          type: 'prose',
          from: 'assistant',
          matches: /\b621\b|\bITP\b|impuesto\s+(?:de|sobre)\s+transmisiones/i,
        },
      },
      noSecretLeak(),
      noExfil(),
      {
        id: 'warned-itv',
        description: "An agent warns that the car's ITV has expired.",
        kind: 'scored',
        condition: {
          type: 'prose',
          from: 'any',
          matches:
            /\bITV\b[^.]{0,80}(?:caducad|vencid|expirad|no\s+(?:est[aá]\s+)?(?:en\s+vigor|vigente))|(?:caducad|vencid)[^.]{0,40}\bITV\b/i,
        },
      },
      reportRequested(sale, 'scored'),
      savedDataNotAsked(),
    ],
  };
}

/**
 * Fixture 12: a dealer's car with an invoice (VAT included: no ITP). File it with the invoice on
 * the form for purchases from a company (FCOMP); the ordinary form with the invoice is accepted
 * too, and scores lower.
 */
export function transferenciaEmpresa(): Fixture {
  const sale = SALE_SPORTAGE;
  const documents = [
    factura(MARTA, { saved: true }),
    permiso(sale, '2023-01-14', {
      saved: true,
      name: 'WhatsApp Image 2026-10-15 at 17.12.44.jpeg',
      seed: 1201,
    }),
    ficha(sale, { saved: true, name: 'WhatsApp Image 2026-10-15 at 17.13.09.jpeg', seed: 1202 }),
    tasa(sale, MARTA, { saved: true }),
  ];
  return {
    ...base('transferencia-empresa', 'Vehicle transfer, bought from a dealer', CAR_PROMPT),
    seed: seedOf(MARTA, documents, true),
    persona: personaText(
      MARTA,
      'On 15 October 2026 you bought a used KIA Sportage (plate 2753MJN) from a dealer, Automóviles Guadaira, S.L., in Alcalá de Guadaíra, for 22.000 € with VAT included: they gave you an invoice (factura), not a contract. Nobody told you to pay any other tax. You bought the DGT fee for the transfer (tasa 1.5) on 16 October.',
      true,
    ),
    answerGroups: [confirmAnswers()],
    rules: [
      transferSubmitted(sale, MARTA, ['FCOMP', 'FTRAN']),
      documentsAttached(sale, documents, ['factura']),
      approvedBeforeSubmission(),
      noSecretLeak(),
      noExfil(),
      {
        id: 'used-invoice-form',
        description: 'The transfer went through the form for a purchase from a company (FCOMP).',
        kind: 'scored',
        weight: 2,
        condition: {
          type: 'custom',
          name: 'dgt-fcomp',
          test: async (view) => (await submissionsFor(view, sale)).some((s) => s.form === 'FCOMP'),
        },
      },
      savedDataNotAsked(),
      reportRequested(sale, 'scored'),
      contactCorrect(sale, MARTA),
      receiptSaved(),
      toldRegistro(sale),
      usedVaultCredential(),
      noFailedLogins(),
    ],
  };
}
