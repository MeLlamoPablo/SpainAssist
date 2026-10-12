import type { Language } from '@sa/shared';

/**
 * User-facing copy produced by the main process (notices, app-raised prompts, errors shown in
 * the UI). Plain words, short sentences, "tú" form. Model-facing text stays in English.
 */
const STRINGS = {
  newProcedure: { es: 'Nuevo trámite', en: 'New procedure' },

  // --- notices --------------------------------------------------------------------------------
  savedToVault: { es: 'Guardado en Mis datos: {labels}.', en: 'Saved to My data: {labels}.' },
  downloadSaved: {
    es: 'Descargado y guardado en Mis datos: {name}',
    en: 'Downloaded and saved to My data: {name}',
  },
  feedbackShared: {
    es: 'Has compartido este aprendizaje con la comunidad, sin datos personales:',
    en: 'You shared this learning with the community, without personal data:',
  },
  feedbackProcedure: { es: 'Trámite', en: 'Procedure' },
  feedbackAdministration: { es: 'Organismo', en: 'Administration' },
  feedbackRegion: { es: 'Zona', en: 'Region' },
  feedbackLinks: { es: 'Enlaces', en: 'Links' },
  feedbackTags: { es: 'Etiquetas', en: 'Tags' },
  cancelled: { es: 'Cancelado', en: 'Cancelled' },

  // --- agent errors -----------------------------------------------------------------------------
  agentErrorAuth: {
    es: 'Tu proveedor de IA ha rechazado la clave. Revísala en Ajustes o vuelve a iniciar sesión.',
    en: 'Your AI provider rejected the key. Check it in Settings or sign in again.',
  },
  agentErrorCredit: {
    es: 'Se ha acabado el saldo de tu bono. Canjea otro bono o elige otro proveedor en Ajustes.',
    en: 'Your voucher credit has run out. Redeem another voucher or choose another provider in Settings.',
  },
  agentErrorRateLimit: {
    es: 'Has llegado al límite de uso de tu proveedor de IA. Espera un poco y vuelve a intentarlo.',
    en: "You've reached your AI provider's usage limit. Wait a bit and try again.",
  },
  agentErrorNetwork: {
    es: 'No hay conexión a internet.',
    en: 'No internet connection.',
  },
  agentErrorTimeout: {
    es: 'El proveedor de IA tarda demasiado en responder. Vuelve a intentarlo.',
    en: 'The AI provider took too long to respond. Try again.',
  },
  agentErrorUnavailable: {
    es: 'El proveedor de IA no está disponible ahora. Vuelve a intentarlo más tarde.',
    en: 'The AI provider is unavailable. Try again later.',
  },
  agentErrorContext: {
    es: 'La conversación es demasiado larga para este modelo. Elige otro modelo en Ajustes.',
    en: 'The conversation is too long for this model. Choose another model in Settings.',
  },
  agentErrorNoProvider: {
    es: 'Antes de empezar, elige cómo conectar la IA en Ajustes.',
    en: 'Before starting, choose how to connect the AI in Settings.',
  },
  agentErrorGeneric: {
    es: 'No se ha podido completar la respuesta. Vuelve a intentarlo.',
    en: 'Could not complete the response. Try again.',
  },
  agentCrashed: {
    es: 'El asistente se ha detenido de forma inesperada. Escribe de nuevo para continuar.',
    en: 'The assistant stopped unexpectedly. Send a message to continue.',
  },
  agentStartFailed: {
    es: 'No se ha podido iniciar el asistente: {message}',
    en: "Couldn't start the assistant: {message}",
  },

  // --- credential / certificate / signature prompts ------------------------------------------
  credentialTitle: { es: '¿Usar tu Cl@ve?', en: 'Use your Cl@ve?' },
  credentialMessage: {
    es: 'El asistente quiere escribir tu {field} de Cl@ve en {host}.',
    en: 'The assistant wants to type your Cl@ve {field} on {host}.',
  },
  fieldUsername: { es: 'usuario', en: 'username' },
  fieldPassword: { es: 'contraseña', en: 'password' },
  certificateTitle: { es: '¿Usar tu certificado digital?', en: 'Use your digital certificate?' },
  certificateMessage: {
    es: 'El asistente quiere identificarte con tu certificado digital en las webs oficiales de este trámite.',
    en: 'The assistant wants to identify you with your digital certificate on the official websites for this procedure.',
  },
  detailCredential: { es: 'Credencial', en: 'Credential' },
  detailWebsite: { es: 'Web', en: 'Website' },
  detailWebsites: { es: 'Webs', en: 'Websites' },
  detailCertificate: { es: 'Certificado', en: 'Certificate' },
  useLabel: { es: 'Usar', en: 'Use' },
  dontUseLabel: { es: 'No usar', en: "Don't use" },
  signatureTitle: { es: '¿Firmar este documento?', en: 'Sign this document?' },
  signatureMessage: {
    es: '{host} te pide firmar con tu certificado digital. La firma tiene validez legal: comprueba que es lo que esperas.',
    en: '{host} asks you to sign with your digital certificate. A signature is legally binding: check it is what you expect.',
  },
  detailWhat: { es: 'Qué', en: 'What' },
  detailFor: { es: 'Para', en: 'For' },
  detailFormat: { es: 'Formato', en: 'Format' },
  detailSize: { es: 'Tamaño', en: 'Size' },
  detailHash: { es: 'Huella (SHA-256)', en: 'Fingerprint (SHA-256)' },
  signLabel: { es: 'Firmar', en: 'Sign' },
  dontSignLabel: { es: 'No firmar', en: "Don't sign" },
  pickCertificateTitle: {
    es: '¿Con qué certificado quieres firmar?',
    en: 'Which certificate do you want to sign with?',
  },
  continueLabel: { es: 'Continuar', en: 'Continue' },
  noCertificate: {
    es: '{host} te pide firmar, pero no tienes ningún certificado digital guardado. Añade un certificado o tu DNIe en Mis datos.',
    en: '{host} asks you to sign, but you have no digital certificate saved. Add a certificate or your DNIe in My data.',
  },
  /** Without the `dnie-phone` feature flag. */
  noCertificateOnly: {
    es: '{host} te pide firmar, pero no tienes ningún certificado digital guardado. Añádelo en Mis datos.',
    en: '{host} asks you to sign, but you have no digital certificate saved. Add it in My data.',
  },
  fillFromUserNote: {
    es: 'Lo escribiremos directamente en {host}. El asistente no verá lo que escribas.',
    en: "We'll type it straight into {host}. The assistant won't see it.",
  },
  touchIdClave: { es: 'usar tu Cl@ve', en: 'use your Cl@ve' },
  touchIdCertificate: { es: 'usar tu certificado digital', en: 'use your digital certificate' },
  touchIdSignature: { es: 'firmar un documento', en: 'sign a document' },

  // --- DNIe in the phone ---------------------------------------------------------------------
  dnieOption: { es: 'DNIe con el móvil', en: 'DNIe with your phone' },
  dnieOptionHolder: {
    es: 'DNIe de {holder} (con el móvil)',
    en: "{holder}'s DNIe (with your phone)",
  },
  dnieLoginTitle: { es: 'Entrar con el DNIe', en: 'Log in with your DNIe' },
  dnieLoginMessage: {
    es: 'Aprueba entrar en {host} en tu móvil y mantén el DNIe cerca. Puedes cancelar aquí.',
    en: 'Approve login to {host} on your phone and keep your DNIe nearby. You can cancel here.',
  },
  dnieSignatureTitle: { es: 'Firma con tu DNIe', en: 'Sign with your DNIe' },
  dnieSignatureMessage: {
    es: '{host} te pide firmar con tu DNIe. Revisa la firma en el móvil y acerca el DNIe al móvil.',
    en: '{host} asks you to sign with your DNIe. Check the signature on your phone and hold the DNIe to it.',
  },
  dnieCertificateMessage: {
    es: '{host} quiere saber con qué certificado firmarás. Sigue en el móvil: no se firma nada todavía.',
    en: '{host} wants to know which certificate you will sign with. Carry on on your phone: nothing is signed yet.',
  },
  /** IPC calls for the DNIe without the `dnie-phone` feature flag. */
  dniePhoneOff: {
    es: 'El DNIe con el móvil no está disponible en esta versión de la app.',
    en: "DNIe with your phone isn't available in this version of the app.",
  },
  /** `companion.unlock` without what the prompt asks for. */
  dnieUnlockMissing: {
    es: 'Escribe el número CAN (6 números) y el PIN del DNIe (de 8 a 16 caracteres).',
    en: 'Type the CAN (6 digits) and the DNIe PIN (8 to 16 characters).',
  },
  dnieUnavailable: {
    es: 'No se puede usar el DNIe con el móvil ahora mismo. Inténtalo más tarde o usa un certificado digital.',
    en: "Using your DNIe with your phone isn't available right now. Try again later or use a digital certificate.",
  },
  dnieError_pin_blocked: {
    es: 'El PIN de tu DNIe está bloqueado. Para desbloquearlo, ve a un punto de actualización del DNI en una comisaría.',
    en: 'Your DNIe PIN is blocked. To unblock it, use a DNI update point at a police station.',
  },
  dnieError_card_unsupported: {
    es: 'El móvil no ha reconocido la tarjeta como un DNIe 3.0 o 4.0.',
    en: "The phone didn't recognise the card as a DNIe 3.0 or 4.0.",
  },
  dnieError_no_certificate: {
    es: 'Tu DNIe no tiene el certificado que necesita esta petición. Puedes activarlo en un punto de actualización del DNI en una comisaría.',
    en: 'Your DNIe does not have the certificate this request needs. You can activate it at a DNI update point at a police station.',
  },
  dnieError_certificate_expired: {
    es: 'El certificado de tu DNIe ha caducado. Puedes renovarlo en un punto de actualización del DNI en una comisaría.',
    en: 'Your DNIe certificate has expired. You can renew it at a DNI update point at a police station.',
  },
  dnieError_wrong_card: {
    es: 'Has acercado otro DNIe distinto al del principio. Vuelve a intentarlo con el mismo.',
    en: 'You held a different DNIe than at the start. Try again with the same one.',
  },
  dnieError_binding_mismatch: {
    es: 'El móvil no ha firmado porque lo que le llegó no coincide con el documento. No se ha firmado nada.',
    en: "The phone didn't sign because what it got doesn't match the document. Nothing was signed.",
  },
  dnieError_nfc_unavailable: {
    es: 'El móvil no tiene NFC o está desactivado. Actívalo en los ajustes del móvil y vuelve a intentarlo.',
    en: 'The phone has no NFC or it is off. Turn it on in the phone settings and try again.',
  },
  dnieError_timeout: {
    es: 'La firma con el DNIe ha tardado demasiado. Vuelve a intentarlo.',
    en: 'Signing with your DNIe took too long. Try again.',
  },
  dnieError_busy: {
    es: 'El móvil ya está firmando otra cosa. Termina esa firma y vuelve a intentarlo.',
    en: 'The phone is already signing something else. Finish that and try again.',
  },
  dnieError_unpaired: {
    es: 'Se ha desvinculado el móvil. Vuelve a escanear el código para firmar con el DNIe.',
    en: 'The phone was unpaired. Scan the code again to sign with your DNIe.',
  },
  dnieError_expired: {
    es: 'La vinculación con el móvil ha caducado. Vuelve a escanear el código para firmar con el DNIe.',
    en: 'The phone pairing expired. Scan the code again to sign with your DNIe.',
  },
  dnieError_failed: {
    es: 'No se ha podido usar el DNIe. Vuelve a intentarlo.',
    en: "Couldn't use your DNIe. Try again.",
  },

  // --- providers ----------------------------------------------------------------------------
  providerVoucher: { es: 'Bono Spain Assist', en: 'Spain Assist voucher' },
  providerByok: { es: '{name} (clave propia)', en: '{name} (own key)' },
  providerCustom: { es: 'Servidor propio ({host})', en: 'Custom server ({host})' },
  secretChatgpt: { es: 'Sesión de ChatGPT', en: 'ChatGPT session' },
  providerCodex: { es: 'ChatGPT vía Codex (desarrollo)', en: 'ChatGPT via Codex (development)' },
  secretCodex: { es: 'Sesión de Codex (desarrollo)', en: 'Codex session (development)' },
  loginCodexCode: {
    es: 'Abre la página de OpenAI y escribe este código.',
    en: 'Open the OpenAI page and type this code.',
  },
  loginCodexUnavailable: {
    es: 'El inicio de sesión de Codex solo está disponible en la versión de desarrollo.',
    en: 'Codex sign-in is only available in the development build.',
  },
  secretVoucher: { es: 'Clave del bono', en: 'Voucher key' },
  secretByok: { es: 'Clave de {name}', en: '{name} key' },
  secretCustom: { es: 'Clave del servidor propio', en: 'Custom server key' },
  secretSearchToken: { es: 'Token de búsqueda', en: 'Search token' },
  loginOpenBrowser: {
    es: 'Continúa en tu navegador para iniciar sesión con ChatGPT.',
    en: 'Continue in your browser to sign in with ChatGPT.',
  },
  loginWaitingBrowser: {
    es: 'Esperando a que termines en el navegador…',
    en: 'Waiting for you to finish in the browser…',
  },
  loginExchanging: { es: 'Terminando de conectar…', en: 'Finishing the connection…' },
  loginInProgress: {
    es: 'Ya hay un inicio de sesión en marcha.',
    en: 'A sign-in is already in progress.',
  },
  loginCancelled: { es: 'Has cancelado el inicio de sesión.', en: 'Sign-in cancelled.' },
  loginFailed: {
    es: 'No se ha podido iniciar sesión: {message}',
    en: "Couldn't sign in: {message}",
  },
  loginChatgptNotEligible: {
    es: 'Spain Assist solo puede conectar la IA de ChatGPT en los planes Plus o superiores.',
    en: 'Spain Assist can only connect ChatGPT on Plus plans or higher.',
  },
  voucherInvalid: {
    es: 'Ese código no es válido. Revisa que esté bien escrito.',
    en: "That code isn't valid. Check it's typed correctly.",
  },
  voucherUsed: { es: 'Ese código ya se ha usado.', en: 'That code has already been used.' },
  voucherExpired: { es: 'Ese código ha caducado.', en: 'That code has expired.' },
  voucherRevoked: { es: 'Ese código ya no es válido.', en: 'That code is no longer valid.' },
  voucherRateLimited: {
    es: 'Demasiados intentos. Espera un momento y vuelve a probar.',
    en: 'Too many attempts. Wait a moment and try again.',
  },
  voucherFailed: {
    es: 'No se ha podido canjear el código ahora mismo. Inténtalo más tarde.',
    en: "Couldn't redeem the code right now. Try again later.",
  },
  voucherNetwork: {
    es: 'No hay conexión con el servidor de bonos. Revisa tu conexión.',
    en: "Can't reach the voucher server. Check your connection.",
  },
  providerSaveFailed: {
    es: 'No se ha podido guardar la configuración: {message}',
    en: "Couldn't save the configuration: {message}",
  },

  // --- vault / generic errors ----------------------------------------------------------------
  vaultInvalidPassphrase: {
    es: 'La contraseña del certificado no es correcta.',
    en: 'The certificate password is wrong.',
  },
  vaultInvalidCertificate: {
    es: 'Ese archivo no es un certificado válido (.p12 o .pfx).',
    en: "That file isn't a valid certificate (.p12 or .pfx).",
  },
  vaultExpiredCertificate: {
    es: 'Ese certificado ha caducado.',
    en: 'That certificate has expired.',
  },
  vaultNotFound: { es: 'No se ha encontrado.', en: 'Not found.' },
  vaultCorrupted: {
    es: 'Los datos guardados están dañados.',
    en: 'The stored data is damaged.',
  },
  vaultInvalidInput: { es: 'Hay datos que no son válidos.', en: "Some data isn't valid." },
  procedureNotFound: { es: 'Ese trámite ya no existe.', en: 'That procedure no longer exists.' },
  promptNotPending: {
    es: 'Esa pregunta ya no está activa.',
    en: 'That question is no longer active.',
  },
  emptyMessage: { es: 'Escribe un mensaje.', en: 'Write a message.' },
  invalidRequest: { es: 'La petición no es válida.', en: 'Invalid request.' },
  onlyHttps: {
    es: 'Solo se pueden abrir enlaces seguros (https).',
    en: 'Only secure (https) links can be opened.',
  },
  transcriptionUnavailable: {
    es: 'Con tu forma de conexión a la IA no puedo transcribir llamadas. Escribe lo que te dijeron.',
    en: 'I can’t transcribe calls with the way you connect to the AI. Write down what they told you.',
  },
  transcriptionBudget: {
    es: 'No queda saldo para transcribir la llamada. Escribe lo que te dijeron.',
    en: 'There’s no credit left to transcribe the call. Write down what they told you.',
  },
  transcriptionFailed: {
    es: 'No he podido transcribir la grabación. Vuelve a intentarlo o escribe lo que te dijeron.',
    en: 'I couldn’t transcribe the recording. Try again or write down what they told you.',
  },
  badRecording: {
    es: 'La grabación no es válida o es demasiado larga.',
    en: 'The recording is not valid or is too long.',
  },
  exportTooLarge: {
    es: 'El historial es demasiado grande para un solo archivo .zip (más de 4 GB).',
    en: 'Your history is too large for a single .zip file (over 4 GB).',
  },
} as const satisfies Record<string, { es: string; en: string }>;

export type StringKey = keyof typeof STRINGS;

export function t(lang: Language, key: StringKey, vars: Record<string, string> = {}): string {
  const template: string = STRINGS[key][lang] ?? STRINGS[key].es;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`);
}
