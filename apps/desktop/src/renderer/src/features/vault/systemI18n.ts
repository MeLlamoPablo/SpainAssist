import type { AppInfo } from '@sa/shared';
import { defineDict } from '../../i18n';

/** How the copy names this computer: "tu Mac", or the system's name where "tu" doesn't fit. */
export function systemName(platform: AppInfo['platform'] | undefined, lang: 'es' | 'en'): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return lang === 'es' ? 'tu Mac' : 'your Mac';
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
    menu: 'Más opciones',
    download: 'Descargar .p12',
    move: 'Mover al sistema operativo',
    useSystem: 'Usar el del sistema operativo',
    moveDialog: {
      title: (system: string) => `Mover el certificado a ${system}`,
      lead: (system: string) =>
        `Instalo tu certificado y su clave privada en ${system} y lo borro de Spain Assist.`,
      points: (system: string) => [
        'Otros programas, como tu navegador o AutoFirma, también podrán usarlo. El sistema te pedirá permiso la primera vez que lo use cada uno.',
        'Yo lo seguiré usando desde ahí, y te pediré permiso cada vez.',
        `Aquí ya no podrás descargarlo ni borrarlo: eso se hace desde ${system}.`,
      ],
      warning: 'Si quieres una copia de seguridad (.p12), descárgala antes de moverlo.',
      submit: 'Mover',
      done: (system: string) => `Certificado movido a ${system}`,
    },
    useDialog: {
      title: (system: string) => `Usar el certificado de ${system}`,
      lead: (system: string) =>
        `Este certificado también está instalado en ${system}. Compruebo que es el mismo y borro la copia de Spain Assist.`,
      points: (system: string) => [
        `Lo seguiré usando desde ${system}, y te pediré permiso cada vez.`,
        'Puede que el sistema te pida permiso para que yo use su clave.',
        `Aquí ya no podrás descargarlo ni borrarlo: eso se hace desde ${system}.`,
      ],
      warning: 'Si quieres una copia de seguridad (.p12), descárgala antes.',
      submit: 'Usar el del sistema',
      done: (system: string) => `Ahora uso el certificado de ${system}`,
    },
  },
  en: {
    external: 'External',
    externalHint: (system: string) =>
      `This certificate is installed on ${system}, not in Spain Assist.`,
    menu: 'More options',
    download: 'Download .p12',
    move: 'Move to the operating system',
    useSystem: 'Use the operating system’s',
    moveDialog: {
      title: (system: string) => `Move the certificate to ${system}`,
      lead: (system: string) =>
        `I’ll install your certificate and its private key on ${system} and delete it from Spain Assist.`,
      points: (system: string) => [
        'Other programs, such as your browser or AutoFirma, will be able to use it too. The system will ask you the first time each one does.',
        'I’ll keep using it from there, and I’ll ask you every time.',
        `You won’t be able to download or delete it here any more: that is done on ${system}.`,
      ],
      warning: 'If you want a backup copy (.p12), download it before moving it.',
      submit: 'Move',
      done: (system: string) => `Certificate moved to ${system}`,
    },
    useDialog: {
      title: (system: string) => `Use the certificate on ${system}`,
      lead: (system: string) =>
        `This certificate is also installed on ${system}. I’ll check that it is the same one and delete Spain Assist’s copy.`,
      points: (system: string) => [
        `I’ll keep using it from ${system}, and I’ll ask you every time.`,
        'The system may ask you to let me use its key.',
        `You won’t be able to download or delete it here any more: that is done on ${system}.`,
      ],
      warning: 'If you want a backup copy (.p12), download it first.',
      submit: 'Use the system’s',
      done: (system: string) => `Now using the certificate on ${system}`,
    },
  },
});
