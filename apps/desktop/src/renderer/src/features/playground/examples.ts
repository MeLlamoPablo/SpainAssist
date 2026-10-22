import type {
  ChatItem,
  DnieSignatureStage,
  DnieUnlock,
  FormField,
  Language,
  NextAction,
  PhoneCallPrompt,
  Prompt,
  PromptItem,
} from '@sa/shared';

export type ExampleGroup = 'inputs' | 'confirmations' | 'actions' | 'output';
export interface PlaygroundExample {
  id: string;
  group: ExampleGroup;
  label: string;
  code: string;
  item?: ChatItem;
  procedureId?: string;
  /** Starting value of the procedure card's state picker. */
  procedureState?: string;
}
const PLAYGROUND_TIME = '2026-10-04T10:00:00.000Z';

/** Mock-only catalogue. Each interactive example is also registered with the mock API. */
export function playgroundExamples(language: Language): PlaygroundExample[] {
  const t = (es: string, en: string) => (language === 'es' ? es : en);
  const examples: PlaygroundExample[] = [];
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
  const addField = (id: string, label: string, field: FormField) =>
    addPrompt(id, 'inputs', label, field.type, {
      kind: 'form',
      title: label,
      message: t('Prueba este campo con datos de ejemplo.', 'Try this field with example data.'),
      fields: [field],
      allowDismiss: false,
      submitLabel: t('Continuar', 'Continue'),
    });
  const field = (
    type: FormField['type'],
    label: string,
    extra: Partial<FormField> = {},
  ): FormField => ({ key: 'answer', type, label, required: true, ...extra });
  addField(
    'text',
    t('Texto corto', 'Short text'),
    field('text', t('Nombre', 'Name'), {
      placeholder: t('Por ejemplo: Lucía', 'For example: Alex'),
      vaultKey: 'givenName',
      defaultValue: '',
    }),
  );
  addPrompt('document-scan', 'inputs', t('Escanear documento', 'Scan document'), 'form · scan', {
    kind: 'form',
    title: t('Tus datos para el trámite', 'Your details for the procedure'),
    message: t(
      'Escanea un documento o escribe tus datos. Puedes revisar y cambiar los campos antes de continuar.',
      'Scan a document or enter your details. You can review and change the fields before continuing.',
    ),
    allowDismiss: false,
    submitLabel: t('Continuar', 'Continue'),
    fields: [
      field('text', t('Nombre', 'First name'), {
        key: 'givenName',
        vaultKey: 'givenName',
        defaultValue: '',
      }),
      field('text', t('Primer apellido', 'First surname'), {
        key: 'surname1',
        vaultKey: 'surname1',
        defaultValue: '',
      }),
      field('date', t('Fecha de nacimiento', 'Date of birth'), {
        key: 'birthDate',
        vaultKey: 'birthDate',
        defaultValue: '',
      }),
      field('text', t('Número de DNI', 'DNI number'), {
        key: 'dniNumber',
        vaultKey: 'dniNumber',
        defaultValue: '',
      }),
      field('province', t('Provincia', 'Province'), {
        key: 'addressProvince',
        vaultKey: 'addressProvince',
        defaultValue: '',
      }),
      field('email', t('Correo electrónico', 'Email'), {
        key: 'email',
        vaultKey: 'email',
        defaultValue: 'demo@example.com',
      }),
    ],
  });
  addField(
    'passport-scan',
    t('Escanear Pasaporte', 'Scan passport'),
    field('text', t('Número de pasaporte', 'Passport number'), {
      vaultKey: 'passportNumber',
      defaultValue: '',
    }),
  );
  addField(
    'driving-licence-scan',
    t('Escanear Permiso de conducir', 'Scan driving licence'),
    field('date', t('Validez del permiso de conducir', 'Driving licence expiry'), {
      vaultKey: 'drivingLicenceExpiry',
      defaultValue: '',
    }),
  );
  addField(
    'textarea',
    t('Texto largo', 'Long text'),
    field('textarea', t('¿Qué necesitas?', 'What do you need?'), {
      help: t('Cuéntalo con tus palabras.', 'Tell us in your own words.'),
    }),
  );
  addField(
    'number',
    t('Número', 'Number'),
    field('number', t('Importe (€)', 'Amount (€)'), { placeholder: '12,50' }),
  );
  addField('date', t('Fecha', 'Date'), field('date', t('A partir de', 'From')));
  addField(
    'email',
    t('Correo electrónico', 'Email'),
    field('email', t('Correo electrónico', 'Email'), { placeholder: 'demo@example.com' }),
  );
  addField(
    'phone',
    t('Teléfono', 'Phone'),
    field('phone', t('Teléfono', 'Phone'), { placeholder: '+34 600 000 000' }),
  );
  const shortOptions = [
    { value: 'morning', label: t('Mañana', 'Morning') },
    { value: 'afternoon', label: t('Tarde', 'Afternoon') },
  ];
  addField(
    'select',
    t('Elegir · botones', 'Choice · buttons'),
    field('select', t('Horario', 'Time'), { options: shortOptions }),
  );
  const options = ['north', 'south', 'east', 'west'].map((value, i) => ({
    value,
    label: t(`Oficina de ejemplo ${i + 1}`, `Example office ${i + 1}`),
  }));
  addField(
    'select-dropdown',
    t('Elegir · desplegable', 'Choice · dropdown'),
    field('select', t('Oficina', 'Office'), { options }),
  );
  addField(
    'multiselect',
    t('Elegir varias', 'Multiple choices'),
    field('multiselect', t('Días disponibles', 'Available days'), {
      options: ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'].map((es, i) => ({
        value: String(i),
        label: t(es, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][i]),
      })),
    }),
  );
  addField(
    'boolean',
    t('Sí / No', 'Yes / No'),
    field('boolean', t('¿Tienes cita?', 'Do you have an appointment?')),
  );
  addField(
    'boolean-checkbox',
    t('Casilla', 'Checkbox'),
    field('boolean', t('Quiero recibir avisos', 'Send me updates'), {
      help: t('Puedes cambiarlo después.', 'You can change this later.'),
    }),
  );
  addField('province', t('Provincia', 'Province'), field('province', t('Provincia', 'Province')));
  addField(
    'document',
    t('Documento', 'Document'),
    field('document', t('Documento que vas a aportar', 'Document to provide')),
  );
  addField(
    'secret',
    t('Código oculto', 'Masked code'),
    field('secret', t('Código de un solo uso', 'One-time code'), {
      placeholder: '000000',
      help: t('Usa un código inventado.', 'Use an invented code.'),
    }),
  );
  addField(
    'map-options',
    t('Lugares en el mapa', 'Places on a map'),
    field('map-options', t('Centro preferido', 'Preferred centre'), {
      options: [
        {
          value: 'north',
          label: t('Centro Norte (demo)', 'North centre (demo)'),
          address: 'Calle de ejemplo 20, Sevilla',
        },
        {
          value: 'south',
          label: t('Centro Sur (demo)', 'South centre (demo)'),
          address: 'Avenida de ejemplo 1, Sevilla',
        },
        {
          value: 'east',
          label: t('Centro Este (demo)', 'East centre (demo)'),
          address: 'Plaza de ejemplo 3, Sevilla',
        },
      ],
    }),
  );
  addField(
    'appointment',
    t('Cita previa', 'Appointment'),
    field(
      'appointment',
      t('Cita en la oficina de expedición (demo)', 'Appointment at the issuing office (demo)'),
      {
        slots: [
          '2026-10-06T09:00',
          '2026-10-06T09:20',
          '2026-10-06T12:40',
          '2026-10-07T10:00',
          '2026-10-09T08:40',
          '2026-10-09T09:00',
          '2026-10-09T13:20',
          '2026-10-13T11:00',
          '2026-10-14T09:40',
          '2026-10-14T10:00',
          '2026-10-16T12:00',
          '2026-10-20T08:30',
          '2026-10-20T19:00',
          '2026-10-22T19:00',
        ],
      },
    ),
  );
  addField(
    'optional',
    t('Campo opcional', 'Optional field'),
    field('text', t('Referencia (si la tienes)', 'Reference (if you have one)'), {
      required: false,
    }),
  );
  addField(
    'prefilled',
    t('Dato guardado', 'Saved data'),
    field('email', t('Correo electrónico', 'Email'), { vaultKey: 'email' }),
  );
  addPrompt(
    'conditional',
    'inputs',
    t('Formulario con condiciones', 'Conditional form'),
    'visibleWhen',
    {
      kind: 'form',
      title: t('¿Cómo quieres recibir el aviso?', 'How would you like the update?'),
      allowDismiss: false,
      fields: [
        field('select', t('Canal', 'Channel'), {
          key: 'channel',
          options: [
            { value: 'email', label: 'Email' },
            { value: 'sms', label: 'SMS' },
          ],
        }),
        field('email', t('Correo electrónico', 'Email'), {
          key: 'email',
          visibleWhen: { field: 'channel', values: ['email'] },
        }),
        field('phone', t('Teléfono móvil', 'Mobile phone'), {
          key: 'phone',
          visibleWhen: { field: 'channel', values: ['sms'] },
        }),
      ],
    },
  );
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
    addPrompt(`confirm-${confirmKind}`, 'confirmations', title, confirmKind, {
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
    });
  addPrompt(
    'confirm-certificate_site',
    'confirmations',
    t('Web nueva para el certificado', 'New website for the certificate'),
    'certificate_site',
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
    'confirmations',
    t('Acción irreversible', 'Irreversible action'),
    'danger',
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
        'Completa el captcha en la ventana del navegador.',
        'Complete the captcha in the browser window.',
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
    addPrompt(`action-${actionKind}`, 'actions', title, actionKind, {
      kind: 'user_action',
      actionKind: actionKind as keyof typeof actions,
      title,
      message,
      showBrowser: actionKind !== 'offline',
      imageId:
        actionKind === 'qr_scan' || actionKind === 'captcha' ? 'playground-image' : undefined,
    });
  addPrompt('credential-clave', 'actions', 'Cl@ve Permanente', 'credential', {
    kind: 'credential',
    credential: 'clave_permanente',
    title: t('Añade tu Cl@ve Permanente', 'Add your Cl@ve Permanente'),
    message: t(
      'Para entrar en la sede de ejemplo necesito tu Cl@ve Permanente. Guárdala aquí: yo nunca veo la contraseña.',
      'To log in to the example site I need your Cl@ve Permanente. Save it here: I never see the password.',
    ),
  });
  addPrompt('credential-clave-fix', 'actions', 'Cl@ve Permanente rechazada', 'credential', {
    kind: 'credential',
    credential: 'clave_permanente',
    title: t('Revisa tu Cl@ve Permanente', 'Check your Cl@ve Permanente'),
    message: t(
      'Cl@ve no ha aceptado la contraseña guardada. Corrígela aquí y vuelvo a intentarlo: yo nunca veo la contraseña.',
      "Cl@ve didn't accept the saved password. Correct it here and I'll try again: I never see the password.",
    ),
    replaceId: 'cred-clave',
  });
  addPrompt('credential-dnie', 'actions', 'DNI', 'credential', {
    kind: 'credential',
    credential: 'dnie',
    title: t('Añade tu DNI', 'Add your DNI'),
    message: t(
      'La sede de ejemplo pide certificado digital. Con tu DNI y el móvil puedo entrar por ti.',
      'The example site asks for a digital certificate. With your DNI and your phone I can log in for you.',
    ),
  });
  addPrompt('phone-call', 'actions', 'Phone call', 'phone_call', phoneCallExample(t));
  addPrompt('dnie-login', 'confirmations', t('DNI · Acceso', 'DNI · Login'), 'dnie_signature', {
    kind: 'dnie_signature',
    purpose: 'login',
    title: t('Entrar con el DNI', 'Log in with your DNI'),
    message: t(
      'Aprueba entrar en la sede en tu móvil y mantén el DNI cerca. Puedes cancelar aquí.',
      'Approve login to the site on your phone and keep your DNI nearby. You can cancel here.',
    ),
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
    'confirmations',
    t('DNI · CAN y PIN', 'DNI · CAN and PIN'),
    'dnie_signature',
    dnieSignature('unlock', { can: true, pin: true }),
  );
  addPrompt(
    'dnie-unlock-wrong-pin',
    'confirmations',
    t('DNI · PIN incorrecto', 'DNI · Wrong PIN'),
    'dnie_signature',
    dnieSignature('unlock', { can: false, pin: true, refused: 'pin', triesLeft: 2 }),
  );
  for (const stage of ['phone', 'reviewing', 'card', 'reading'] as const)
    addPrompt(
      `dnie-${stage}`,
      'confirmations',
      `DNI · ${stage}`,
      'dnie_signature',
      dnieSignature(stage),
    );
  examples.push({
    id: 'message',
    group: 'output',
    label: t('Mensaje del asistente', 'Assistant message'),
    code: 'assistant',
    item: {
      id: 'playground-message',
      type: 'assistant',
      createdAt: PLAYGROUND_TIME,
      status: 'complete',
      text: t(
        'Ya está listo el plan.\n\n**Necesitas:**\n- Tu documento de identidad.\n- El justificante de ejemplo.\n\n| Paso | Quién |\n| --- | --- |\n| Revisar los datos | Tú |\n| Preparar la solicitud | Asistente |\n\n> Puedes volver a este trámite cuando quieras.',
        'The plan is ready.\n\n**You need:**\n- Your identity document.\n- The example receipt.\n\n| Step | Who |\n| --- | --- |\n| Review the details | You |\n| Prepare the application | Assistant |\n\n> You can return to this procedure whenever you like.',
      ),
    },
  });
  examples.push({
    id: 'message-documents',
    group: 'output',
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
  for (const level of ['info', 'success', 'warning', 'error'] as const)
    examples.push({
      id: `notice-${level}`,
      group: 'output',
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
    id: 'event',
    group: 'output',
    label: t('Novedades de un trámite', 'Procedure update'),
    code: 'activity',
    item: {
      id: 'playground-event',
      type: 'activity',
      createdAt: PLAYGROUND_TIME,
      tool: 'procedure_start',
      toolCallId: 'demo-call',
      args: { procedureId: 'p-dni', title: t('Renovar el DNI', 'Renew your DNI') },
      status: 'done',
    },
  });
  examples.push({
    id: 'failure',
    group: 'output',
    label: t('Fallo de una tarea', 'Task failure'),
    code: 'activity.error',
  });
  examples.push({
    id: 'procedure',
    group: 'output',
    label: t('Tarjeta de trámite', 'Procedure card'),
    code: 'procedure',
    procedureId: 'p-dni',
  });
  examples.push({
    id: 'procedure-appointment',
    group: 'output',
    label: t('Tarjeta de trámite con cita', 'Procedure card with an appointment'),
    code: 'procedure · nextAction.appointment',
    procedureId: 'p-dni',
    procedureState: 'appointment',
  });
  return examples;
}

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
