import type { AppInfo } from '@sa/shared';
import { defineDict } from '../../i18n';

type Platform = AppInfo['platform'] | undefined;

/** How the copy names this computer: "tu Mac", or the system's name where "tu" doesn't fit. */
export function systemName(platform: Platform, lang: 'es' | 'en'): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return lang === 'es' ? 'tu Mac' : 'your Mac';
}

/**
 * Where the system's certificates are exported and deleted: "Acceso a Llaveros en tu Mac", "el
 * administrador de certificados de Windows". `app`
 * is the part of the name that names a program the app can open
 * (`vault.openSystemCertificates`).
 */
export function systemCertificateManager(
  platform: Platform,
  lang: 'es' | 'en',
): { name: string; app?: string } {
  if (platform === 'win32') {
    // certmgr has no name of its own: the whole phrase opens it.
    const name =
      lang === 'es'
        ? 'el administrador de certificados de Windows'
        : 'the Windows certificate manager';
    return { name, app: name };
  }
  if (platform === 'linux') return { name: 'Linux' };
  return lang === 'es'
    ? { name: 'Acceso a Llaveros en tu Mac', app: 'Acceso a Llaveros' }
    : { name: 'Keychain Access on your Mac', app: 'Keychain Access' };
}

/**
 * Mis datos → Credenciales: certificates installed in the operating system (external), a vault
 * certificate's menu, moving one to the operating system, and dropping the app's copy of one
 * that is already there.
 */
export const systemDict = defineDict({
  es: {
    external: 'Externo',
    externalHint: (system: string) =>
      `Este certificado está instalado en ${system}, no en Spain Assist.`,
    openManager: (app: string) => `Abrir ${app}`,
    menu: 'Más opciones',
    download: 'Descargar .p12',
    move: 'Mover al sistema operativo',
    useSystem: 'Usar el del sistema operativo',
    /** Shown when the certificate is used automatically: an external one always asks. */
    automaticNotice:
      'Spain Assist ya no podrá usar tu certificado automáticamente sin tu intervención para iniciar sesión en sedes oficiales.',
    moveDialog: {
      title: (system: string) => `Mover el certificado a ${system}`,
      lead: (system: string) =>
        `Se va a instalar tu certificado en ${system} y se va a borrar de Spain Assist.`,
      points: (_system: string, manager: string) => [
        'Otros programas, como tu navegador o AutoFirma, también podrán usarlo.',
        'Spain Assist también lo seguirá usando, pidiéndote permiso cada vez.',
        `Aquí ya no podrás exportarlo ni borrarlo, eso se hace desde ${manager}.`,
      ],
      submit: 'Mover',
      done: (system: string) => `Certificado movido a ${system}`,
    },
    useDialog: {
      title: (system: string) => `Usar el certificado de ${system}`,
      lead: (system: string) =>
        `Este certificado también está instalado en ${system}. Se va a comprobar que es el mismo y se va a borrar la copia de Spain Assist.`,
      points: (system: string, manager: string) => [
        `Spain Assist lo seguirá usando desde ${system}, pidiéndote permiso cada vez.`,
        'Puede que el sistema te pida permiso para que Spain Assist use su clave.',
        `Aquí ya no podrás exportarlo ni borrarlo, eso se hace desde ${manager}.`,
      ],
      // The system's copy may not be exportable: the app's could be the only backup.
      warning: 'Si quieres una copia de seguridad (.p12), descárgala antes.',
      submit: 'Usar el del sistema',
      done: (system: string) => `Spain Assist usa ahora el certificado de ${system}`,
    },
  },
  en: {
    external: 'External',
    externalHint: (system: string) =>
      `This certificate is installed on ${system}, not in Spain Assist.`,
    openManager: (app: string) => `Open ${app}`,
    menu: 'More options',
    download: 'Download .p12',
    move: 'Move to the operating system',
    useSystem: 'Use the operating system’s',
    automaticNotice:
      'Spain Assist will no longer be able to use your certificate automatically, without you, to sign in to official sites.',
    moveDialog: {
      title: (system: string) => `Move the certificate to ${system}`,
      lead: (system: string) =>
        `Your certificate will be installed on ${system} and deleted from Spain Assist.`,
      points: (_system: string, manager: string) => [
        'Other programs, such as your browser or AutoFirma, will be able to use it too.',
        'Spain Assist will keep using it too, asking you every time.',
        `You won’t be able to export or delete it here any more: that is done in ${manager}.`,
      ],
      submit: 'Move',
      done: (system: string) => `Certificate moved to ${system}`,
    },
    useDialog: {
      title: (system: string) => `Use the certificate on ${system}`,
      lead: (system: string) =>
        `This certificate is also installed on ${system}. It will be checked to be the same one, and Spain Assist’s copy will be deleted.`,
      points: (system: string, manager: string) => [
        `Spain Assist will keep using it from ${system}, asking you every time.`,
        'The system may ask you to let Spain Assist use its key.',
        `You won’t be able to export or delete it here any more: that is done in ${manager}.`,
      ],
      warning: 'If you want a backup copy (.p12), download it first.',
      submit: 'Use the system’s',
      done: (system: string) => `Spain Assist now uses the certificate on ${system}`,
    },
  },
});
