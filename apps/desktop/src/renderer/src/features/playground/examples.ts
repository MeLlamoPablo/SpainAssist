import type {
  ChatItem,
  CodemodeAgentInfo,
  ConfirmKind,
  DnieSignatureStage,
  DnieUnlock,
  Language,
  NextAction,
  PhoneCallPrompt,
  Prompt,
  PromptItem,
} from '@sa/shared';
import { playgroundWorkflows } from './workflows';

export type ExampleGroup =
  | 'interfaces'
  | 'approvals'
  | 'actions'
  | 'dnie'
  | 'procedures'
  | 'agents'
  | 'chat';
export interface PlaygroundExample {
  id: string;
  group: ExampleGroup;
  label: string;
  /** What raises it: the workflow API (`api.user.confirm({ kind: "payment" })`) or the item's type. */
  code: string;
  /** A workflow's source (interfaces), run by the real kernel. */
  source?: string;
  item?: ChatItem;
  procedureId?: string;
  /** Starting value of the procedure row's state picker. */
  procedureState?: string;
  /** The agents on the meter (agents). */
  agents?: CodemodeAgentInfo[];
}
const PLAYGROUND_TIME = '2026-10-04T10:00:00.000Z';

/** How a workflow raises each approval: `api.user.confirm`, or the app on its own. */
const CONFIRM_CODE: Record<ConfirmKind, string> = {
  action: 'api.user.confirm({ kind: "action" })',
  submission: 'api.user.confirm({ kind: "submission" })',
  payment: 'api.user.confirm({ kind: "payment" })',
  credential: 'page.loginClave() · policy "ask"',
  signature: 'locator.click() · firma',
  certificate_site: 'page.useCertificate({ origins })',
};

/**
 * Mock-only catalogue: workflows (run for real), the host-owned questions codemode still raises,
 * procedure rows, the agent meter and the coordinator's chat. Each question is also registered
 * with the mock API.
 */
export function playgroundExamples(language: Language): PlaygroundExample[] {
  const t = (es: string, en: string) => (language === 'es' ? es : en);
  const examples: PlaygroundExample[] = playgroundWorkflows(language).map((w) => ({
    id: w.id,
    group: 'interfaces',
    label: w.label,
    code: w.code,
    source: w.source,
  }));
  const addPrompt = (
    id: string,
    group: ExampleGroup,
    label: string,
    code: string,
    prompt: Prompt,
  ) => {
    examples.push({
      id,
      group,
      label,
      code,
      item: {
        id: `playground-${id}`,
        type: 'prompt',
        createdAt: PLAYGROUND_TIME,
        prompt,
        status: 'pending',
      },
    });
  };
  const confirmations = {
    action: [
      t('Reservar una cita', 'Book an appointment'),
      t(
        'Voy a reservar esta cita de ejemplo. ¿Quieres continuar?',
        'I will book this example appointment. Would you like to continue?',
      ),
    ],
    submission: [
      t('Enviar una solicitud', 'Submit an application'),
      t(
        'Revisa estos datos antes de enviar la solicitud.',
        'Review these details before submitting the application.',
      ),
    ],
    payment: [
      t('Pagar una tasa', 'Pay a fee'),
      t('El pago de ejemplo es de 12 €.', 'The example payment is €12.'),
    ],
    credential: [
      t('Usar una credencial', 'Use a credential'),
      t(
        'La app usará tu credencial de ejemplo para entrar.',
        'The app will use your example credential to sign in.',
      ),
    ],
    signature: [
      t('Firmar un documento', 'Sign a document'),
      t('Revisa el documento antes de firmarlo.', 'Review the document before signing it.'),
    ],
  } as const;
  for (const [confirmKind, [title, message]] of Object.entries(confirmations))
    addPrompt(
      `confirm-${confirmKind}`,
      'approvals',
      title,
      CONFIRM_CODE[confirmKind as ConfirmKind],
      {
        kind: 'confirm',
        confirmKind: confirmKind as keyof typeof confirmations,
        title,
        message,
        details: [
          {
            label: t('Trámite', 'Procedure'),
            value: t('Solicitud de ejemplo', 'Example application'),
          },
          { label: t('Importe', 'Amount'), value: confirmKind === 'payment' ? '12 €' : '0 €' },
        ],
        biometric: confirmKind === 'credential' || confirmKind === 'signature',
      },
    );
  // What main asks before the agent presents a certificate or the DNI (browser_use_certificate).
  const certificateUse = (dnie: boolean): Prompt => ({
    kind: 'confirm',
    confirmKind: 'credential',
    title: dnie
      ? t('¿Usar tu DNI?', 'Use your DNI?')
      : t('¿Usar tu certificado digital?', 'Use your digital certificate?'),
    message: dnie
      ? t(
          'El asistente quiere identificarte con tu DNI en las webs oficiales de este trámite. Cuando la web lo pida, el móvil leerá tu DNI.',
          'The assistant wants to identify you with your DNI on the official websites for this procedure. When the site asks for it, your phone will read your DNI.',
        )
      : t(
          'El asistente quiere identificarte con tu certificado digital en las webs oficiales de este trámite.',
          'The assistant wants to identify you with your digital certificate on the official websites for this procedure.',
        ),
    details: [
      { label: dnie ? 'DNI' : t('Certificado', 'Certificate'), value: 'LUCÍA MARTÍN ORTEGA' },
      { label: t('Webs', 'Websites'), value: 'sede.example.gob.es' },
    ],
    confirmLabel: t('Usar', 'Use'),
    rejectLabel: t('No usar', "Don't use"),
    // The DNI has no Touch ID: the phone and the card are the second factor.
    biometric: !dnie,
  });
  addPrompt(
    'confirm-certificate',
    'approvals',
    t('Usar el certificado', 'Use the certificate'),
    'page.useCertificate()',
    certificateUse(false),
  );
  addPrompt(
    'confirm-certificate-dnie',
    'approvals',
    t('Usar el DNI', 'Use the DNI'),
    'page.useCertificate() · DNI',
    certificateUse(true),
  );
  addPrompt(
    'confirm-certificate_site',
    'approvals',
    t('Web nueva para el certificado', 'New website for the certificate'),
    'page.useCertificate({ origins })',
    {
      kind: 'confirm',
      confirmKind: 'certificate_site',
      title: t(
        '¿Permitir tu certificado en sede.ejemplo.es?',
        'Allow your certificate on sede.ejemplo.es?',
      ),
      message: t(
        'sede.ejemplo.es no está en la lista de webs oficiales de la app. Permítelo solo si reconoces la web.\n\n**Lo que ha comprobado:** la web del ayuntamiento enlaza a esta sede.',
        "sede.ejemplo.es is not on the app's list of official websites. Only allow it if you recognise the website.\n\n**What it checked:** the town hall's website links to this site.",
      ),
      details: [
        { label: t('Web', 'Website'), value: 'https://sede.ejemplo.es' },
        { label: t('Fuente 1', 'Source 1'), value: 'https://www.ejemplo.es/sede' },
        { label: t('Fuente 2', 'Source 2'), value: 'https://www.diputacion.ejemplo.es/sedes' },
        { label: t('Fuente 3', 'Source 3'), value: 'https://administracion.gob.es/ejemplo' },
      ],
      confirmLabel: t('Permitir', 'Allow'),
      rejectLabel: t('No permitir', "Don't allow"),
    },
  );
  addPrompt(
    'confirm-danger',
    'approvals',
    t('Acción irreversible', 'Irreversible action'),
    'api.user.confirm({ danger: true })',
    {
      kind: 'confirm',
      confirmKind: 'action',
      title: t('Cancelar una cita', 'Cancel an appointment'),
      message: t(
        'Esta cita de ejemplo se cancelará.',
        'This example appointment will be cancelled.',
      ),
      danger: true,
    },
  );
  const actions = {
    captcha: [
      t('Resolver un captcha', 'Solve a captcha'),
      t(
        'La web pide un código de seguridad. Escribe los caracteres de la imagen, o ábrela en el navegador y resuélvelo allí.',
        'The website asks for a security code. Type the characters in the image, or open it in the browser and solve it there.',
      ),
    ],
    qr_scan: [
      t('Escanear un QR', 'Scan a QR'),
      t(
        'Abre la app de ejemplo en tu móvil y escanea el código.',
        'Open the example app on your phone and scan the code.',
      ),
    ],
    phone_approval: [
      t('Confirmar en el móvil', 'Approve on your phone'),
      t(
        'Confirma la solicitud de ejemplo en tu móvil.',
        'Approve the example request on your phone.',
      ),
    ],
    manual_step: [
      t('Actuar en el navegador', 'Act in the browser'),
      t(
        'Revisa los datos de ejemplo en el navegador.',
        'Review the example details in the browser.',
      ),
    ],
    offline: [
      t('Ir a una oficina', 'Visit an office'),
      t(
        'Lleva tu documento de ejemplo a la oficina.',
        'Bring your example document to the office.',
      ),
    ],
  } as const;
  for (const [actionKind, [title, message]] of Object.entries(actions))
    addPrompt(
      `action-${actionKind}`,
      'actions',
      title,
      `api.user.requestAction({ kind: "${actionKind}" })`,
      {
        kind: 'user_action',
        actionKind: actionKind as keyof typeof actions,
        title,
        message,
        showBrowser: actionKind !== 'offline',
        imageId:
          actionKind === 'qr_scan' || actionKind === 'captcha' ? 'playground-image' : undefined,
      },
    );
  addPrompt('credential-clave', 'actions', 'Cl@ve Permanente', 'api.user.requestCredential()', {
    kind: 'credential',
    credential: 'clave_permanente',
    title: t('Añade tu Cl@ve Permanente', 'Add your Cl@ve Permanente'),
    message: t(
      'Para entrar en la sede de ejemplo necesito tu Cl@ve Permanente. Guárdala aquí: yo nunca veo la contraseña.',
      'To log in to the example site I need your Cl@ve Permanente. Save it here: I never see the password.',
    ),
  });
  addPrompt(
    'credential-clave-fix',
    'actions',
    'Cl@ve Permanente rechazada',
    'page.loginClave({ rejected: true })',
    {
      kind: 'credential',
      credential: 'clave_permanente',
      title: t('Revisa tu Cl@ve Permanente', 'Check your Cl@ve Permanente'),
      message: t(
        'Cl@ve no ha aceptado la contraseña guardada. Corrígela aquí y vuelvo a intentarlo: yo nunca veo la contraseña.',
        "Cl@ve didn't accept the saved password. Correct it here and I'll try again: I never see the password.",
      ),
      replaceId: 'cred-clave',
    },
  );
  addPrompt(
    'credential-dnie',
    'actions',
    'DNI',
    'api.user.requestCredential({ credential: "dnie" })',
    {
      kind: 'credential',
      credential: 'dnie',
      title: t('Añade tu DNI', 'Add your DNI'),
      message: t(
        'La sede de ejemplo pide certificado digital. Con tu DNI y el móvil puedo entrar por ti.',
        'The example site asks for a digital certificate. With your DNI and your phone I can log in for you.',
      ),
    },
  );
  addPrompt(
    'phone-call',
    'actions',
    t('Llamada', 'Phone call'),
    'api.user.phoneCall()',
    phoneCallExample(t),
  );
  addPrompt(
    'fill-from-user',
    'actions',
    t('Código de un solo uso', 'One-time code'),
    'page.fillFromUser()',
    // What main asks for page.fillFromUser: one secret, typed into the page by the app.
    {
      kind: 'form',
      title: t('Código de verificación', 'Verification code'),
      message: t(
        'La sede de ejemplo te ha enviado un SMS con un código. Escríbelo aquí y lo pondré en la web.',
        'The example site sent you a text message with a code. Type it here and I will enter it on the website.',
      ),
      fields: [
        {
          key: 'value',
          label: t('Código del SMS', 'Code from the text message'),
          type: 'secret',
          required: true,
        },
      ],
      allowDismiss: false,
    },
  );
  addPrompt('dnie-login', 'dnie', t('DNI · Acceso', 'DNI · Login'), 'page.useCertificate() · DNI', {
    kind: 'dnie_signature',
    purpose: 'login',
    title: t('Entrar con el DNI', 'Log in with your DNI'),
    message: t('Entrar con el DNI', 'Log in with your DNI'),
    details: [{ label: t('Web', 'Website'), value: 'sede.example.gob.es' }],
    stage: 'reviewing',
  });
  const dnieSignature = (stage: DnieSignatureStage, unlock?: DnieUnlock): Prompt => ({
    kind: 'dnie_signature',
    purpose: 'document',
    title: t('Firma con tu DNI', 'Sign with your DNI'),
    message: t(
      'La sede de ejemplo te pide firmar con tu DNI. Revisa la firma en el móvil y acerca el DNI al móvil.',
      'The example site asks you to sign with your DNI. Check the signature on your phone and hold the DNI to it.',
    ),
    details: [
      {
        label: t('Qué', 'What'),
        value: t('Firmar la solicitud de ejemplo (PDF).', 'Sign the example application (PDF).'),
      },
      { label: t('Para', 'For'), value: 'sede.example.gob.es' },
    ],
    stage,
    ...(unlock ? { unlock } : {}),
  });
  addPrompt(
    'dnie-unlock',
    'dnie',
    t('DNI · CAN y PIN', 'DNI · CAN and PIN'),
    'dnie_signature · unlock',
    dnieSignature('unlock', { can: true, pin: true }),
  );
  addPrompt(
    'dnie-unlock-wrong-pin',
    'dnie',
    t('DNI · PIN incorrecto', 'DNI · Wrong PIN'),
    'dnie_signature · unlock',
    dnieSignature('unlock', { can: false, pin: true, refused: 'pin', triesLeft: 2 }),
  );
  for (const stage of ['phone', 'reviewing', 'card', 'reading'] as const)
    addPrompt(
      `dnie-${stage}`,
      'dnie',
      `DNI · ${stage}`,
      `dnie_signature · ${stage}`,
      dnieSignature(stage),
    );
  const procedureStates = [
    ['procedure', t('Trámite', 'Procedure'), 'current'],
    ['procedure-researching', t('Investigando', 'Researching'), 'researching'],
    ['procedure-working', t('Un agente trabaja', 'An agent works'), 'working'],
    ['procedure-appointment', t('Con cita', 'With an appointment'), 'appointment'],
    [
      'procedure-waiting',
      t('Esperando a la administración', 'Waiting for the administration'),
      'waiting_admin',
    ],
    ['procedure-error', t('Con un problema', 'With a problem'), 'error'],
    ['procedure-done', t('Completado', 'Done'), 'done'],
  ] as const;
  for (const [id, label, procedureState] of procedureStates)
    examples.push({
      id,
      group: 'procedures',
      label,
      code: `ProcedureRow · ${procedureState}`,
      procedureId: 'p-dni',
      procedureState,
    });

  const agent = (
    id: string,
    status: string,
    activity: CodemodeAgentInfo['activity'],
    extra: Partial<CodemodeAgentInfo> = {},
  ): CodemodeAgentInfo => ({
    id,
    kind: 'agent',
    status,
    activity,
    procedures: [],
    createdAt: PLAYGROUND_TIME,
    updatedAt: PLAYGROUND_TIME,
    ...extra,
  });
  const reading = agent(
    'a-correos',
    t('Analizando la página de Correos…', 'Analysing the Correos page…'),
    'working',
    { since: PLAYGROUND_TIME },
  );
  const waiting = agent(
    'a-dni',
    t('Esperando tu respuesta sobre la cita…', 'Waiting for your answer about the appointment…'),
    'waiting_user',
  );
  const failed = agent(
    'a-padron',
    t('Pidiendo el volante de empadronamiento', 'Requesting the padrón certificate'),
    'idle',
    {
      error: t(
        'La sede del ayuntamiento no responde. Lo intento de nuevo en un rato.',
        'The town hall’s website is not answering. I will try again in a while.',
      ),
    },
  );
  const more = [
    agent(
      'a-hacienda',
      t('Leyendo tu borrador de la renta…', 'Reading your tax return draft…'),
      'working',
      { since: PLAYGROUND_TIME },
    ),
    agent(
      'a-dgt',
      t('Buscando el informe del vehículo…', 'Looking up the vehicle report…'),
      'working',
      { since: PLAYGROUND_TIME },
    ),
  ];
  const agentExamples = [
    ['agents-working', t('Trabajando', 'Working'), [reading]],
    ['agents-waiting', t('Esperando al usuario', 'Waiting for the user'), [waiting]],
    ['agents-error', t('Con un error', 'With an error'), [failed]],
    ['agents-many', t('Varios a la vez', 'Several at once'), [reading, waiting, failed, ...more]],
  ] as const;
  for (const [id, label, agents] of agentExamples)
    examples.push({ id, group: 'agents', label, code: 'AgentMeter', agents: [...agents] });

  examples.push({
    id: 'message',
    group: 'chat',
    label: t('Mensaje del asistente', 'Assistant message'),
    code: 'assistant',
    item: {
      id: 'playground-message',
      type: 'assistant',
      createdAt: PLAYGROUND_TIME,
      status: 'complete',
      text: t(
        'Me pongo con la renovación del DNI. Te preguntaré arriba lo que necesite mientras sigo trabajando.\n\n**Necesitas:**\n- Tu DNI actual.\n- Una foto reciente.\n\n| Paso | Quién |\n| --- | --- |\n| Pedir la cita | Asistente |\n| Ir a la comisaría | Tú |',
        'I am starting on the DNI renewal. I will ask you above whatever I need while I keep working.\n\n**You need:**\n- Your current DNI.\n- A recent photo.\n\n| Step | Who |\n| --- | --- |\n| Book the appointment | Assistant |\n| Go to the police station | You |',
      ),
    },
  });
  examples.push({
    id: 'message-documents',
    group: 'chat',
    label: t('Mensaje con documentos', 'Message with documents'),
    code: 'assistant · sa:document/<id>',
    item: {
      id: 'playground-message-documents',
      type: 'assistant',
      createdAt: PLAYGROUND_TIME,
      status: 'complete',
      text: t(
        '¡Hecho! Aquí tienes el justificante:\n\n[Justificante tasa DNI](sa:document/doc-tasa-dni)\n\nTambién guardé [la solicitud del certificado](sa:document/doc-fnmt). Este ya no está:\n\n[Documento borrado](sa:document/doc-borrado)',
        'Done! Here’s the receipt:\n\n[DNI fee receipt](sa:document/doc-tasa-dni)\n\nI also saved [the certificate request](sa:document/doc-fnmt). This one is gone:\n\n[Deleted document](sa:document/doc-borrado)',
      ),
    },
  });
  // The coordinator's tools, as the chat shows them (it never names agents).
  const coordinatorTools = [
    [
      'agent_start',
      t('Empieza un trabajo', 'Starts work'),
      { title: t('Renovar el DNI', 'Renew your DNI') },
    ],
    ['agent_message', t('Pasa información', 'Passes information on'), {}],
    ['agent_list', t('Repasa el trabajo', 'Reviews the work'), {}],
    ['agent_stop', t('Para un trabajo', 'Stops work'), {}],
  ] as const;
  for (const [tool, label, args] of coordinatorTools)
    examples.push({
      id: `event-${tool}`,
      group: 'chat',
      label,
      code: tool,
      item: {
        id: `playground-event-${tool}`,
        type: 'activity',
        createdAt: PLAYGROUND_TIME,
        tool,
        toolCallId: `demo-${tool}`,
        args: { ...args },
        status: 'done',
      },
    });
  for (const level of ['info', 'success', 'warning', 'error'] as const)
    examples.push({
      id: `notice-${level}`,
      group: 'chat',
      label: t(
        {
          info: 'Aviso informativo',
          success: 'Aviso de éxito',
          warning: 'Advertencia',
          error: 'Error',
        }[level],
        {
          info: 'Information notice',
          success: 'Success notice',
          warning: 'Warning',
          error: 'Error',
        }[level],
      ),
      code: level,
      item: {
        id: `playground-notice-${level}`,
        type: 'notice',
        createdAt: PLAYGROUND_TIME,
        level,
        text: t(
          'Este es un aviso de ejemplo del asistente.',
          'This is an example notice from the assistant.',
        ),
      },
    });
  examples.push({
    id: 'failure',
    group: 'chat',
    label: t('Fallo de una tarea', 'Task failure'),
    code: 'activity.error',
  });
  return examples;
}

/** The host-owned questions, registered with the mock API as conversation items. */
export function examplePromptItems(language: Language): PromptItem[] {
  return playgroundExamples(language).flatMap((example) =>
    example.item?.type === 'prompt' ? [example.item] : [],
  );
}

/** The procedure card's next action once the cita is booked (playground state "appointment"). */
export function appointmentExample(t: (es: string, en: string) => string): NextAction {
  return {
    text: t(
      'Acudir a la cita con tu DNI actual y la foto',
      'Go to the appointment with your current DNI and the photo',
    ),
    owner: 'user',
    appointment: {
      address: 'Comisaría de Madrid – Retiro, Calle Rafael Calvo 33, 28010 Madrid',
      startsAt: '2026-10-13T10:20',
    },
  };
}

/** A phone call the agent asks for (?phone=1, playground): the water company, about residents. */
export function phoneCallExample(t: (es: string, en: string) => string): PhoneCallPrompt {
  return {
    kind: 'phone_call',
    title: t('Llama a EMASESA', 'Call EMASESA'),
    organization: t('EMASESA · Atención al cliente', 'EMASESA · Customer service'),
    phoneNumber: '900 822 010',
    hours: t('Lunes a viernes, de 8:00 a 20:00', 'Monday to Friday, 8:00 to 20:00'),
    purpose: t(
      'La web de EMASESA no deja cambiar el número de personas que viven en la casa si el contrato no está a tu nombre. Pregúntales cómo hacerlo siendo inquilino.',
      'EMASESA’s website doesn’t let you change how many people live in the home if the contract isn’t in your name. Ask them how to do it as a tenant.',
    ),
    questions: [
      t(
        '¿Puedo pedir el cambio yo, como inquilino, si el contrato está a nombre de la casera?',
        'Can I ask for the change myself, as a tenant, if the contract is in the landlady’s name?',
      ),
      t(
        '¿Qué papeles hacen falta? ¿Vale el volante de empadronamiento?',
        'Which papers are needed? Is the padrón certificate enough?',
      ),
      t(
        '¿Dónde se envían: web, correo o en una oficina?',
        'Where do I send them: website, email or an office?',
      ),
      t('¿Cuánto tarda en aplicarse en la factura?', 'How long until it shows on the bill?'),
    ],
    haveAtHand: [
      t('Número de contrato (arriba en la factura)', 'Contract number (top of the bill)'),
      t('Dirección completa de la casa', 'Full address of the home'),
      t('Cuántas personas viven en la casa', 'How many people live in the home'),
    ],
    openingScript:
      'Hola, buenos días. Soy inquilino de una vivienda con contrato a nombre de la propietaria y quiero actualizar el número de personas que vivimos en ella.',
  };
}
