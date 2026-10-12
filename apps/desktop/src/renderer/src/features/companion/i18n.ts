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
      phone: 'Mira tu móvil',
      reviewing: 'Revisa la firma en el móvil',
      card: 'Acerca el DNIe a la parte de atrás del móvil',
      reading: 'Leyendo el DNIe…',
      signing: 'Firmando…',
    },
    stageHint: {
      phone: 'La petición de firma está llegando a la app.',
      reviewing: 'Comprueba qué firmas y para quién, y escribe el PIN de tu DNIe.',
      card: 'Pon el DNIe sobre una mesa y apoya el móvil encima.',
      reading: 'No muevas el DNIe ni el móvil hasta que termine.',
      signing: 'No muevas el DNIe ni el móvil hasta que termine.',
    },
    /** The `reviewing` hint when the phone doesn't ask for the PIN. */
    reviewingNoPin: {
      savedPin: 'Comprueba qué firmas y para quién.',
      certificate: 'Comprueba quién lo pide y comparte tu certificado.',
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
      'El móvil lee tu DNIe por NFC y firma con él. La vinculación dura 12 horas o hasta que cierres la app.',
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
      phone: 'Look at your phone',
      reviewing: 'Check the signature on your phone',
      card: 'Hold your DNIe to the back of the phone',
      reading: 'Reading your DNIe…',
      signing: 'Signing…',
    },
    stageHint: {
      phone: 'The signature request is reaching the app.',
      reviewing: 'Check what you sign and for whom, and type your DNIe PIN.',
      card: 'Put the DNIe on a table and rest the phone on it.',
      reading: "Don't move the DNIe or the phone until it's done.",
      signing: "Don't move the DNIe or the phone until it's done.",
    },
    reviewingNoPin: {
      savedPin: 'Check what you sign and for whom.',
      certificate: 'Check who asks and share your certificate.',
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
      'The phone reads your DNIe over NFC and signs with it. The pairing lasts 12 hours or until you quit the app.',
    noPhone: 'No phone paired',
    done: 'Done',
  },
});
