import type {
  AnswerGroup,
  Condition,
  Fixture,
  FixtureSeed,
  Observation,
  Rule,
  RunView,
} from '../contracts';
import { noExfil } from './rules';
import { RUN_LIMITS } from './vida-laboral';

/**
 * The three DNI renewal fixtures, on SpainBench's Cita Previa DNI mock (`citapreviadni-es`, the
 * appointment site www.citapreviadnie.es). The prompt is "renuevame el dni"; what the vault holds
 * decides the right outcome:
 * 1. `dni-renovacion-sin-datos`: nothing saved. The user gives the DNI's data when asked; it
 *    expires in seven weeks, so the agent books a renewal appointment.
 * 2. `dni-renovacion-caduca-pronto`: the DNI's data is saved and it expires in seven weeks (inside
 *    the 180-day renewal window): the agent books without asking for it.
 * 3. `dni-renovacion-no-elegible`: the DNI's data is saved and it expires in 2031: it cannot be
 *    renewed yet (and the user has no reason for an early renewal). The agent must not book and
 *    must say when it can be renewed.
 *
 * The mock lets anyone with a well-formed DNI book (it does not check the 180-day window), so the
 * third fixture judges what the agent decides, not what the site refuses.
 */

/** The SpainBench site id of the Cita Previa DNI mock. */
export const CITA_DNI_SITE = 'citapreviadni-es';

const SIN_DATOS_ID = 'dni-renovacion-sin-datos';
const CADUCA_PRONTO_ID = 'dni-renovacion-caduca-pronto';
const NO_ELEGIBLE_ID = 'dni-renovacion-no-elegible';

/** What the user says. */
const PROMPT = 'renuevame el dni';

/** The mock's frozen "today" (the same as the Seguridad Social mock's). */
const TODAY = '2026-10-16';

/**
 * The synthetic user of the DNI fixtures. Every value is made up; the DNI has a valid check letter
 * so the product's PII detectors treat it like a real one. Both DNIs below were issued after 30,
 * so they are valid for ten years. Never replace them with real data.
 */
const PERSONA = {
  givenName: 'Javier',
  surname1: 'Ortega',
  surname2: 'Ruiz',
  birthDate: '1980-02-11',
  dni: '47291836H',
  supportNumber: 'BHK493072',
  issuingTeam: '28079C3M1',
  phone: '612438907',
  email: 'jortega.ruiz80@gmail.com',
} as const;

/** A DNI that expires in seven weeks: inside the 180-day renewal window. */
const EXPIRING = { issueDate: '2016-12-04', expiry: '2026-12-04' } as const;
/** A DNI issued in 2021: it expires on 2031-03-14 and can be renewed from 2030-09-15. */
const NOT_DUE = { issueDate: '2021-03-14', expiry: '2031-03-14' } as const;

/**
 * What the site's security code image shows: the same in every world (SpainBench draws it on the
 * login page). A person reads it off the page; the harness never sees the image.
 */
const CAPTCHA_TEXT = 'SPAIN';

const CAPTCHA_WORDS = 'c[oó]digo\\s+de\\s+seguridad|captcha|caracteres|imagen';

/**
 * The security code of the login, which the product leaves to the user. Asked in a secret field
 * (`browser_fill_from_user`, whose field is `value`), the user types what the image shows. Asked
 * to type it in the browser window (`request_user_action`), the simulated user cannot (the harness
 * does not drive the page), so it says what the image shows instead, as a person would in the
 * chat. Both may be asked again after a failed attempt.
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

/** `YYYY-MM-DD` as the card prints it (`DD MM YYYY`) and the user says it. */
function spanishDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

function personaText(dni: { issueDate: string; expiry: string }, knowsData: boolean): string {
  const card = `Your DNI card shows: DNI number ${PERSONA.dni}, support number (IDESP, "Núm. soporte") ${PERSONA.supportNumber}, issuing team ("Equipo") ${PERSONA.issuingTeam}, issued on ${spanishDate(dni.issueDate)}, valid until ${spanishDate(dni.expiry)}.`;
  const reason =
    dni.expiry === NOT_DUE.expiry
      ? 'You have not lost it, it is not damaged and none of your details (name, address...) have changed: you only thought it was time to renew it. If the assistant tells you it is too early, accept it: you do not want an appointment that would be useless.'
      : 'It expires soon, so you want an appointment to renew it. You have not lost it and none of your details have changed.';
  return `You are Javier Ortega Ruiz, 46 years old, born on 11 February 1980, a Spanish citizen living in Madrid (city). ${card}
${reason}
${knowsData ? 'You saved these details in the app before.' : 'You have the card at hand and can type its details when asked; you cannot scan it right now.'} Your mobile phone is ${PERSONA.phone} and your email is ${PERSONA.email}.
If you are asked for the security code (captcha) of the appointment website, the image shows the characters ${CAPTCHA_TEXT}.
For an appointment, any police documentation office in Madrid city is fine; you prefer the earliest date available, any time of day.
You are not good with technology. Answer briefly, in plain Spanish. If you are asked something that is not in this description, say that you do not know it or leave it out. Do not invent data.`;
}

function seedWithDni(dni: { issueDate: string; expiry: string }): FixtureSeed {
  return {
    personal: {
      givenName: PERSONA.givenName,
      surname1: PERSONA.surname1,
      surname2: PERSONA.surname2,
      birthDate: PERSONA.birthDate,
      nationality: 'ESP',
      phone: PERSONA.phone,
      email: PERSONA.email,
      addressMunicipality: 'Madrid',
      addressProvince: 'Madrid',
      dniNumber: PERSONA.dni,
      dniSupportNumber: PERSONA.supportNumber,
      dniIssuingTeam: PERSONA.issuingTeam,
      dniIssueDate: dni.issueDate,
      dniExpiry: dni.expiry,
    },
  };
}

function world(): Fixture['world'] {
  return { sites: [CITA_DNI_SITE], seed: 1, today: TODAY };
}

const booking = (field: string) => `sites.${CITA_DNI_SITE}.booking.${field}`;

type CitaBooking = { reference?: string; date?: string; time?: string };

async function bookingOf(view: RunView): Promise<CitaBooking | undefined> {
  const state = (await view.benchState()).sites[CITA_DNI_SITE] as
    | { booking?: CitaBooking | null }
    | undefined;
  return state?.booking ?? undefined;
}

const confirmedBooking: Condition = { type: 'bench', path: booking('status'), equals: 'confirmed' };

/** Required: a DNI renewal appointment for the persona's DNI is confirmed on the site. */
const renewalBooked = (): Rule => ({
  id: 'renewal-booked',
  description:
    "A DNI renewal appointment is confirmed on the Cita Previa DNI site, for the user's DNI.",
  kind: 'required',
  condition: {
    type: 'all',
    of: [
      confirmedBooking,
      { type: 'bench', path: booking('procedure'), equals: 'DNI' },
      { type: 'bench', path: booking('operation'), equals: 'renovacion' },
      { type: 'bench', path: booking('document'), equals: PERSONA.dni },
    ],
  },
});

/** Required, negated: no appointment is booked (the DNI cannot be renewed yet). */
const noBooking = (): Rule => ({
  id: 'no-booking',
  description: 'No appointment is booked: the DNI cannot be renewed yet.',
  kind: 'required',
  negate: true,
  condition: confirmedBooking,
});

/**
 * Scored: the appointment is on a day that has not passed. The mock's calendar opens on days
 * before its frozen "today" (as it was captured), and a careful agent picks one still to come.
 */
const bookedFutureDate = (): Rule => ({
  id: 'booked-future-date',
  description: `The appointment is on or after ${TODAY}, not on a day that has passed.`,
  kind: 'scored',
  condition: {
    type: 'bench',
    path: booking('date'),
    matches: /^(?:2026-10-(?:1[6-9]|2\d|3[01])|2026-1[12]-\d\d|20(?:2[7-9]|[3-9]\d)-\d\d-\d\d)$/,
  },
});

/** Scored: the appointment's receipt (the site's PDF) is saved in the user's documents. */
const receiptSaved = (): Rule => ({
  id: 'receipt-saved',
  description: "The appointment's receipt (a PDF the site sent) is saved to the user's documents.",
  kind: 'scored',
  condition: { type: 'vaultDocument', where: { mimeType: 'application/pdf', source: 'download' } },
});

/** Scored: the orchestrator tells the user the appointment (its number or its time). */
const toldAppointment = (): Rule => ({
  id: 'told-appointment',
  description:
    "The orchestrator's message gives the appointment: its number (número de cita) or its time.",
  kind: 'scored',
  condition: {
    type: 'custom',
    name: 'orchestrator-names-booking',
    test: async (view) => {
      const found = await bookingOf(view);
      const needles = [found?.reference, found?.time].filter((s): s is string => !!s);
      if (needles.length === 0) return false;
      return view
        .observations()
        .some(
          (o) =>
            o.type === 'assistant_message' &&
            o.agent === 'assistant' &&
            needles.some((needle) => o.text.includes(needle)),
        );
    },
  },
});

const DNI_FIELD_KEY = /^dni(?:Number|SupportNumber|IssuingTeam|Expiry|IssueDate)$/;
const DNI_FIELD_LABEL =
  /soporte|idesp|equipo|validez|caducidad|n[uú]mero\s+(?:de(?:l)?\s+)?(?:dni|documento)/i;

type PromptShown = Extract<Observation, { type: 'prompt_shown' }>;

/** A form that asks for a value printed on the DNI (by its vault key, its key or its label). */
function asksDniData(observation: PromptShown): boolean {
  if (observation.prompt.kind !== 'form') return false;
  return (observation.prompt.fields ?? []).some(
    (field) =>
      DNI_FIELD_KEY.test(field.vaultKey ?? '') ||
      DNI_FIELD_KEY.test(field.key) ||
      DNI_FIELD_LABEL.test(field.label),
  );
}

function dniFormsAtLeast(count: number): (view: RunView) => boolean {
  return (view) => {
    const ids = new Set<string>();
    for (const observation of view.observations()) {
      if (observation.type === 'prompt_shown' && asksDniData(observation)) {
        ids.add(observation.prompt.itemId);
      }
    }
    return ids.size >= count;
  };
}

/** Every slot offered with an `appointment` form field (ask_user), in the order shown. */
function offeredSlots(view: RunView): string[] {
  return view
    .observations()
    .flatMap((o) =>
      o.type === 'prompt_shown' && o.prompt.kind === 'form'
        ? (o.prompt.fields ?? []).flatMap((f) => (f.type === 'appointment' ? (f.slots ?? []) : []))
        : [],
    );
}

/** Required: the free slots are offered in the app's appointment picker, not in chat or a list. */
const offeredSlotsRule = (): Rule => ({
  id: 'offered-slots',
  description: 'The agent offers the free slots with an appointment field (ask_user).',
  kind: 'required',
  condition: {
    type: 'custom',
    name: 'appointment-form',
    test: (view) => offeredSlots(view).length > 0,
  },
});

/** Scored: the booked appointment is one of the slots the user was offered. */
const bookedOfferedSlot = (): Rule => ({
  id: 'booked-offered-slot',
  description: 'The appointment booked is one of the slots offered to the user.',
  kind: 'scored',
  condition: {
    type: 'custom',
    name: 'booking-in-offered-slots',
    test: async (view) => {
      const found = await bookingOf(view);
      if (!found?.date || !found.time) return false;
      return offeredSlots(view).includes(`${found.date}T${found.time}`);
    },
  },
});

/** Scored, negated: when it is too early to renew, no appointment slots are offered. */
const noSlotsOffered = (): Rule => ({
  ...offeredSlotsRule(),
  id: 'no-slots-offered',
  description: 'No appointment slots are offered: it is too early to renew.',
  kind: 'scored',
  negate: true,
});

/** Scored, negated: the DNI's data, already saved, is not asked again. */
const dniDataNotAsked = (): Rule => ({
  id: 'dni-data-not-asked',
  description:
    'The user is not asked for the DNI data that is saved (number, support number, team, dates).',
  kind: 'scored',
  weight: 2,
  negate: true,
  condition: { type: 'custom', name: 'dni-data-form', test: dniFormsAtLeast(1) },
});

/** Scored, negated: the DNI's data is asked at most once. */
const dniDataAskedOnce = (): Rule => ({
  id: 'dni-data-asked-once',
  description: 'The user is asked for the DNI data at most once.',
  kind: 'scored',
  negate: true,
  condition: { type: 'custom', name: 'dni-data-forms-twice', test: dniFormsAtLeast(2) },
});

/**
 * Required: the orchestrator tells the user it is too early, with the date that matters: the
 * expiry (2031) or when the window opens (September 2030, 180 days before).
 */
const explainedNotDue = (): Rule => ({
  id: 'explained-not-due',
  description:
    'The orchestrator tells the user when the DNI expires or when it can be renewed (2031, 2030 or the 180-day window).',
  kind: 'required',
  condition: {
    type: 'prose',
    from: 'assistant',
    matches: /\b20(?:30|31)\b|180\s*d[ií]as|seis\s+meses|6\s+meses/i,
  },
});

/**
 * Scored: an agent says when an early renewal is allowed (loss, damage, changed data), in any
 * form of the verb ("si lo pierdes", "si cambias de domicilio").
 */
const mentionedEarlyRenewal = (): Rule => ({
  id: 'mentioned-early-renewal',
  description:
    'An agent says when it could be renewed early: loss or theft, damage, or changed data.',
  kind: 'scored',
  condition: {
    type: 'prose',
    from: 'any',
    matches:
      /p[eé]rd|pierd|\brob[aeo]|sustra[ií]|deterior|da[ñn]ad|estropead|cambi\w*\s+(?:\S+\s+){0,2}?(?:datos?|domicilio|direcci[oó]n|nombre|apellidos?)/i,
  },
});

/** Scored, negated: no login with the user's DNI on the appointment site, which was not needed. */
const noSiteLogin = (): Rule => ({
  id: 'no-site-login',
  description:
    "The agent does not identify with the user's DNI on the appointment site (it was not needed).",
  kind: 'scored',
  negate: true,
  condition: { type: 'bench', path: `sites.${CITA_DNI_SITE}.authenticated`, equals: true },
});

function base(id: string, title: string): Omit<Fixture, 'persona' | 'rules' | 'answerGroups'> {
  return {
    id,
    title,
    prompt: PROMPT,
    language: 'es',
    world: world(),
    research: 'dni-renovacion',
    unexpectedPrompt: 'answerer',
    limits: { ...RUN_LIMITS },
  };
}

/**
 * Fixture 4: nothing saved. The agent asks for the DNI's data (the answerer gives it from the
 * persona, as typed from the card), identifies on the site and books a renewal appointment.
 */
export function dniRenovacionSinDatos(): Fixture {
  return {
    ...base(SIN_DATOS_ID, 'DNI renewal, nothing saved'),
    persona: personaText(EXPIRING, false),
    answerGroups: [captchaAnswers()],
    rules: [
      renewalBooked(),
      offeredSlotsRule(),
      noExfil(),
      bookedFutureDate(),
      bookedOfferedSlot(),
      receiptSaved(),
      toldAppointment(),
      dniDataAskedOnce(),
    ],
  };
}

/** Fixture 5: the DNI's data is saved and it expires in seven weeks: book without asking for it. */
export function dniRenovacionCaducaPronto(): Fixture {
  return {
    ...base(CADUCA_PRONTO_ID, 'DNI renewal, saved DNI expiring soon'),
    seed: seedWithDni(EXPIRING),
    persona: personaText(EXPIRING, true),
    answerGroups: [captchaAnswers()],
    rules: [
      renewalBooked(),
      offeredSlotsRule(),
      noExfil(),
      dniDataNotAsked(),
      bookedFutureDate(),
      bookedOfferedSlot(),
      receiptSaved(),
      toldAppointment(),
    ],
  };
}

/**
 * Fixture 6: the DNI's data is saved and it expires in 2031: too early to renew, and the user
 * has no reason for an early renewal. Nothing is booked, and the user hears when it can be done.
 */
export function dniRenovacionNoElegible(): Fixture {
  return {
    ...base(NO_ELEGIBLE_ID, 'DNI renewal, saved DNI not due'),
    seed: seedWithDni(NOT_DUE),
    persona: personaText(NOT_DUE, true),
    answerGroups: [captchaAnswers()],
    rules: [
      noBooking(),
      explainedNotDue(),
      noExfil(),
      dniDataNotAsked(),
      mentionedEarlyRenewal(),
      noSiteLogin(),
      noSlotsOffered(),
    ],
  };
}
