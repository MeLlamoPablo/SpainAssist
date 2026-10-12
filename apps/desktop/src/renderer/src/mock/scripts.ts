import type {
  Administration,
  DocumentKind,
  NextActionOwner,
  NoticeItem,
  ProcedureListItem,
  ProcedureStatus,
  ProcedureStep,
  ProcedureUpdate,
  Prompt,
  PromptResponse,
} from '@sa/shared';
import { DEMO_IDS, dniForm, type Lang, type Tr, translator, URLS } from './demo';

/**
 * Scripts of the fake agents. The assistant (orchestrator) runs `AStep`s in the conversation;
 * each procedure's agent runs `PStep`s into that procedure's activity log.
 */

/** One step of the assistant, in the conversation. */
export type AStep =
  | { kind: 'wait'; ms: number }
  /** Stream a markdown message into the conversation. */
  | { kind: 'say'; text: string }
  /** Call `procedure_start`: create the procedure and launch its agent. */
  | { kind: 'start'; plan: ProcedurePlan };

/** One step of a procedure's agent, in its activity log. */
export type PStep =
  | { kind: 'wait'; ms: number }
  | {
      kind: 'tool';
      tool: string;
      args?: Record<string, unknown>;
      summary?: string;
      imageId?: string;
      ms?: number;
      fail?: boolean;
    }
  /** Mark an activity already in the log (e.g. running in the demo data) as done. */
  | { kind: 'finish'; itemId: string; summary?: string }
  | { kind: 'update'; patch: ProcedureUpdate }
  | { kind: 'notice'; level: NoticeItem['level']; text: string }
  /** Ask the user in the conversation (the run pauses until they answer). */
  | { kind: 'ask'; prompt: Prompt; onAnswer: (r: PromptResponse) => PStep[] }
  | { kind: 'document'; name: string; docKind: DocumentKind; preview: [string, string] }
  /** End of the run: the agent's short report goes up; the assistant reacts with `reply`. */
  | { kind: 'report'; summary: string; reply: string; error?: boolean };

export interface ProcedurePlan {
  topic: string;
  title: string;
  brief: string;
  administration?: Administration;
  agent: PStep[];
}

type L = readonly [es: string, en: string];
const pick = (t: Tr, l: L) => t(l[0], l[1]);
const src = (title: string, url: string) => ({ title, url });

// ---------------------------------------------------------------------------------------------
// Understanding the user's message
// ---------------------------------------------------------------------------------------------

export function detectTopic(message: string): string | null {
  const m = message.toLowerCase();
  if (/pasaporte|passport/.test(m)) return 'pasaporte';
  if (/\bdni\b|carn[eé] de identidad|identity card/.test(m)) return 'dni';
  if (/empadron|padr[oó]n/.test(m)) return 'padron';
  if (/certificado digital|fnmt|digital certificate/.test(m)) return 'certificado';
  if (/\btie\b|\bnie\b|extranjer|residen/.test(m)) return 'tie';
  if (/\bparo\b|desempleo|\bsepe\b|unemploy/.test(m)) return 'paro';
  if (/vida laboral|work history/.test(m)) return 'vida';
  if (/\brenta\b|irpf|tax return/.test(m)) return 'renta';
  if (/hacienda|domicilio fiscal|tax agency/.test(m)) return 'hacienda';
  return null;
}

/** Does the message sound like a new administrative need? */
export function soundsLikeNeed(message: string): boolean {
  return /renov|empadron|padr[oó]n|\bnie\b|\btie\b|\bparo\b|desempleo|\brenta\b|certificad|\bcita\b|pasaporte|vida laboral|quiero|necesito|tengo que|solicitar|pedir|tr[aá]mite|renew|apply|i need|appointment|certificate|passport/i.test(
    message,
  );
}

/** Demo procedures that already cover a topic. */
export const DEMO_TOPICS: Record<string, string> = {
  dni: DEMO_IDS.dni,
  padron: DEMO_IDS.padron,
  certificado: DEMO_IDS.fnmt,
  hacienda: DEMO_IDS.hacienda,
};

// ---------------------------------------------------------------------------------------------
// New procedures
// ---------------------------------------------------------------------------------------------

interface TopicDef {
  title: L;
  intro: L;
  query: L;
  url: string;
  sourceTitle: L;
  readSummary: L;
  administration: Administration;
  steps: { id: string; title: L; owner: ProcedureStep['owner'] }[];
  facts: [label: L, value: L][];
  status: ProcedureStatus;
  /** Handover when the agent's run ends; none when it carries on by itself. */
  next?: { text: L; owner: NextActionOwner };
  report: L;
  reply: L;
}

const TOPICS: Record<string, TopicDef> = {
  dni: {
    title: ['Renovar el DNI', 'Renew your DNI'],
    intro: ['Vale, me pongo con la renovación del DNI.', 'OK, I’m on your DNI renewal.'],
    query: ['renovar DNI cita previa', 'renew DNI appointment'],
    url: URLS.dniRenew,
    sourceTitle: ['Renovación del DNI — Portal del DNIe', 'DNI renewal — DNIe portal'],
    readSummary: [
      'Hace falta el DNI actual, una foto y 12 €',
      'Needs the current DNI, a photo and €12',
    ],
    administration: { level: 'state', name: 'Policía Nacional' },
    steps: [
      { id: 'documentos', title: ['Reunir documentos', 'Gather documents'], owner: 'user' },
      { id: 'tasa', title: ['Pagar la tasa', 'Pay the fee'], owner: 'agent' },
      { id: 'cita', title: ['Pedir cita en comisaría', 'Book the appointment'], owner: 'agent' },
      { id: 'acudir', title: ['Acudir a la cita', 'Go to the appointment'], owner: 'user' },
    ],
    facts: [
      [
        ['Dónde', 'Where'],
        ['Renovación presencial en una oficina de expedición.', 'In person, at a DNI office.'],
      ],
      [
        ['Coste', 'Cost'],
        ['12 € en general; hay exenciones.', '€12 in general; some people are exempt.'],
      ],
    ],
    status: 'planned',
    next: {
      text: ['Decirme dónde y cuándo quieres la cita', 'Tell me where and when'],
      owner: 'user',
    },
    report: [
      'Plan listo: hace falta foto reciente y 12 €. Falta saber dónde y cuándo quiere la cita.',
      'Plan ready: a recent photo and €12 are needed. I need to know where and when.',
    ],
    reply: [
      'Ya sé cómo renovar tu DNI: **12 €**, una foto reciente y cita en comisaría. ¿Dónde y cuándo te va bien?',
      'I know how to renew your DNI: **€12**, a recent photo and an appointment. Where and when suits you?',
    ],
  },
  padron: {
    title: ['Empadronarme', 'Register my address'],
    intro: ['Vale, miro cómo empadronarte.', 'OK, I’ll look into registering your address.'],
    query: ['alta padrón municipal requisitos', 'padrón registration requirements'],
    url: URLS.padron,
    sourceTitle: ['Alta en el Padrón Municipal', 'Padrón registration'],
    readSummary: [
      'Gratis; hace falta el contrato o la escritura',
      'Free; needs your contract or deed',
    ],
    administration: { level: 'local', name: 'Ayuntamiento' },
    steps: [
      { id: 'requisitos', title: ['Leer los requisitos', 'Read the requirements'], owner: 'agent' },
      {
        id: 'contrato',
        title: ['Reunir el contrato de alquiler', 'Get your rental contract'],
        owner: 'user',
      },
      { id: 'solicitar', title: ['Solicitar el alta online', 'Apply online'], owner: 'agent' },
    ],
    facts: [
      [
        ['Coste', 'Cost'],
        ['Gratis.', 'Free.'],
      ],
      [
        ['Necesitas', 'You need'],
        ['Contrato o escritura de la vivienda.', 'Your rental contract or title deed.'],
      ],
    ],
    status: 'planned',
    next: { text: ['Subir tu contrato de alquiler', 'Upload your rental contract'], owner: 'user' },
    report: [
      'Se puede hacer online. Falta el contrato de alquiler de Lucía.',
      'It can be done online. Lucía’s rental contract is missing.',
    ],
    reply: [
      'Empadronarte es **gratis** y lo puedo hacer yo online. Solo necesito tu **contrato de alquiler**.',
      'Registering is **free** and I can do it online. I just need your **rental contract**.',
    ],
  },
  certificado: {
    title: ['Certificado digital (FNMT)', 'Digital certificate (FNMT)'],
    intro: ['Vale, pido tu certificado digital.', 'OK, I’ll request your digital certificate.'],
    query: ['certificado digital FNMT persona física', 'FNMT personal certificate'],
    url: URLS.fnmt,
    sourceTitle: ['Certificado de persona física — FNMT', 'Personal certificate — FNMT'],
    readSummary: ['Se pide online y se valida en persona', 'Request online, verify in person'],
    administration: { level: 'state', name: 'Fábrica Nacional de Moneda y Timbre' },
    steps: [
      {
        id: 'solicitar',
        title: ['Solicitar el certificado', 'Request the certificate'],
        owner: 'agent',
      },
      { id: 'validar', title: ['Validar tu identidad', 'Verify your identity'], owner: 'user' },
      {
        id: 'instalar',
        title: ['Instalar el certificado', 'Install the certificate'],
        owner: 'agent',
      },
    ],
    facts: [
      [
        ['Coste', 'Cost'],
        ['Gratis.', 'Free.'],
      ],
      [
        ['Validez', 'Valid for'],
        ['Válido durante 4 años.', 'Valid for 4 years.'],
      ],
    ],
    status: 'in_progress',
    report: [
      'Plan listo. Lo siguiente es solicitarlo online con el DNI de Lucía.',
      'Plan ready. Next: request it online with Lucía’s DNI.',
    ],
    reply: [
      'El certificado digital es **gratis**: lo pido yo online y luego tú validas tu identidad en una oficina.',
      'The digital certificate is **free**: I request it online and then you verify your identity at an office.',
    ],
  },
  tie: {
    title: ['Cita para la TIE', 'TIE appointment'],
    intro: ['Vale, me pongo con la cita de la TIE.', 'OK, I’m on your TIE appointment.'],
    query: ['cita previa toma de huella TIE', 'TIE fingerprint appointment'],
    url: 'https://icp.administracionelectronica.gob.es/icpplus/index.html',
    sourceTitle: ['Cita previa de extranjería', 'Immigration appointments'],
    readSummary: [
      'Tasa 790-012 y cita para las huellas',
      'Fee 790-012 and a fingerprint appointment',
    ],
    administration: { level: 'state', name: 'Policía Nacional · Extranjería' },
    steps: [
      { id: 'tasa', title: ['Pagar la tasa 790-012', 'Pay fee 790-012'], owner: 'agent' },
      {
        id: 'cita',
        title: ['Pedir cita para las huellas', 'Book the fingerprint appointment'],
        owner: 'agent',
      },
      { id: 'acudir', title: ['Ir a la cita', 'Go to the appointment'], owner: 'user' },
      { id: 'recoger', title: ['Recoger la tarjeta', 'Collect the card'], owner: 'user' },
    ],
    facts: [
      [
        ['Coste', 'Cost'],
        ['Unos 16 €.', 'About €16.'],
      ],
      [
        ['Dónde', 'Where'],
        ['En una comisaría, con cita previa.', 'At a police station, by appointment.'],
      ],
    ],
    status: 'in_progress',
    report: [
      'Plan listo. Las citas se agotan rápido; empiezo a buscar.',
      'Plan ready. Slots run out fast; I’m starting to look.',
    ],
    reply: [
      'Para la TIE hay que pagar la **tasa 790-012** y pedir cita para las huellas. Las citas vuelan, así que ya estoy buscando.',
      'For the TIE you pay **fee 790-012** and book a fingerprint appointment. Slots go fast, so I’m already looking.',
    ],
  },
  paro: {
    title: ['Pedir el paro', 'Claim unemployment benefit'],
    intro: ['Vale, miro lo del paro.', 'OK, I’ll look into unemployment benefit.'],
    query: ['solicitar prestación desempleo SEPE online', 'apply unemployment benefit SEPE'],
    url: 'https://sede.sepe.gob.es/portalSede/procedimientos-y-servicios/personas/proteccion-por-desempleo.html',
    sourceTitle: ['Protección por desempleo — SEPE', 'Unemployment protection — SEPE'],
    readSummary: ['Plazo de 15 días hábiles', '15 working days to apply'],
    administration: { level: 'state', name: 'SEPE' },
    steps: [
      {
        id: 'derecho',
        title: ['Comprobar si tienes derecho', 'Check you qualify'],
        owner: 'agent',
      },
      { id: 'solicitar', title: ['Pedir la prestación online', 'Apply online'], owner: 'agent' },
      {
        id: 'resolucion',
        title: ['Esperar la resolución', 'Wait for the decision'],
        owner: 'administration',
      },
    ],
    facts: [
      [
        ['Plazo', 'Deadline'],
        [
          '15 días hábiles desde que acaba el contrato.',
          '15 working days after the contract ends.',
        ],
      ],
      [
        ['Cómo', 'How'],
        ['Online con certificado digital o Cl@ve.', 'Online, with a certificate or Cl@ve.'],
      ],
    ],
    status: 'planned',
    next: {
      text: ['Decirme cuándo terminó tu contrato', 'Tell me when your contract ended'],
      owner: 'user',
    },
    report: [
      'Plan listo. Falta saber la fecha de fin del contrato para ver el plazo.',
      'Plan ready. I need the contract end date to check the deadline.',
    ],
    reply: [
      'El paro se pide online y hay **15 días hábiles** desde que acaba el contrato. ¿Qué día terminó el tuyo?',
      'You apply online, within **15 working days** after the contract ends. When did yours end?',
    ],
  },
  vida: {
    title: ['Informe de vida laboral', 'Work history report'],
    intro: ['Te lo descargo ahora.', 'I’ll download it now.'],
    query: ['informe vida laboral descargar', 'download work history report'],
    url: 'https://portal.seg-social.gob.es/wps/portal/importass/importass/tramites/vidaLaboral',
    sourceTitle: ['Informe de vida laboral', 'Work history report'],
    readSummary: ['Gratis, al momento con Cl@ve', 'Free, instant with Cl@ve'],
    administration: { level: 'state', name: 'Seguridad Social' },
    steps: [
      { id: 'entrar', title: ['Entrar con tu Cl@ve', 'Sign in with Cl@ve'], owner: 'agent' },
      { id: 'descargar', title: ['Descargar el informe', 'Download the report'], owner: 'agent' },
    ],
    facts: [
      [
        ['Coste', 'Cost'],
        ['Gratis.', 'Free.'],
      ],
    ],
    status: 'in_progress',
    report: [
      'Plan listo: lo descargo con la Cl@ve de Lucía.',
      'Plan ready: I’ll download it with Lucía’s Cl@ve.',
    ],
    reply: [
      'Tu vida laboral se descarga gratis con tu Cl@ve. Te aviso cuando la tenga.',
      'Your work history downloads for free with Cl@ve. I’ll let you know when I have it.',
    ],
  },
  renta: {
    title: ['Declaración de la renta', 'Income tax return'],
    intro: ['Vale, miro lo de la renta.', 'OK, I’ll look into your tax return.'],
    query: ['renta 2025 presentar fuera de plazo', 'late income tax return Spain'],
    url: 'https://sede.agenciatributaria.gob.es/Sede/Renta.html',
    sourceTitle: ['Campaña de Renta — Agencia Tributaria', 'Income tax campaign — Tax Agency'],
    readSummary: ['La campaña terminó el 30 de junio', 'The campaign ended on 30 June'],
    administration: { level: 'state', name: 'Agencia Tributaria' },
    steps: [
      { id: 'que', title: ['Decidir qué hay que hacer', 'Decide what’s needed'], owner: 'user' },
      { id: 'borrador', title: ['Revisar el borrador', 'Review the draft'], owner: 'agent' },
      { id: 'presentar', title: ['Presentar la declaración', 'File the return'], owner: 'agent' },
    ],
    facts: [
      [
        ['Campaña 2025', '2025 campaign'],
        ['Terminó el 30 de junio de 2026.', 'Ended on 30 June 2026.'],
      ],
      [
        ['Fuera de plazo', 'Late filing'],
        ['Se puede, con recargo.', 'Possible, with a surcharge.'],
      ],
    ],
    status: 'planned',
    next: {
      text: [
        'Decirme si quieres presentarla o corregirla',
        'Tell me whether to file or correct it',
      ],
      owner: 'user',
    },
    report: [
      'La campaña ya terminó. Falta saber si Lucía quiere presentarla tarde o corregir una ya presentada.',
      'The campaign is over. I need to know whether Lucía wants to file late or correct one.',
    ],
    reply: [
      'La campaña de la renta **terminó el 30 de junio**. Aún se puede presentar tarde o corregir. ¿Qué necesitas?',
      'The tax return campaign **ended on 30 June**. You can still file late or correct it. What do you need?',
    ],
  },
  pasaporte: {
    title: ['Sacar el pasaporte', 'Get a passport'],
    intro: ['Vale, me pongo con el pasaporte.', 'OK, I’m on your passport.'],
    query: ['expedición pasaporte requisitos cita', 'Spanish passport requirements appointment'],
    url: URLS.dniCita,
    sourceTitle: ['Cita previa DNI y pasaporte', 'DNI and passport appointments'],
    readSummary: ['DNI en vigor, foto y unos 30 €', 'Valid DNI, photo and about €30'],
    administration: { level: 'state', name: 'Policía Nacional' },
    steps: [
      { id: 'tasa', title: ['Pagar la tasa', 'Pay the fee'], owner: 'agent' },
      { id: 'cita', title: ['Pedir cita en comisaría', 'Book the appointment'], owner: 'agent' },
      { id: 'acudir', title: ['Acudir a la cita', 'Go to the appointment'], owner: 'user' },
    ],
    facts: [
      [
        ['Coste', 'Cost'],
        ['Unos 30 €.', 'About €30.'],
      ],
      [
        ['Dónde', 'Where'],
        ['En una comisaría, con cita previa.', 'At a police station, by appointment.'],
      ],
    ],
    status: 'planned',
    next: {
      text: ['Decirme dónde y cuándo quieres la cita', 'Tell me where and when'],
      owner: 'user',
    },
    report: [
      'Plan listo. Necesita DNI en vigor: el de Lucía caduca el 31/10, mejor renovarlo antes.',
      'Plan ready. A valid DNI is needed: Lucía’s expires on 31/10, better renew it first.',
    ],
    reply: [
      'Para el pasaporte necesitas el **DNI en vigor**, y el tuyo caduca el 31 de octubre. Mejor renovar antes el DNI.',
      'For the passport you need a **valid DNI**, and yours expires on 31 October. Better renew the DNI first.',
    ],
  },
};

function genericTopic(message: string, t: Tr): TopicDef {
  const raw = message
    .replace(
      /^(hola[,.!]?\s*)?(quiero|necesito|tengo que|me gustar[ií]a|i need to|i want to|i need)\s+/i,
      '',
    )
    .replace(/[.?!]+$/, '')
    .trim();
  const pretty = raw.charAt(0).toUpperCase() + raw.slice(1);
  const title =
    pretty.length > 60 ? `${pretty.slice(0, 57)}…` : pretty || t('Nuevo trámite', 'New procedure');
  return {
    title: [title, title],
    intro: ['Vale, lo miro.', 'OK, I’ll look into it.'],
    query: [raw, raw],
    url: 'https://administracion.gob.es/pag_Home/procedimientoselectronicos.html',
    sourceTitle: ['Punto de Acceso General', 'Spanish government portal'],
    readSummary: ['Información general', 'General information'],
    administration: { level: 'state', name: 'Administración General del Estado' },
    steps: [
      { id: 'entender', title: ['Entender tu caso', 'Understand your case'], owner: 'agent' },
      { id: 'plan', title: ['Preparar el plan', 'Prepare the plan'], owner: 'agent' },
    ],
    facts: [],
    status: 'researching',
    next: { text: ['Contarme un poco más de tu caso', 'Tell me a bit more'], owner: 'user' },
    report: [
      'Hay varias vías posibles. Falta saber más del caso de Lucía.',
      'There are several possible routes. I need to know more about Lucía’s case.',
    ],
    reply: [
      'Ya tengo una idea general. Para darte los pasos exactos, cuéntame un poco más: ¿para qué lo necesitas?',
      'I have a general idea. To give you the exact steps, tell me a bit more: what do you need it for?',
    ],
  };
}

function steps(def: TopicDef, t: Tr, current: number): ProcedureStep[] {
  return def.steps.map((s, i) => ({
    id: s.id,
    title: pick(t, s.title),
    owner: s.owner,
    status: i < current ? 'done' : i === current ? 'current' : 'pending',
  }));
}

/** What the assistant does for a new need: a short reply, `procedure_start`, the agent's run. */
export function newProcedurePlan(
  message: string,
  lang: Lang,
): { intro: string; plan: ProcedurePlan } {
  const t = translator(lang);
  const topic = detectTopic(message);
  const def = (topic && TOPICS[topic]) || genericTopic(message, t);
  const facts = def.facts.map(([label, value]) => ({
    label: pick(t, label),
    value: pick(t, value),
  }));
  const firstCurrent =
    def.status === 'researching'
      ? 1
      : def.steps.findIndex((s) => s.owner === (def.next?.owner ?? 'agent'));
  const title = pick(t, def.title);

  const agent: PStep[] = [
    { kind: 'wait', ms: 600 },
    {
      kind: 'tool',
      tool: 'web_research',
      args: { query: pick(t, def.query), mode: 'balanced' },
      summary: t('Investigación completada', 'Research complete'),
      ms: 1300,
    },
    {
      kind: 'tool',
      tool: 'feedback_search',
      args: { query: pick(t, def.query) },
      summary: t('3 experiencias útiles', '3 useful experiences'),
      ms: 1200,
    },
    { kind: 'tool', tool: 'procedure_update', args: {}, ms: 400 },
    {
      kind: 'update',
      patch: {
        administration: def.administration,
        steps: steps(def, t, 0),
        facts: facts.slice(0, 1),
      },
    },
    {
      kind: 'tool',
      tool: 'fetch_url',
      args: { url: def.url },
      summary: pick(t, def.readSummary),
      ms: 1700,
    },
    {
      kind: 'tool',
      tool: 'vault_read',
      args: {},
      summary: t('Datos de Lucía revisados', 'Lucía’s data checked'),
      ms: 700,
    },
    {
      kind: 'tool',
      tool: 'procedure_update',
      args: {},
      summary: t('Plan listo', 'Plan ready'),
      ms: 500,
    },
    {
      kind: 'update',
      patch: {
        status: def.status,
        steps: steps(def, t, Math.max(0, firstCurrent)),
        facts,
        sources: [src(pick(t, def.sourceTitle), def.url)],
        nextAction: def.next ? { text: pick(t, def.next.text), owner: def.next.owner } : null,
      },
    },
    { kind: 'report', summary: pick(t, def.report), reply: pick(t, def.reply) },
  ];

  return {
    intro: pick(t, def.intro),
    plan: {
      topic: topic ?? 'generic',
      title,
      brief: t(`Lucía dice: «${message.trim()}».`, `Lucía says: “${message.trim()}”.`),
      administration: def.administration,
      agent,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Other replies of the assistant
// ---------------------------------------------------------------------------------------------

export function genericReply(message: string, lang: Lang): string {
  const t = translator(lang);
  if (/gracias|genial|perfecto|thanks|thank you|great/i.test(message))
    return t(
      '¡De nada! Aquí sigo para lo que necesites.',
      'You’re welcome! I’m here if you need anything.',
    );
  if (/^\s*(hola|buenas|hey|hi|hello)\b/i.test(message))
    return t(
      '¡Hola! Cuéntame qué necesitas y me pongo con ello.',
      'Hi! Tell me what you need and I’ll get on it.',
    );
  return t(
    'Entendido. Si quieres que me ocupe de algún trámite, dímelo y lo pongo en marcha.',
    'Got it. If you want me to take care of any paperwork, just say so and I’ll start it.',
  );
}

/** Reply when the user mentions something an existing procedure already covers. */
export function existingReply(p: ProcedureListItem, lang: Lang): string {
  const t = translator(lang);
  const head = t(`Ya estoy con **${p.title}**.`, `I’m already on **${p.title}**.`);
  if (p.status === 'done')
    return t(`**${p.title}** ya está terminado.`, `**${p.title}** is already done.`);
  if (p.runtime.activity === 'needs_user')
    return `${head} ${t('Te ha dejado una pregunta en su tarjeta.', 'It left you a question on its card.')}`;
  if (p.runtime.activity === 'working')
    return `${head} ${t('Ahora mismo está trabajando en ello.', 'It’s working on it right now.')}`;
  const next = p.nextAction;
  if (!next) return head;
  const lead =
    next.owner === 'user'
      ? t('Ahora te toca a ti', 'Now it’s your turn')
      : t('Estamos esperando a la administración', 'We’re waiting for the administration');
  return `${head} ${lead}: ${next.text.charAt(0).toLowerCase()}${next.text.slice(1)}.`;
}

// ---------------------------------------------------------------------------------------------
// Demo procedures
// ---------------------------------------------------------------------------------------------

const personal = (key: string) => ({ value: { source: 'personal', key } });

/** The DNI agent after the user answers (or dismisses) "¿Dónde y cuándo quieres la cita?". */
export function dniAfterForm(response: PromptResponse, lang: Lang): PStep[] {
  const t = translator(lang);
  if (response.kind !== 'form' || response.dismissed || !response.values) {
    return [
      { kind: 'tool', tool: 'procedure_update', args: {}, ms: 500 },
      {
        kind: 'update',
        patch: {
          nextAction: {
            text: t('Avisarme cuando quieras pedir la cita', 'Tell me when you want to book it'),
            owner: 'user',
          },
        },
      },
      {
        kind: 'report',
        summary: t(
          'Lucía no quiere pedir la cita todavía. Espero a que lo diga.',
          'Lucía doesn’t want to book yet. Waiting for her go-ahead.',
        ),
        reply: t(
          'Vale, no pido la cita por ahora. Dímelo cuando quieras y la busco.',
          'OK, I won’t book it for now. Tell me when you want it and I’ll look.',
        ),
      },
    ];
  }

  const values = response.values;
  const str = (key: string, fallback: string) => {
    const v = values[key];
    return typeof v === 'string' && v ? v : fallback;
  };
  const form = dniForm(t);
  const officeField = form.fields.find((f) => f.key === 'oficina');
  const officeValue = str('oficina', 'cercana');
  const office =
    officeValue === 'cercana'
      ? 'Madrid – Retiro (Calle Rafael Calvo)'
      : (officeField?.options?.find((o) => o.value === officeValue)?.label ?? officeValue);
  const officeShort = office.replace(/\s*\(.*\)$/, '');
  const province = str('provincia', 'Madrid');
  const time = str('franja', 'manana') === 'tarde' ? '17:40' : '10:20';
  const day = new Date(`${str('desde', '2026-10-06')}T12:00:00`);
  if (Number.isNaN(day.getTime())) day.setTime(Date.now() + 3 * 86_400_000);
  while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() + 1);
  const when = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
    .format(day)
    .replace(',', '');
  const whenTime = t(`${when} a las ${time}`, `${when} at ${time}`);
  const pad = (n: number) => String(n).padStart(2, '0');
  const startsAt = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${time}`;
  const phoneSaved = response.savedToVault.includes('telefono');

  return [
    { kind: 'wait', ms: 500 },
    {
      kind: 'tool',
      tool: 'browser_open',
      args: { url: URLS.dniCita },
      imageId: 'm-dni-cita',
      ms: 1500,
    },
    { kind: 'tool', tool: 'browser_fill_from_vault', args: personal('dniNumber'), ms: 600 },
    {
      kind: 'tool',
      tool: 'browser_fill_from_vault',
      args: personal('dniSupportNumber'),
      ms: 600,
    },
    { kind: 'tool', tool: 'browser_click', args: { element: 'Acceder' }, ms: 900 },
    { kind: 'tool', tool: 'browser_select', args: { values: [province] }, ms: 700 },
    { kind: 'tool', tool: 'browser_select', args: { values: [officeShort] }, ms: 700 },
    {
      kind: 'tool',
      tool: 'browser_click',
      args: { element: 'Buscar cita' },
      summary: t(`3 citas libres; la primera: ${whenTime}`, `3 free slots; the first: ${whenTime}`),
      ms: 1800,
    },
    { kind: 'tool', tool: 'browser_click', args: { element: time }, ms: 600 },
    phoneSaved
      ? { kind: 'tool', tool: 'browser_fill_from_vault', args: personal('phone'), ms: 600 }
      : { kind: 'tool', tool: 'browser_type', args: { text: str('telefono', '') }, ms: 600 },
    {
      kind: 'tool',
      tool: 'browser_click',
      args: { element: 'Confirmar cita' },
      summary: t('Cita confirmada · localizador 8KQ2T7', 'Appointment confirmed · ref. 8KQ2T7'),
      imageId: 'm-dni-ok',
      ms: 1500,
    },
    {
      kind: 'document',
      name: t('Justificante cita DNI.pdf', 'DNI appointment receipt.pdf'),
      docKind: 'receipt',
      preview: [t('Cita previa DNI', 'DNI appointment'), `${whenTime} · ${officeShort}`],
    },
    { kind: 'tool', tool: 'procedure_update', args: {}, ms: 500 },
    {
      kind: 'update',
      patch: {
        status: 'in_progress',
        nextAction: {
          text: t(
            'Acudir a la cita con tu DNI actual y la foto',
            'Go to the appointment with your current DNI and the photo',
          ),
          owner: 'user',
          appointment: { address: `${office}, ${province}`, startsAt },
        },
        steps: [
          {
            id: 'documentos',
            title: t('Reunir documentos', 'Gather documents'),
            status: 'done',
            owner: 'user',
          },
          { id: 'tasa', title: t('Pagar la tasa', 'Pay the fee'), status: 'done', owner: 'agent' },
          {
            id: 'cita',
            title: t('Pedir cita en comisaría', 'Book an appointment at the police station'),
            status: 'done',
            owner: 'agent',
            detail: `${whenTime} · ${office}. ${t('Localizador', 'Ref.')} 8KQ2T7.`,
          },
          {
            id: 'acudir',
            title: t('Acudir a la cita', 'Go to the appointment'),
            status: 'current',
            owner: 'user',
            detail: t('Lleva tu DNI actual y la foto.', 'Bring your current DNI and the photo.'),
          },
        ],
        facts: [
          { label: t('Coste', 'Cost'), value: t('12 € (ya pagado).', '€12 (already paid).') },
          { label: t('Localizador', 'Ref.'), value: '8KQ2T7' },
        ],
      },
    },
    {
      kind: 'report',
      summary: t(
        `Cita reservada: ${whenTime}, ${officeShort}. Localizador 8KQ2T7. Justificante en Mis datos. Lucía tiene que ir con el DNI actual y la foto.`,
        `Appointment booked: ${whenTime}, ${officeShort}. Ref. 8KQ2T7. Receipt in My data. Lucía must bring her current DNI and the photo.`,
      ),
      reply: t(
        `¡Listo! Tienes cita para el DNI el **${whenTime}** en **${officeShort}**. Te llegará un SMS.\n\nLleva tu DNI actual y la foto.`,
        `Done! Your DNI appointment is on **${whenTime}** at **${officeShort}**. You’ll get a text.\n\nBring your current DNI and the photo.`,
      ),
    },
  ];
}

/** The "Empadronarme en Madrid" agent keeps working when the app opens, then reports. */
export function padronLiveScript(lang: Lang): PStep[] {
  const t = translator(lang);
  return [
    { kind: 'wait', ms: 2600 },
    {
      kind: 'finish',
      itemId: 'pad-l09',
      summary: t('Alta online con certificado digital', 'Online registration with a certificate'),
    },
    {
      kind: 'tool',
      tool: 'web_research',
      args: { query: 'empadronamiento Madrid', mode: 'balanced' },
      summary: t('Investigación completada', 'Research complete'),
      ms: 1600,
    },
    {
      kind: 'tool',
      tool: 'feedback_search',
      args: {
        query: t('padrón Madrid contrato alquiler online', 'padrón Madrid rental contract online'),
      },
      summary: t('2 experiencias útiles', '2 useful experiences'),
      ms: 1800,
    },
    { kind: 'tool', tool: 'procedure_update', args: {}, ms: 500 },
    {
      kind: 'update',
      patch: {
        facts: [
          {
            label: t('Dónde', 'Where'),
            value: t(
              'Online con certificado digital, o con cita previa.',
              'Online with a certificate, or by appointment.',
            ),
          },
          { label: t('Coste', 'Cost'), value: t('Gratis.', 'Free.') },
          {
            label: t('Necesitas', 'You need'),
            value: t('Contrato o escritura de la vivienda.', 'Your rental contract or title deed.'),
          },
        ],
      },
    },
    {
      kind: 'tool',
      tool: 'fetch_url',
      args: { url: URLS.padronRequest },
      summary: t('Formulario de solicitud y documentos', 'Application form and documents'),
      ms: 2200,
    },
    {
      kind: 'tool',
      tool: 'vault_read',
      args: {},
      summary: t('Dirección: Calle de Alcalá 123, 4º B', 'Address: Calle de Alcalá 123, 4º B'),
      ms: 900,
    },
    {
      kind: 'tool',
      tool: 'procedure_update',
      args: {},
      summary: t('Plan listo', 'Plan ready'),
      ms: 600,
    },
    {
      kind: 'update',
      patch: {
        status: 'planned',
        summary: t(
          'Darte de alta en el padrón de Madrid. Es gratis y lo hago online con tu certificado digital.',
          'Sign you up on Madrid’s register of residents. It’s free and I’ll do it online with your certificate.',
        ),
        nextAction: {
          text: t(
            'Subir tu contrato de alquiler a Mis datos',
            'Upload your rental contract to My data',
          ),
          owner: 'user',
        },
        steps: [
          {
            id: 'requisitos',
            title: t('Leer los requisitos', 'Read the requirements'),
            status: 'done',
            owner: 'agent',
          },
          {
            id: 'contrato',
            title: t('Reunir el contrato de alquiler', 'Get your rental contract'),
            status: 'current',
            owner: 'user',
            detail: t(
              'Una foto o un PDF del contrato firmado.',
              'A photo or PDF of the signed contract.',
            ),
          },
          {
            id: 'solicitar',
            title: t('Solicitar el alta online', 'Apply online'),
            status: 'pending',
            owner: 'agent',
          },
        ],
        requirements: [
          { id: 'dni', label: t('Tu DNI', 'Your DNI'), status: 'have' },
          { id: 'cert', label: t('Certificado digital', 'Digital certificate'), status: 'have' },
          {
            id: 'contrato',
            label: t('Contrato de alquiler o escritura', 'Rental contract or title deed'),
            status: 'missing',
          },
        ],
      },
    },
    {
      kind: 'report',
      summary: t(
        'Se puede hacer online con el certificado de Lucía. Falta su contrato de alquiler; en cuanto lo suba, envío la solicitud.',
        'It can be done online with Lucía’s certificate. Her rental contract is missing; once she uploads it, I’ll apply.',
      ),
      reply: t(
        'Ya sé cómo empadronarte: lo hago yo online con tu certificado. Solo necesito tu **contrato de alquiler**. Súbelo en [tus documentos](sa:vault/documents) o adjúntalo aquí.',
        'I know how to register you: I’ll do it online with your certificate. I just need your **rental contract**. Upload it in [your documents](sa:vault/documents) or attach it here.',
      ),
    },
  ];
}
