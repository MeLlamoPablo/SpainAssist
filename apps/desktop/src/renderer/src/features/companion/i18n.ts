import { defineDict } from '../../i18n';

/** The phone app for DNIe signatures (pairing, progress). */
export const companionDict = defineDict({
  es: {
    app: 'Spain Assist',
    scanTitle: 'Escanea este código con el móvil',
    scanBody:
      'Abre la app Spain Assist en el móvil y escanea el código. También puedes escanearlo con la cámara del móvil.',
    getApp:
      '¿No tienes la app? Búscala en Google Play como «Spain Assist». Necesitas un móvil Android con NFC.',
    qrLabel: 'Código para vincular el móvil',
    connecting: 'Conectando…',
    unavailable: 'Ahora mismo no se puede usar el móvil para firmar. Inténtalo más tarde.',
    away: (device: string) => `${device} no está conectado. Abre la app Spain Assist en el móvil.`,
    rescan: 'Si no se conecta, escanea otra vez el código.',
    connected: (device: string) => `Conectado con ${device}`,
    stage: {
      unlock: 'Escribe los datos de tu DNIe',
      phone: 'Mira tu móvil',
      reviewing: 'Revisa la firma en el móvil',
      card: 'Acerca el DNIe a la parte de atrás del móvil',
      reading: 'Leyendo el DNIe…',
      signing: 'Firmando…',
    },
    stageHint: {
      unlock: 'Los necesita el móvil para leer tu DNIe.',
      phone: 'La petición de firma está llegando a la app.',
      reviewing: 'Comprueba qué firmas y para quién.',
      card: 'Pon el DNIe sobre una mesa y apoya el móvil encima.',
      reading: 'No muevas el DNIe ni el móvil hasta que termine.',
      signing: 'No muevas el DNIe ni el móvil hasta que termine.',
    },
    /** The `reviewing` hint of a certificate read. */
    reviewingCertificate: 'Comprueba quién lo pide y comparte tu certificado.',
    unlock: {
      can: 'Número CAN',
      canHelp: 'Son los 6 números de la parte de delante de tu DNIe, abajo a la derecha.',
      canInvalid: 'El número CAN tiene 6 números.',
      canRefused: 'El número CAN no coincide con tu DNIe. Míralo otra vez en la tarjeta.',
      pin: 'PIN del DNIe',
      pinHelp: 'De 8 a 16 letras y números.',
      pinInvalid: 'El PIN tiene entre 8 y 16 caracteres.',
      pinRefused: (tries: number) =>
        tries === 1
          ? 'El PIN no es correcto. Cuidado: te queda un intento. Si fallas, el DNIe se bloquea.'
          : `El PIN no es correcto. Te quedan ${tries} intentos.`,
      pinRefusedUnknown: 'El PIN no es correcto. Escríbelo otra vez.',
      helpTitle: '¿Qué es el PIN y dónde lo encuentro?',
      canHelpTitle: '¿Dónde está el número CAN?',
      /** One list item each; a blank line splits an item into paragraphs. */
      help: [
        'El PIN es la contraseña de tu DNI electrónico.',
        'Te lo dieron en un sobre cerrado cuando te hicieron el DNI.',
        '¿Lo has perdido o no lo recuerdas? Ve a un Punto de Actualización del DNIe.\n\nSon unas máquinas que hay en las comisarías de Policía Nacional. Con tu huella pones un PIN nuevo. No hace falta cita.',
      ],
      canWhere:
        'El número CAN son los 6 números impresos en la parte de delante del DNIe, abajo a la derecha.',
      submit: 'Continuar',
    },
    login: {
      reviewing: 'Aprueba el acceso en el móvil',
      signing: 'Usando el DNIe para entrar…',
      hint: 'Comprueba la web en el móvil y mantén el DNIe cerca. Puedes cancelar aquí.',
      finished: 'Uso del DNIe terminado',
      failed: 'No se pudo usar el DNIe para entrar',
      cancelled: 'Acceso cancelado',
    },
    cancel: 'Cancelar',
    signed: 'Firmado con el DNIe',
    failed: 'No se pudo firmar',
    cancelledByUser: 'Firma cancelada',
    pair: 'Vincular el móvil',
    unpair: 'Desvincular',
    unpaired: 'Móvil desvinculado',
    pairTitle: 'Vincula tu móvil',
    pairLead:
      'El móvil lee tu DNIe por NFC y firma con él. La vinculación dura 72 horas o hasta que cierres la app.',
    noPhone: 'Ningún móvil vinculado',
    done: 'Hecho',
  },
  en: {
    app: 'Spain Assist',
    scanTitle: 'Scan this code with your phone',
    scanBody:
      'Open the Spain Assist app on your phone and scan the code. You can also scan it with the phone camera.',
    getApp:
      "Don't have the app? Look for “Spain Assist” on Google Play. You need an Android phone with NFC.",
    qrLabel: 'Code to pair your phone',
    connecting: 'Connecting…',
    unavailable: "Signing with your phone isn't available right now. Try again later.",
    away: (device: string) => `${device} isn't connected. Open the Spain Assist app on your phone.`,
    rescan: "If it doesn't connect, scan the code again.",
    connected: (device: string) => `Connected to ${device}`,
    stage: {
      unlock: 'Type your DNIe details',
      phone: 'Look at your phone',
      reviewing: 'Check the signature on your phone',
      card: 'Hold your DNIe to the back of the phone',
      reading: 'Reading your DNIe…',
      signing: 'Signing…',
    },
    stageHint: {
      unlock: 'Your phone needs them to read your DNIe.',
      phone: 'The signature request is reaching the app.',
      reviewing: 'Check what you sign and for whom.',
      card: 'Put the DNIe on a table and rest the phone on it.',
      reading: "Don't move the DNIe or the phone until it's done.",
      signing: "Don't move the DNIe or the phone until it's done.",
    },
    reviewingCertificate: 'Check who asks and share your certificate.',
    unlock: {
      can: 'CAN number',
      canHelp: 'The 6 digits on the front of your DNIe, at the bottom right.',
      canInvalid: 'The CAN has 6 digits.',
      canRefused: "The CAN doesn't match your DNIe. Check it again on the card.",
      pin: 'DNIe PIN',
      pinHelp: '8 to 16 letters and numbers.',
      pinInvalid: 'The PIN has 8 to 16 characters.',
      pinRefused: (tries: number) =>
        tries === 1
          ? 'The PIN is wrong. Careful: you have one try left. If it fails, your DNIe gets blocked.'
          : `The PIN is wrong. You have ${tries} tries left.`,
      pinRefusedUnknown: 'The PIN is wrong. Type it again.',
      helpTitle: 'What is the PIN and where do I find it?',
      canHelpTitle: 'Where is the CAN?',
      help: [
        'The PIN is the password of your electronic DNI.',
        'You got it in a sealed envelope when your DNI was issued.',
        'Lost it or can’t remember it? Go to a DNIe Update Point (Punto de Actualización del DNIe).\n\nThese are machines at Policía Nacional stations. With your fingerprint you set a new PIN. No appointment needed.',
      ],
      canWhere: 'The CAN is the 6 digits printed on the front of the DNIe, at the bottom right.',
      submit: 'Continue',
    },
    login: {
      reviewing: 'Approve login on your phone',
      signing: 'Using your DNIe to log in…',
      hint: 'Check the site on your phone and keep your DNIe nearby. You can cancel here.',
      finished: 'DNIe use ended',
      failed: 'Could not use your DNIe to log in',
      cancelled: 'Login cancelled',
    },
    cancel: 'Cancel',
    signed: 'Signed with your DNIe',
    failed: "Couldn't sign",
    cancelledByUser: 'Signature cancelled',
    pair: 'Pair your phone',
    unpair: 'Unpair',
    unpaired: 'Phone unpaired',
    pairTitle: 'Pair your phone',
    pairLead:
      'The phone reads your DNIe over NFC and signs with it. The pairing lasts 72 hours or until you quit the app.',
    noPhone: 'No phone paired',
    done: 'Done',
  },
});
