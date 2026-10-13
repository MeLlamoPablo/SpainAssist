import {
  type ActivityItem,
  type ChatItem,
  type ConversationState,
  type CredentialSummary,
  DEFAULT_SETTINGS,
  type DocumentMeta,
  type FormPrompt,
  type PersonalDataItem,
  type Procedure,
  type ProcedureListItem,
  type ProcedureRuntime,
  type PromptItem,
  type ProviderOption,
  type ProviderStatus,
  personalFieldDef,
  REPORT_TOOL,
  type Settings,
  type StorageInfo,
} from '@sa/shared';
import { fakeDocumentPage, fakeIdCardBack, fakePage, fakePortrait } from './images';

/**
 * Demo data for the mock API: one person (Lucía) who has just moved from Valencia to Madrid.
 * One perpetual conversation with the assistant, four procedures in different states, each with
 * its own agent activity log. Content is written as the real agents would: short, plain Spanish
 * (or English with ?lang=en).
 */

export type Lang = 'es' | 'en';
/** Picks the Spanish or English variant of a demo string. */
export type Tr = (es: string, en: string) => string;
export const translator =
  (lang: Lang): Tr =>
  (es, en) =>
    lang === 'en' ? en : es;

export interface MockState {
  settings: Settings;
  provider: ProviderStatus;
  procedures: Map<string, ProcedureListItem>;
  /** Activity log of each procedure's agent. */
  logs: Map<string, ChatItem[]>;
  /** The single conversation with the assistant (oldest first). */
  conversation: ChatItem[];
  chatState: ConversationState;
  personal: PersonalDataItem[];
  documents: DocumentMeta[];
  documentPreviews: Map<string, string>;
  credentials: CredentialSummary[];
  storage: StorageInfo;
  media: Map<string, string>;
}

/** Ids of the demo procedures and of the pending DNI form (handy for tests and screenshots). */
export const DEMO_IDS = {
  hacienda: 'p-hacienda',
  dni: 'p-dni',
  fnmt: 'p-fnmt',
  padron: 'p-padron',
  dniPrompt: 'c-dni-cita',
  /** The "ask_user" activity in the DNI log that belongs to the pending form. */
  dniPromptActivity: 'dni-l14',
} as const;

const MIN = 60_000;
const at = (now: number, minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
const inDays = (now: number, days: number) => new Date(now + days * 86_400_000).toISOString();
/** A wall-clock time `daysAgo` calendar days before `now`. */
const dayAt = (now: number, daysAgo: number, h: number, m: number) => {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

export const DEMO_SCAN = {
  format: 'TD1' as const,
  documentCode: 'ID',
  issuingState: 'ESP',
  documentNumber: 'CAA123456',
  personalNumber: '12345678Z',
  surnames: ['MARTIN', 'ORTEGA'],
  givenNames: 'LUCIA',
  nationality: 'ESP',
  birthDate: '1991-03-08',
  sex: 'F' as const,
  expiryDate: '2026-10-31',
};

export const BYOK_PROVIDERS: ProviderOption[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    models: [
      {
        provider: 'anthropic',
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        supportsImages: true,
      },
      {
        provider: 'anthropic',
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        supportsImages: true,
      },
      {
        provider: 'anthropic',
        id: 'claude-opus-4-1',
        name: 'Claude Opus 4.1',
        supportsImages: true,
      },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    models: [
      { provider: 'openai', id: 'gpt-5', name: 'GPT-5', supportsImages: true, reasoning: true },
      { provider: 'openai', id: 'gpt-5-mini', name: 'GPT-5 mini', supportsImages: true },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    envVar: 'GEMINI_API_KEY',
    models: [
      { provider: 'google', id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', supportsImages: true },
      {
        provider: 'google',
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        supportsImages: true,
      },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    envVar: 'OPENROUTER_API_KEY',
    models: [
      { provider: 'openrouter', id: 'openai/gpt-5-mini', name: 'GPT-5 mini (OpenRouter)' },
      {
        provider: 'openrouter',
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5 (OpenRouter)',
      },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    envVar: 'MISTRAL_API_KEY',
    models: [{ provider: 'mistral', id: 'mistral-large-latest', name: 'Mistral Large' }],
  },
];

export function providerPreset(kind: string | null): ProviderStatus {
  switch (kind) {
    case 'none':
      return { configured: false };
    case 'chatgpt':
      return {
        configured: true,
        kind: 'chatgpt',
        label: 'ChatGPT',
        model: 'gpt-6.1-sol',
        account: 'lucia@example.com · Plus',
      };
    case 'byok':
      return {
        configured: true,
        kind: 'byok',
        label: 'Anthropic (clave propia)',
        model: 'claude-sonnet-4-5',
        exaKey: false,
      };
    default:
      return {
        configured: true,
        kind: 'voucher',
        label: 'Bono Spain Assist',
        model: 'openai/gpt-5-mini',
        credit: { usageUsd: 0.8, limitUsd: 5, remainingUsd: 4.2 },
        expiresAt: '2027-04-07T09:00:00.000Z',
      };
  }
}

const source = (title: string, url: string) => ({ title, url });

function runtime(partial: Partial<ProcedureRuntime> = {}): ProcedureRuntime {
  return { activity: 'idle', unread: false, ...partial };
}

export function demoPersonal(now: number, lang: Lang): PersonalDataItem[] {
  const rows: [string, string, PersonalDataItem['source'], number][] = [
    ['givenName', 'Lucía', 'scan', 30],
    ['surname1', 'Martín', 'scan', 30],
    ['surname2', 'Ortega', 'scan', 30],
    ['dniNumber', '12345678Z', 'scan', 30],
    ['dniSupportNumber', 'CAA123456', 'scan', 30],
    ['dniExpiry', '2026-10-31', 'scan', 30],
    ['dniAccessNumber', '123456', 'scan', 30],
    ['birthDate', '1991-03-08', 'scan', 30],
    ['sex', 'F', 'scan', 30],
    ['nationality', 'ESP', 'scan', 30],
    ['email', 'lucia.martin@example.com', 'form', 3],
    ['addressStreet', 'Calle de Alcalá 123, 4º B', 'agent', 3],
    ['addressPostalCode', '28009', 'agent', 3],
    ['addressMunicipality', 'Madrid', 'agent', 3],
    ['addressProvince', 'Madrid', 'agent', 3],
    ['nuss', '46/12345678/90', 'form', 25],
    ['iban', 'ES91 2100 0418 4502 0005 1332', 'form', 20],
  ];
  return rows.map(([key, value, src, daysAgo]) => ({
    key,
    label: personalFieldDef(key)?.label[lang] ?? key,
    value,
    source: src,
    updatedAt: at(now, daysAgo * 1440),
  }));
}

export function demoCredentials(now: number): CredentialSummary[] {
  return [
    {
      id: 'cred-clave',
      kind: 'clave_permanente',
      label: 'Cl@ve Permanente',
      policy: 'auto',
      createdAt: at(now, 28 * 1440),
      lastUsedAt: at(now, 2 * 1440),
      usernameHint: '•••••678Z',
    },
    {
      id: 'cred-movil',
      kind: 'clave_movil',
      label: 'Cl@ve Móvil',
      policy: 'auto',
      createdAt: at(now, 28 * 1440),
      lastUsedAt: at(now, 1 * 1440),
    },
    {
      id: 'cred-cert',
      kind: 'certificate',
      label: 'Certificado FNMT',
      policy: 'ask',
      createdAt: at(now, 9),
      certificate: {
        subject: 'CN=MARTIN ORTEGA LUCIA - 12345678Z, SN=MARTIN ORTEGA, G=LUCIA, C=ES',
        issuer: 'AC FNMT Usuarios',
        serialNumber: '5A1C93E2B07D4F11',
        validFrom: at(now, 1 * 1440),
        validTo: inDays(now, 4 * 365 - 1),
        holderName: 'LUCÍA MARTÍN ORTEGA',
        holderId: '12345678Z',
        fingerprint: '9f2c4b7a1e0d3c58b6a4e2f1d0c9b8a7f6e5d4c3b2a1908f7e6d5c4b3a291807',
      },
    },
  ];
}

export function demoDocuments(
  now: number,
  t: Tr,
): {
  docs: DocumentMeta[];
  previews: Map<string, string>;
} {
  const docs: DocumentMeta[] = [
    {
      id: 'doc-tasa-dni',
      name: t('Justificante tasa DNI.pdf', 'DNI fee receipt.pdf'),
      mimeType: 'application/pdf',
      size: 64_000,
      source: 'download',
      procedureId: 'p-dni',
      createdAt: dayAt(now, 2, 11, 42),
    },
    {
      id: 'doc-fnmt',
      name: t('Solicitud certificado FNMT.pdf', 'FNMT certificate request.pdf'),
      mimeType: 'application/pdf',
      size: 52_000,
      source: 'download',
      procedureId: 'p-fnmt',
      createdAt: dayAt(now, 3, 18, 31),
    },
    {
      id: 'doc-dni',
      name: t('DNI (reverso).jpg', 'DNI (back).jpg'),
      mimeType: 'image/jpeg',
      size: 412_000,
      source: 'scan',
      createdAt: at(now, 30 * 1440),
    },
    {
      id: 'doc-foto',
      name: t('Foto carnet.jpg', 'ID photo.jpg'),
      mimeType: 'image/jpeg',
      size: 186_000,
      source: 'user',
      createdAt: at(now, 15 * 1440),
    },
    {
      id: 'doc-padron-valencia',
      name: t(
        'Volante de empadronamiento Valencia (2023).pdf',
        'Valencia padrón certificate (2023).pdf',
      ),
      mimeType: 'application/pdf',
      size: 128_000,
      source: 'user',
      createdAt: at(now, 600 * 1440),
    },
  ];
  const previews = new Map<string, string>([
    ['doc-tasa-dni', fakeDocumentPage(t('Justificante de pago', 'Payment receipt'), 'Tasa DNI')],
    ['doc-fnmt', fakeDocumentPage(t('Solicitud de certificado', 'Certificate request'), 'FNMT')],
    ['doc-dni', fakeIdCardBack()],
    ['doc-foto', fakePortrait()],
    [
      'doc-padron-valencia',
      fakeDocumentPage(t('Volante de empadronamiento', 'Padrón certificate'), 'Valencia'),
    ],
  ]);
  return { docs, previews };
}

function demoMedia(): Map<string, string> {
  const ss = '#2f6f8f';
  const aeat = '#7a4a2a';
  const fnmt = '#5b4b8a';
  const icp = '#3b5b7a';
  const cm = '#a4343a';
  return new Map([
    [
      'm-seg-home',
      fakePage({
        host: 'portal.seg-social.gob.es',
        title: 'Informe de vida laboral',
        kind: 'home',
        color: ss,
        lines: ['Vida laboral', 'Certificados', 'Prestaciones'],
      }),
    ],
    [
      'm-seg-login',
      fakePage({
        host: 'clave.gob.es',
        title: 'Elige cómo identificarte',
        kind: 'list',
        color: '#4a5d73',
        lines: [
          'DNIe / Certificado electrónico',
          'Cl@ve Móvil',
          'Cl@ve permanente',
          'Ciudadanos UE',
        ],
        highlight: 'Cl@ve permanente',
      }),
    ],
    [
      'm-seg-pass',
      fakePage({
        host: 'clave.gob.es',
        title: 'Cl@ve permanente',
        kind: 'login',
        color: '#4a5d73',
        lines: ['Identifícate', 'DNI / NIE', 'Contraseña'],
        button: 'Acceder',
      }),
    ],
    [
      'm-seg-sms',
      fakePage({
        host: 'clave.gob.es',
        title: 'Código de verificación',
        kind: 'login',
        color: '#4a5d73',
        lines: ['Te hemos enviado un SMS', 'Código'],
        button: 'Continuar',
      }),
    ],
    [
      'm-seg-informe',
      fakePage({
        host: 'portal.seg-social.gob.es',
        title: 'Tu informe de vida laboral',
        kind: 'download',
        color: ss,
        lines: ['Informe de vida laboral', 'Generado hoy · 3 páginas'],
        button: 'Descargar PDF',
      }),
    ],
    [
      'm-aeat-home',
      fakePage({
        host: 'sede.agenciatributaria.gob.es',
        title: 'Censos y domicilio fiscal',
        kind: 'list',
        color: aeat,
        lines: ['Consultar datos censales', 'Cambio de domicilio', 'Certificados'],
        highlight: 'Cambio de domicilio',
      }),
    ],
    [
      'm-aeat-form',
      fakePage({
        host: 'sede.agenciatributaria.gob.es',
        title: 'Comunicación de cambio de domicilio',
        kind: 'form',
        color: aeat,
        lines: ['Tipo de vía y nombre', 'Número / Piso / Puerta', 'Código postal', 'Municipio'],
        button: 'Firmar y enviar',
      }),
    ],
    [
      'm-fnmt-form',
      fakePage({
        host: 'www.sede.fnmt.gob.es',
        title: 'Solicitar certificado',
        kind: 'form',
        color: fnmt,
        lines: [
          'Nº del documento de identificación',
          'Primer apellido',
          'Correo electrónico',
          'Confirma el correo',
        ],
        button: 'Enviar petición',
      }),
    ],
    [
      'm-icp-select',
      fakePage({
        host: 'icp.administracionelectronica.gob.es',
        title: 'Cita previa · Extranjería',
        kind: 'list',
        color: icp,
        lines: [
          'Madrid',
          'Toma de huella (expedición de tarjeta)',
          'Recogida de tarjeta',
          'Certificados UE',
        ],
        highlight: 'Toma de huella (expedición de tarjeta)',
      }),
    ],
    [
      'm-icp-none',
      fakePage({
        host: 'icp.administracionelectronica.gob.es',
        title: 'Cita previa · Extranjería',
        kind: 'message',
        color: icp,
        lines: [
          'En este momento no hay citas disponibles.',
          'En breve la Comunidad de Madrid habilitará',
          'nuevas citas. Inténtalo más tarde.',
        ],
        button: 'Volver',
      }),
    ],
    [
      'm-cm-form',
      fakePage({
        host: 'sede.comunidad.madrid',
        title: 'Bono Alquiler Joven · Solicitud',
        kind: 'form',
        color: cm,
        lines: ['Importe mensual del alquiler', 'Referencia catastral', 'IBAN', 'Documentación'],
        button: 'Firmar y presentar',
      }),
    ],
    [
      'm-tse-form',
      fakePage({
        host: 'sede.seg-social.gob.es',
        title: 'Tarjeta Sanitaria Europea',
        kind: 'form',
        color: ss,
        lines: ['Domicilio de envío', 'Código postal', 'Motivo del desplazamiento'],
        button: 'Enviar',
      }),
    ],
    [
      'm-madrid-home',
      fakePage({
        host: 'sede.madrid.es',
        title: 'Alta en el Padrón Municipal',
        kind: 'home',
        color: '#b3262e',
        lines: ['Empadronamiento', 'Volante', 'Certificado'],
      }),
    ],
    [
      'm-movil-qr',
      fakePage({
        host: 'clave.gob.es',
        title: 'Cl@ve Móvil',
        kind: 'qr',
        color: '#4a5d73',
        lines: ['Escanea el código con la app Cl@ve'],
      }),
    ],
  ]);
}

// ---------------------------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------------------------

const act = (
  id: string,
  createdAt: string,
  tool: string,
  args: Record<string, unknown>,
  summary?: string,
  extra: Partial<ActivityItem> = {},
): ActivityItem => ({
  id,
  type: 'activity',
  createdAt,
  toolCallId: `call-${id}`,
  tool,
  args,
  status: 'done',
  summary,
  finishedAt: createdAt,
  ...extra,
});

const user = (id: string, createdAt: string, text: string): ChatItem => ({
  id,
  type: 'user',
  createdAt,
  text,
});

const bot = (id: string, createdAt: string, text: string): ChatItem => ({
  id,
  type: 'assistant',
  createdAt,
  text,
  status: 'complete',
});

const started = (t: Tr) => t('Trámite creado', 'Procedure created');

/** The compact row the app adds to the conversation when a procedure's agent reports. */
export function reportRow(
  id: string,
  createdAt: string,
  procedureId: string,
  title: string,
  summary: string,
  status: 'done' | 'error' = 'done',
): ActivityItem {
  return act(id, createdAt, REPORT_TOOL, { procedureId, title }, summary, {
    toolCallId: `report-${procedureId}-${createdAt}`,
    status,
  });
}

// ---------------------------------------------------------------------------------------------
// URLs used by the demo agents
// ---------------------------------------------------------------------------------------------

export const URLS = {
  fnmt: 'https://www.sede.fnmt.gob.es/certificados/persona-fisica',
  fnmtRequest:
    'https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-software/solicitar-certificado',
  dniRenew: 'https://www.dnielectronico.es/PortalDNIe/PRF1_Cons02.action?pag=REF_1081',
  dniCita: 'https://www.citapreviadnie.es/citaPreviaDni/',
  dniTasa: 'https://sede.policia.gob.es/Tasasweb/',
  aeat030: 'https://sede.agenciatributaria.gob.es/Sede/procedimientoini/G322.shtml',
  aeatCensos: 'https://sede.agenciatributaria.gob.es/Sede/censos-nif-domicilio-fiscal.html',
  padron: 'https://sede.madrid.es/portal/site/tramites/padron-alta-inscripcion',
  padronRequest: 'https://sede.madrid.es/portal/site/tramites/padron-alta-solicitud',
};

// ---------------------------------------------------------------------------------------------
// The pending form of the DNI agent
// ---------------------------------------------------------------------------------------------

/** The DNI agent's pending question, shown on its card. */
export function dniPrompt(now: number, t: Tr): PromptItem {
  return {
    id: DEMO_IDS.dniPrompt,
    type: 'prompt',
    createdAt: at(now, 5),
    procedureId: DEMO_IDS.dni,
    status: 'pending',
    prompt: dniForm(t),
  };
}

/** What the mock transcription returns for the demo call. */
export const DEMO_CALL_TRANSCRIPT = `Ellos: EMASESA, buenos días, le atiende Carmen.
Tú: Hola, buenos días. Soy inquilino y quiero actualizar el número de personas que vivimos en la casa. El contrato está a nombre de la propietaria.
Ellos: Sí, lo puede pedir usted. Necesitamos el volante de empadronamiento colectivo y una copia del contrato de alquiler.
Tú: ¿Y dónde lo envío?
Ellos: Por la oficina virtual o por correo electrónico. Se aplica en la siguiente factura.`;

export function dniForm(t: Tr): FormPrompt {
  return {
    kind: 'form',
    title: t('¿Dónde y cuándo quieres la cita?', 'Where and when do you want the appointment?'),
    allowDismiss: false,
    message: t(
      'Busco la primera cita libre que encaje contigo. Puedes cambiar lo que quieras.',
      'I’ll look for the first free slot that suits you. Change anything you like.',
    ),
    submitLabel: t('Buscar cita', 'Find a slot'),
    fields: [
      {
        key: 'provincia',
        label: t('Provincia', 'Province'),
        type: 'select',
        required: true,
        defaultValue: 'Madrid',
        options: [
          { value: 'Madrid', label: 'Madrid' },
          { value: 'Toledo', label: 'Toledo' },
          { value: 'Guadalajara', label: 'Guadalajara' },
          { value: 'Valencia', label: 'Valencia' },
        ],
      },
      {
        key: 'oficina',
        label: t('Oficina', 'Office'),
        type: 'select',
        required: true,
        defaultValue: 'cercana',
        options: [
          { value: 'cercana', label: t('La más cercana a mi casa', 'The closest to my home') },
          { value: 'retiro', label: 'Madrid – Retiro (Calle Rafael Calvo)' },
          { value: 'leganitos', label: 'Madrid – Centro (Calle Leganitos)' },
          { value: 'moratalaz', label: 'Madrid – Moratalaz' },
        ],
      },
      {
        key: 'franja',
        label: t('¿A qué hora te viene mejor?', 'What time suits you best?'),
        type: 'select',
        required: true,
        defaultValue: 'manana',
        options: [
          { value: 'manana', label: t('Mañanas', 'Mornings') },
          { value: 'tarde', label: t('Tardes', 'Afternoons') },
        ],
      },
      {
        key: 'desde',
        label: t('A partir de', 'From'),
        type: 'date',
        required: true,
        defaultValue: '2026-10-06',
        help: t('Busco citas desde este día.', 'I’ll look for slots from this day on.'),
      },
      {
        key: 'telefono',
        label: t('Teléfono para el SMS', 'Phone for the text message'),
        type: 'phone',
        required: true,
        defaultValue: '+34 612 345 678',
        vaultKey: 'phone',
      },
      {
        key: 'otraOficina',
        label: t(
          'Si hay una cita antes en otra oficina de Madrid, cógela',
          'If there’s an earlier slot at another Madrid office, take it',
        ),
        type: 'boolean',
        required: false,
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Procedures (cards)
// ---------------------------------------------------------------------------------------------

function card(
  p: Omit<Procedure, 'archived'> & { archived?: boolean },
  rt: Partial<ProcedureRuntime> = {},
): ProcedureListItem {
  return { ...p, archived: p.archived ?? false, runtime: runtime(rt) };
}

function demoProcedures(now: number, t: Tr): ProcedureListItem[] {
  const hacienda = card(
    {
      id: DEMO_IDS.hacienda,
      title: t('Cambiar el domicilio en Hacienda', 'Change your address with the Tax Agency'),
      summary: t(
        'Decirle a la Agencia Tributaria tu nueva dirección en Madrid. Es gratis y se hace online.',
        'Tell the Tax Agency your new address in Madrid. It’s free and done online.',
      ),
      status: 'in_progress',
      administration: { level: 'state', name: 'Agencia Tributaria' },
      nextAction: {
        text: t('Revisar y firmar el cambio de domicilio', 'Review and sign the address change'),
        owner: 'user',
      },
      steps: [
        {
          id: 'entrar',
          title: t('Entrar en la sede de la Agencia Tributaria', 'Sign in to the Tax Agency site'),
          status: 'done',
          owner: 'agent',
        },
        {
          id: 'rellenar',
          title: t('Rellenar la nueva dirección', 'Fill in the new address'),
          status: 'done',
          owner: 'agent',
          detail: 'Calle de Alcalá 123, 4º B · 28009 Madrid.',
        },
        {
          id: 'firmar',
          title: t('Firmar y enviar el cambio', 'Sign and send the change'),
          status: 'current',
          owner: 'user',
          detail: t(
            'Revisa que la dirección esté bien y firma con tu certificado digital.',
            'Check the address is right and sign with your digital certificate.',
          ),
        },
        {
          id: 'justificante',
          title: t('Guardar el justificante', 'Save the receipt'),
          status: 'pending',
          owner: 'agent',
        },
      ],
      requirements: [
        {
          id: 'direccion',
          label: t('Tu nueva dirección', 'Your new address'),
          status: 'have',
        },
        {
          id: 'cert',
          label: t('Certificado digital o Cl@ve', 'Digital certificate or Cl@ve'),
          status: 'have',
        },
      ],
      facts: [
        {
          label: t('Cómo', 'How'),
          value: t(
            'Se hace online con certificado digital.',
            'Online, with a digital certificate.',
          ),
        },
        { label: t('Coste', 'Cost'), value: t('Gratis.', 'Free.') },
        {
          label: t('Plazo', 'Deadline'),
          value: t('3 meses desde el cambio.', '3 months from the move.'),
        },
      ],
      sources: [
        source(
          t(
            'Modelo 030 · Cambio de domicilio — Agencia Tributaria',
            'Form 030 · Change of address — Tax Agency',
          ),
          URLS.aeat030,
        ),
      ],
      createdAt: dayAt(now, 2, 12, 10),
      updatedAt: dayAt(now, 1, 9, 20),
    },
    { unread: true },
  );

  const dni = card(
    {
      id: DEMO_IDS.dni,
      title: t('Renovar el DNI', 'Renew your DNI'),
      summary: t(
        'Tu DNI caduca el 31 de octubre. Hay que ir en persona con cita previa; te dan el nuevo en el momento.',
        'Your DNI expires on 31 October. You go in person with an appointment and get the new one on the spot.',
      ),
      status: 'in_progress',
      administration: { level: 'state', name: 'Policía Nacional' },
      nextAction: {
        text: t(
          'Decirme dónde y cuándo quieres la cita',
          'Tell me where and when you want the appointment',
        ),
        owner: 'user',
      },
      steps: [
        {
          id: 'documentos',
          title: t('Reunir documentos', 'Gather documents'),
          status: 'done',
          owner: 'user',
          detail: t('Tu DNI actual y una foto reciente.', 'Your current DNI and a recent photo.'),
        },
        {
          id: 'tasa',
          title: t('Pagar la tasa', 'Pay the fee'),
          status: 'done',
          owner: 'agent',
          detail: t('12 € pagados el 1 de octubre.', '€12 paid on 1 October.'),
        },
        {
          id: 'cita',
          title: t('Pedir cita en comisaría', 'Book an appointment at the police station'),
          status: 'current',
          owner: 'agent',
          detail: t(
            'La pido yo en cuanto me digas dónde y cuándo.',
            'I’ll book it as soon as you tell me where and when.',
          ),
        },
        {
          id: 'acudir',
          title: t('Acudir a la cita', 'Go to the appointment'),
          status: 'pending',
          owner: 'user',
          detail: t('Lleva tu DNI actual y la foto.', 'Bring your current DNI and the photo.'),
        },
      ],
      requirements: [
        { id: 'dni', label: t('Tu DNI actual', 'Your current DNI'), status: 'have' },
        {
          id: 'foto',
          label: t(
            'Una foto reciente en color, fondo blanco',
            'A recent colour photo, white background',
          ),
          status: 'have',
          detail: t(
            'Tienes una en Mis datos. Llévala impresa.',
            'You have one in My data. Bring it printed.',
          ),
        },
        { id: 'tasa', label: t('Tasa de 12 € pagada', '€12 fee paid'), status: 'have' },
        {
          id: 'padron',
          label: t('Certificado de empadronamiento', 'Padrón certificate'),
          status: 'unknown',
          detail: t(
            'Solo si quieres cambiar la dirección que sale en el DNI.',
            'Only if you want to change the address on your DNI.',
          ),
        },
      ],
      facts: [
        {
          label: t('Dónde', 'Where'),
          value: t(
            'Renovación presencial en una oficina de expedición.',
            'In person, at a DNI office.',
          ),
        },
        {
          label: t('Coste', 'Cost'),
          value: t('12 € en general; hay exenciones.', '€12 in general; some people are exempt.'),
        },
        {
          label: t('Caducidad', 'Expiry'),
          value: t(
            'Caduca el 31/10/2026. Ya puedes renovarlo.',
            'Expires on 31/10/2026. You can renew it now.',
          ),
        },
      ],
      sources: [
        source(
          t('Renovación del DNI — Portal del DNIe', 'DNI renewal — DNIe portal'),
          URLS.dniRenew,
        ),
        source(t('Cita previa DNI y pasaporte', 'DNI and passport appointments'), URLS.dniCita),
      ],
      createdAt: dayAt(now, 3, 18, 5),
      updatedAt: at(now, 5),
    },
    { activity: 'needs_user', unread: true, prompts: [dniPrompt(now, t)] },
  );

  const fnmt = card(
    {
      id: DEMO_IDS.fnmt,
      title: t('Certificado digital (FNMT)', 'Digital certificate (FNMT)'),
      summary: t(
        'Tu certificado de persona física ya está instalado y guardado en Mis datos.',
        'Your personal certificate is installed and saved in My data.',
      ),
      status: 'done',
      administration: { level: 'state', name: 'Fábrica Nacional de Moneda y Timbre' },
      steps: [
        {
          id: 'solicitar',
          title: t('Solicitar el certificado', 'Request the certificate'),
          status: 'done',
          owner: 'agent',
        },
        {
          id: 'validar',
          title: t('Validar tu identidad', 'Verify your identity'),
          status: 'done',
          owner: 'user',
          detail: t(
            'En una oficina, con tu DNI y el código.',
            'At an office, with your DNI and the code.',
          ),
        },
        {
          id: 'instalar',
          title: t('Instalar el certificado', 'Install the certificate'),
          status: 'done',
          owner: 'agent',
        },
      ],
      requirements: [
        { id: 'dni', label: t('Tu DNI', 'Your DNI'), status: 'have' },
        { id: 'email', label: t('Un correo electrónico', 'An email address'), status: 'have' },
      ],
      facts: [
        {
          label: t('Cómo', 'How'),
          value: t(
            'Se solicita online y se valida en persona.',
            'Requested online, verified in person.',
          ),
        },
        { label: t('Coste', 'Cost'), value: t('Gratis.', 'Free.') },
        {
          label: t('Validez', 'Valid for'),
          value: t('Válido durante 4 años.', 'Valid for 4 years.'),
        },
      ],
      sources: [
        source(t('Certificado de persona física — FNMT', 'Personal certificate — FNMT'), URLS.fnmt),
      ],
      createdAt: dayAt(now, 3, 18, 5),
      updatedAt: at(now, 6),
    },
    {},
  );

  const padron = card(
    {
      id: DEMO_IDS.padron,
      title: t('Empadronarme en Madrid', 'Register my address in Madrid'),
      summary: t(
        'Darte de alta en el padrón de Madrid. Estoy mirando si se puede hacer todo online.',
        'Sign you up on Madrid’s register of residents. I’m checking whether it can all be done online.',
      ),
      status: 'researching',
      administration: { level: 'local', name: 'Ayuntamiento de Madrid' },
      steps: [
        {
          id: 'requisitos',
          title: t('Leer los requisitos', 'Read the requirements'),
          status: 'current',
          owner: 'agent',
        },
        {
          id: 'contrato',
          title: t('Reunir el contrato de alquiler', 'Get your rental contract'),
          status: 'pending',
          owner: 'user',
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
        {
          id: 'contrato',
          label: t('Contrato de alquiler o escritura', 'Rental contract or title deed'),
          status: 'missing',
        },
      ],
      facts: [
        {
          label: t('Dónde', 'Where'),
          value: t(
            'Se pide en el ayuntamiento o con cita previa.',
            'At the town hall, online or with an appointment.',
          ),
        },
        { label: t('Coste', 'Cost'), value: t('Gratis.', 'Free.') },
        {
          label: t('Necesitas', 'You need'),
          value: t('Contrato o escritura de la vivienda.', 'Your rental contract or title deed.'),
        },
      ],
      sources: [
        source(
          t(
            'Alta en el Padrón — Ayuntamiento de Madrid',
            'Padrón registration — Madrid City Council',
          ),
          URLS.padron,
        ),
      ],
      createdAt: dayAt(now, 1, 20, 15),
      updatedAt: at(now, 1),
    },
    {
      activity: 'working',
      workingSince: at(now, 1),
      now: { tool: 'fetch_url', args: { url: URLS.padron } },
    },
  );

  return [hacienda, dni, fnmt, padron];
}

// ---------------------------------------------------------------------------------------------
// Activity logs of the procedures' agents
// ---------------------------------------------------------------------------------------------

export const REPORTS = {
  fnmt1: (t: Tr) =>
    t(
      'Certificado pedido. A Lucía le ha llegado un código al correo. Ahora tiene que validar su identidad en una oficina con el DNI y ese código.',
      'Certificate requested. Lucía got a code by email. Now she has to verify her identity at an office with her DNI and that code.',
    ),
  fnmt2: (t: Tr) =>
    t(
      'Certificado comprobado: está en Mis datos y vale 4 años. Trámite terminado.',
      'Certificate checked: it’s in My data and valid for 4 years. Procedure finished.',
    ),
  dni1: (t: Tr) =>
    t(
      'Tasa pagada (12 €) y justificante guardado. Lucía ya tiene foto reciente. Falta pedir cita en comisaría.',
      'Fee paid (€12) and receipt saved. Lucía has a recent photo. Next: book the appointment.',
    ),
  hacienda1: (t: Tr) =>
    t(
      'Nueva dirección rellenada en la sede de la Agencia Tributaria. Falta que Lucía revise y firme el envío.',
      'New address filled in on the Tax Agency site. Lucía needs to review and sign it.',
    ),
  padron1: (t: Tr) =>
    t(
      'El alta online en Madrid pide certificado digital. Lo retomo cuando Lucía lo tenga instalado.',
      'Registering online in Madrid needs a digital certificate. I’ll pick it up once Lucía has it installed.',
    ),
};

function demoLogs(now: number, t: Tr): Map<string, ChatItem[]> {
  const personal = (key: string) => ({ value: { source: 'personal', key } });

  const fnmt: ChatItem[] = [
    user(
      'fnmt-l01',
      dayAt(now, 3, 18, 5),
      t(
        'Lucía necesita el certificado de persona física de la FNMT para hacer trámites online. Tiene DNI. Pídelo y guíala para validarlo.',
        'Lucía needs the FNMT personal certificate to do things online. She has a DNI. Request it and guide her through verifying it.',
      ),
    ),
    act(
      'fnmt-l02',
      dayAt(now, 3, 18, 5),
      'web_research',
      { query: 'certificado-digital-fnmt', mode: 'balanced' },
      t('Investigación completada', 'Research complete'),
    ),
    act(
      'fnmt-l03',
      dayAt(now, 3, 18, 6),
      'fetch_url',
      { url: URLS.fnmt },
      t('Se pide online y se valida en una oficina', 'Request online, verify at an office'),
    ),
    act('fnmt-l04', dayAt(now, 3, 18, 6), 'procedure_update', {}, t('Plan listo', 'Plan ready')),
    act(
      'fnmt-l05',
      dayAt(now, 3, 18, 6),
      'ask_user',
      { title: t('Datos para pedir el certificado', 'Details to request the certificate') },
      t('Respondido', 'Answered'),
      { finishedAt: dayAt(now, 3, 18, 8) },
    ),
    act('fnmt-l06', dayAt(now, 3, 18, 9), 'browser_open', { url: URLS.fnmtRequest }, undefined, {
      imageId: 'm-fnmt-form',
    }),
    act('fnmt-l07', dayAt(now, 3, 18, 10), 'browser_fill_from_vault', personal('dniNumber')),
    act('fnmt-l08', dayAt(now, 3, 18, 10), 'browser_fill_from_vault', personal('email')),
    act(
      'fnmt-l09',
      dayAt(now, 3, 18, 11),
      'browser_click',
      { element: t('Enviar petición', 'Enviar petición') },
      t('Código de solicitud enviado a tu correo', 'Request code sent to your email'),
    ),
    act('fnmt-l10', dayAt(now, 3, 18, 30), 'procedure_update', {}),
    bot('fnmt-l11', dayAt(now, 3, 18, 31), REPORTS.fnmt1(t)),
    user(
      'fnmt-l12',
      at(now, 7),
      t(
        'Lucía dice que ya tiene instalado el certificado digital de la FNMT.',
        'Lucía says the FNMT digital certificate is now installed.',
      ),
    ),
    act(
      'fnmt-l13',
      at(now, 7),
      'vault_read',
      {},
      t(
        'Certificado de Lucía Martín Ortega, válido 4 años',
        'Lucía Martín Ortega’s certificate, valid 4 years',
      ),
    ),
    act(
      'fnmt-l14',
      at(now, 6),
      'procedure_update',
      {},
      t('Trámite terminado', 'Procedure finished'),
    ),
    bot('fnmt-l15', at(now, 6), REPORTS.fnmt2(t)),
  ];

  const dni: ChatItem[] = [
    user(
      'dni-l01',
      dayAt(now, 3, 18, 5),
      t(
        'El DNI de Lucía caduca el 31/10/2026. Vive en Madrid (Calle de Alcalá 123). Prepara la renovación y pide cita.',
        'Lucía’s DNI expires on 31/10/2026. She lives in Madrid (Calle de Alcalá 123). Prepare the renewal and book an appointment.',
      ),
    ),
    act(
      'dni-l02',
      dayAt(now, 3, 18, 5),
      'feedback_search',
      { query: t('renovar DNI Madrid cita previa', 'renew DNI Madrid appointment') },
      t('4 experiencias útiles', '4 useful experiences'),
    ),
    act(
      'dni-l03',
      dayAt(now, 3, 18, 6),
      'web_research',
      { query: 'renovar-dni', mode: 'balanced' },
      t('Investigación completada', 'Research complete'),
    ),
    act(
      'dni-l04',
      dayAt(now, 3, 18, 7),
      'fetch_url',
      { url: URLS.dniRenew },
      t('Hace falta el DNI actual, una foto y 12 €', 'Needs the current DNI, a photo and €12'),
    ),
    act(
      'dni-l05',
      dayAt(now, 3, 18, 7),
      'vault_read',
      {},
      t(
        'Caduca el 31/10/2026; hay una foto reciente',
        'Expires 31/10/2026; there’s a recent photo',
      ),
    ),
    act('dni-l06', dayAt(now, 3, 18, 8), 'procedure_update', {}, t('Plan listo', 'Plan ready')),
    act(
      'dni-l07',
      dayAt(now, 3, 18, 40),
      'confirm_action',
      { title: t('¿Pago la tasa del DNI?', 'Shall I pay the DNI fee?') },
      t('Aprobado', 'Approved'),
      { finishedAt: dayAt(now, 2, 11, 40) },
    ),
    act('dni-l08', dayAt(now, 2, 11, 40), 'browser_open', { url: URLS.dniTasa }),
    act('dni-l09', dayAt(now, 2, 11, 41), 'browser_fill_from_vault', personal('dniNumber')),
    act(
      'dni-l10',
      dayAt(now, 2, 11, 42),
      'browser_click',
      { element: 'Pagar 12,00 €' },
      t('Pago hecho. Justificante guardado', 'Paid. Receipt saved'),
    ),
    act('dni-l11', dayAt(now, 2, 11, 42), 'procedure_update', {}),
    bot('dni-l12', dayAt(now, 2, 11, 43), REPORTS.dni1(t)),
    user(
      'dni-l13',
      at(now, 6),
      t(
        'Lucía ya tiene el certificado digital. Puedes seguir con la cita.',
        'Lucía now has her digital certificate. You can go ahead with the appointment.',
      ),
    ),
    act(
      DEMO_IDS.dniPromptActivity,
      at(now, 5),
      'ask_user',
      {
        title: t('¿Dónde y cuándo quieres la cita?', 'Where and when do you want the appointment?'),
      },
      undefined,
      { status: 'running', finishedAt: undefined },
    ),
  ];

  const hacienda: ChatItem[] = [
    user(
      'hac-l01',
      dayAt(now, 2, 12, 10),
      t(
        'Lucía se ha mudado de Valencia a Madrid: Calle de Alcalá 123, 4º B, 28009. Comunica el cambio de domicilio fiscal a la Agencia Tributaria.',
        'Lucía moved from Valencia to Madrid: Calle de Alcalá 123, 4º B, 28009. Tell the Tax Agency about the change of tax address.',
      ),
    ),
    act(
      'hac-l02',
      dayAt(now, 2, 12, 11),
      'fetch_url',
      { url: 'https://sede.agenciatributaria.gob.es/' },
      t('Página leída', 'Page read'),
    ),
    act(
      'hac-l03',
      dayAt(now, 2, 12, 11),
      'fetch_url',
      { url: URLS.aeat030 },
      t('Modelo 030: gratis y online', 'Form 030: free and online'),
    ),
    act('hac-l04', dayAt(now, 2, 12, 12), 'procedure_update', {}, t('Plan listo', 'Plan ready')),
    act('hac-l05', dayAt(now, 1, 9, 10), 'browser_open', { url: URLS.aeatCensos }, undefined, {
      imageId: 'm-aeat-home',
    }),
    act('hac-l06', dayAt(now, 1, 9, 11), 'browser_fill_from_vault', {
      value: { source: 'credential', credentialId: 'cred-clave', field: 'username' },
    }),
    act('hac-l07', dayAt(now, 1, 9, 11), 'browser_fill_from_vault', {
      value: { source: 'credential', credentialId: 'cred-clave', field: 'password' },
    }),
    act(
      'hac-l08',
      dayAt(now, 1, 9, 12),
      'browser_click',
      { element: 'Cambio de domicilio' },
      t('Sesión iniciada', 'Signed in'),
    ),
    act('hac-l09', dayAt(now, 1, 9, 14), 'browser_fill_from_vault', personal('addressStreet')),
    act('hac-l10', dayAt(now, 1, 9, 14), 'browser_fill_from_vault', personal('addressPostalCode')),
    act(
      'hac-l11',
      dayAt(now, 1, 9, 15),
      'browser_screenshot',
      {},
      t('Formulario relleno, sin enviar', 'Form filled in, not sent'),
      { imageId: 'm-aeat-form' },
    ),
    act('hac-l12', dayAt(now, 1, 9, 19), 'procedure_update', {}),
    bot('hac-l13', dayAt(now, 1, 9, 20), REPORTS.hacienda1(t)),
  ];

  const padron: ChatItem[] = [
    user(
      'pad-l01',
      dayAt(now, 1, 20, 15),
      t(
        'Lucía vive de alquiler en Calle de Alcalá 123, 4º B, 28009 Madrid. Antes estaba empadronada en Valencia. Empadrónala en Madrid, online si se puede.',
        'Lucía rents at Calle de Alcalá 123, 4º B, 28009 Madrid. She was registered in Valencia. Register her in Madrid, online if possible.',
      ),
    ),
    act(
      'pad-l02',
      dayAt(now, 1, 20, 16),
      'feedback_search',
      { query: t('empadronarse Madrid online alquiler', 'register padrón Madrid online rental') },
      t('3 experiencias útiles', '3 useful experiences'),
    ),
    act(
      'pad-l03',
      dayAt(now, 1, 20, 17),
      'web_research',
      { query: 'empadronamiento', mode: 'balanced' },
      t('Investigación completada', 'Research complete'),
    ),
    act(
      'pad-l04',
      dayAt(now, 1, 20, 19),
      'fetch_url',
      { url: 'https://sede.madrid.es/' },
      t('Página leída', 'Page read'),
    ),
    act('pad-l05', dayAt(now, 1, 20, 22), 'procedure_update', {}),
    bot('pad-l06', dayAt(now, 1, 20, 24), REPORTS.padron1(t)),
    user(
      'pad-l07',
      at(now, 6),
      t(
        'Lucía ya tiene el certificado digital. Sigue con el empadronamiento.',
        'Lucía now has her digital certificate. Carry on with the registration.',
      ),
    ),
    act(
      'pad-l08',
      at(now, 4),
      'boe_search',
      { query: t('padrón municipal', 'padrón municipal') },
      t('3 normas', '3 laws'),
    ),
    act('pad-l09', at(now, 1), 'fetch_url', { url: URLS.padron }, undefined, {
      status: 'running',
      finishedAt: undefined,
    }),
  ];

  return new Map([
    [DEMO_IDS.hacienda, hacienda],
    [DEMO_IDS.dni, dni],
    [DEMO_IDS.fnmt, fnmt],
    [DEMO_IDS.padron, padron],
  ]);
}

// ---------------------------------------------------------------------------------------------
// The conversation with the assistant
// ---------------------------------------------------------------------------------------------

function demoConversation(now: number, t: Tr, lang: Lang): ChatItem[] {
  const title = {
    fnmt: t('Certificado digital (FNMT)', 'Digital certificate (FNMT)'),
    dni: t('Renovar el DNI', 'Renew your DNI'),
    hacienda: t('Cambiar el domicilio en Hacienda', 'Change your address with the Tax Agency'),
    padron: t('Empadronarme en Madrid', 'Register my address in Madrid'),
  };
  const start = (id: string, time: string, key: keyof typeof title, brief: string) =>
    act(id, time, 'procedure_start', { title: title[key], brief }, started(t));
  const emailLabel = personalFieldDef('email')?.label[lang] ?? 'Email';

  return [
    // --- 30 sep ---------------------------------------------------------------------------
    user(
      'c-01',
      dayAt(now, 3, 18, 2),
      t(
        'Hola. Me acabo de mudar de Valencia a Madrid. ¿Qué papeles tengo que cambiar?',
        'Hi. I’ve just moved from Valencia to Madrid. What paperwork do I need to change?',
      ),
    ),
    bot(
      'c-02',
      dayAt(now, 3, 18, 2),
      t(
        '¡Bienvenida a Madrid! Al mudarte, lo normal es:\n\n- **Empadronarte** en Madrid.\n- **Cambiar tu domicilio en Hacienda.**\n- Y si tu DNI caduca pronto, **renovarlo**.\n\nCasi todo se hace online con un **certificado digital**. ¿Empiezo por ahí?',
        'Welcome to Madrid! When you move, you usually:\n\n- **Register** at the town hall (padrón).\n- **Change your address with the Tax Agency.**\n- And if your DNI expires soon, **renew it**.\n\nMost of it is done online with a **digital certificate**. Shall I start there?',
      ),
    ),
    user(
      'c-03',
      dayAt(now, 3, 18, 4),
      t(
        'Sí, empieza por el certificado. Y el DNI me caduca a finales de octubre.',
        'Yes, start with the certificate. And my DNI expires at the end of October.',
      ),
    ),
    start(
      'c-04',
      dayAt(now, 3, 18, 5),
      'fnmt',
      t(
        'Lucía necesita el certificado de persona física de la FNMT para hacer trámites online. Tiene DNI.',
        'Lucía needs the FNMT personal certificate to do things online. She has a DNI.',
      ),
    ),
    start(
      'c-05',
      dayAt(now, 3, 18, 5),
      'dni',
      t(
        'El DNI de Lucía caduca el 31/10/2026. Vive en Madrid. Prepara la renovación y pide cita.',
        'Lucía’s DNI expires on 31/10/2026. She lives in Madrid. Prepare the renewal and book an appointment.',
      ),
    ),
    bot(
      'c-06',
      dayAt(now, 3, 18, 5),
      t(
        'Hecho: he empezado el **certificado digital** y la **renovación del DNI**. Si necesitan algo de ti, te lo preguntarán en su tarjeta.',
        'Done: I’ve started the **digital certificate** and the **DNI renewal**. If they need anything from you, they’ll ask on their card.',
      ),
    ),
    {
      id: 'c-07',
      type: 'notice',
      createdAt: dayAt(now, 3, 18, 8),
      procedureId: DEMO_IDS.fnmt,
      level: 'info',
      text: t(`Guardado en Mis datos: ${emailLabel}.`, `Saved to My data: ${emailLabel}.`),
    },
    reportRow('c-08', dayAt(now, 3, 18, 31), DEMO_IDS.fnmt, title.fnmt, REPORTS.fnmt1(t)),
    bot(
      'c-09',
      dayAt(now, 3, 18, 31),
      t(
        'Ya he pedido tu certificado y te ha llegado un **código** al correo.\n\nAhora te toca a ti: ve a una oficina (de Hacienda o de la Seguridad Social, por ejemplo) con tu DNI y ese código.',
        'I’ve requested your certificate and you got a **code** by email.\n\nNow it’s your turn: go to an office (the Tax Agency or Social Security, for example) with your DNI and that code.',
      ),
    ),
    // --- 1 oct ----------------------------------------------------------------------------
    reportRow('c-10', dayAt(now, 2, 11, 43), DEMO_IDS.dni, title.dni, REPORTS.dni1(t)),
    bot(
      'c-11',
      dayAt(now, 2, 11, 43),
      t(
        'Tasa del DNI pagada: **12 €**. Aquí tienes el justificante:\n\n[Justificante tasa DNI](sa:document/doc-tasa-dni)',
        'DNI fee paid: **€12**. Here’s the receipt:\n\n[DNI fee receipt](sa:document/doc-tasa-dni)',
      ),
    ),
    user(
      'c-12',
      dayAt(now, 2, 12, 9),
      t('¿Y lo de Hacienda? ¿Lo puedes hacer tú?', 'And the Tax Agency thing? Can you do it?'),
    ),
    bot(
      'c-13',
      dayAt(now, 2, 12, 10),
      t(
        'Sí. El cambio de domicilio en Hacienda es gratis y se hace online. Lo empiezo ahora.',
        'Yes. Changing your address with the Tax Agency is free and done online. Starting it now.',
      ),
    ),
    start(
      'c-14',
      dayAt(now, 2, 12, 10),
      'hacienda',
      t(
        'Lucía se ha mudado de Valencia a Madrid: Calle de Alcalá 123, 4º B, 28009. Comunica el cambio de domicilio fiscal.',
        'Lucía moved from Valencia to Madrid: Calle de Alcalá 123, 4º B, 28009. Report the change of tax address.',
      ),
    ),
    // --- 2 oct ----------------------------------------------------------------------------
    reportRow(
      'c-15',
      dayAt(now, 1, 9, 20),
      DEMO_IDS.hacienda,
      title.hacienda,
      REPORTS.hacienda1(t),
    ),
    bot(
      'c-16',
      dayAt(now, 1, 9, 20),
      t(
        'He dejado listo el cambio de domicilio en Hacienda. Solo falta que **lo revises y lo firmes** tú.',
        'The address change for the Tax Agency is ready. You just need to **review and sign it**.',
      ),
    ),
    user(
      'c-17',
      dayAt(now, 1, 20, 14),
      t(
        'Ah, y empadronarme. ¿Eso cómo va?',
        'Oh, and registering at the town hall. How does that work?',
      ),
    ),
    start(
      'c-18',
      dayAt(now, 1, 20, 15),
      'padron',
      t(
        'Lucía vive de alquiler en Calle de Alcalá 123, 4º B, 28009 Madrid. Empadrónala en Madrid, online si se puede.',
        'Lucía rents at Calle de Alcalá 123, 4º B, 28009 Madrid. Register her in Madrid, online if possible.',
      ),
    ),
    bot(
      'c-19',
      dayAt(now, 1, 20, 15),
      t(
        'Lo he puesto en marcha. Normalmente hace falta el **contrato de alquiler**; te digo qué más en cuanto lo sepa.',
        'I’ve started it. You usually need your **rental contract**; I’ll tell you what else once I know.',
      ),
    ),
    reportRow('c-20', dayAt(now, 1, 20, 24), DEMO_IDS.padron, title.padron, REPORTS.padron1(t)),
    bot(
      'c-21',
      dayAt(now, 1, 20, 24),
      t(
        'Para empadronarte por internet hace falta el **certificado digital**. En cuanto lo tengas, sigo.',
        'To register online you need the **digital certificate**. As soon as you have it, I’ll carry on.',
      ),
    ),
    // --- today ----------------------------------------------------------------------------
    user(
      'c-22',
      at(now, 7),
      t(
        'Ya tengo instalado el certificado digital de la FNMT.',
        'I’ve installed the FNMT digital certificate.',
      ),
    ),
    bot(
      'c-23',
      at(now, 6),
      t(
        `Perfecto, lo he guardado en [tus datos](sa:vault/personal) y he actualizado tus trámites.\n\nPara pedir la cita del DNI hace falta saber dónde y cuándo te va mejor: te lo pregunta en [su tarjeta](sa:procedure/${DEMO_IDS.dni}).`,
        `Great, I’ve saved it in [your data](sa:vault/personal) and updated your procedures.\n\nTo book your DNI appointment it needs to know where and when suits you: it asks on [its card](sa:procedure/${DEMO_IDS.dni}).`,
      ),
    ),
  ];
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

function demoMediaExtra(t: Tr): [string, string][] {
  return [
    [
      'm-dni-cita',
      fakePage({
        host: 'www.citapreviadnie.es',
        title: t('Cita previa · Elige oficina', 'Appointment · Choose an office'),
        kind: 'list',
        color: '#24456b',
        lines: [
          'Madrid – Retiro',
          'Madrid – Centro (Leganitos)',
          'Madrid – Moratalaz',
          'Madrid – Chamartín',
        ],
        highlight: 'Madrid – Retiro',
      }),
    ],
    [
      'm-dni-ok',
      fakePage({
        host: 'www.citapreviadnie.es',
        title: t('Cita confirmada', 'Appointment confirmed'),
        kind: 'message',
        color: '#24456b',
        lines: [
          t('Su cita ha sido reservada.', 'Your appointment is booked.'),
          t('Recibirá un SMS de confirmación.', 'You will get a confirmation text.'),
        ],
        button: t('Imprimir justificante', 'Print receipt'),
      }),
    ],
  ];
}

export function createDemoState(
  now: number,
  opts: { provider: string | null; empty: boolean; onboarding: boolean; lang: Lang },
): MockState {
  const t = translator(opts.lang);
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    language: opts.lang,
    onboardingCompleted: !opts.onboarding,
  };
  const provider = providerPreset(opts.onboarding && !opts.provider ? 'none' : opts.provider);
  if (provider.kind === 'voucher') {
    settings.provider = {
      kind: 'voucher',
      secretId: 'sec-voucher',
      limitUsd: 5,
    };
  } else if (provider.kind === 'chatgpt') {
    settings.provider = { kind: 'chatgpt' };
  } else if (provider.kind === 'byok') {
    settings.provider = {
      kind: 'byok',
      provider: 'anthropic',
      model: provider.model ?? '',
      secretId: 'sec-byok',
    };
  }

  const storage: StorageInfo = {
    backend: 'macOS Keychain',
    secure: true,
    biometricAvailable: true,
  };
  const media = demoMedia();
  for (const [id, url] of demoMediaExtra(t)) media.set(id, url);
  if (opts.empty || opts.onboarding) {
    return {
      settings,
      provider,
      procedures: new Map(),
      logs: new Map(),
      conversation: [],
      chatState: { activity: 'idle' },
      personal: [],
      documents: [],
      documentPreviews: new Map(),
      credentials: [],
      storage,
      media,
    };
  }

  const { docs, previews } = demoDocuments(now, t);
  return {
    settings,
    provider,
    procedures: new Map(demoProcedures(now, t).map((p) => [p.id, p])),
    logs: demoLogs(now, t),
    conversation: demoConversation(now, t, opts.lang),
    chatState: { activity: 'idle' },
    personal: demoPersonal(now, opts.lang),
    documents: docs,
    documentPreviews: previews,
    credentials: demoCredentials(now),
    storage,
    media,
  };
}
