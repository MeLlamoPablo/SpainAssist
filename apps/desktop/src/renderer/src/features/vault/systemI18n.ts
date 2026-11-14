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
 * certificate's menu, and moving one to the operating system.
 */
export const systemDict = defineDict({
  es: {
    external: 'Externo',
    externalHint: (system: string) =>
      `Este certificado está instalado en ${system}, no en Spain Assist.`,
    menu: 'Más opciones',
    download: 'Descargar .p12',
    move: 'Mover al sistema operativo',
    moveTitle: (system: string) => `Mover el certificado a ${system}`,
    moveLead: (system: string) =>
      `Instalo tu certificado y su clave privada en ${system} y lo borro de Spain Assist.`,
    movePoints: (system: string) => [
      'Otros programas, como tu navegador o AutoFirma, también podrán usarlo. El sistema te pedirá permiso la primera vez que lo use cada uno.',
      'Yo lo seguiré usando desde ahí, y te pediré permiso cada vez.',
      `Aquí ya no podrás descargarlo ni borrarlo: eso se hace desde ${system}.`,
    ],
    moveWarning: 'Si quieres una copia de seguridad (.p12), descárgala antes de moverlo.',
    moveSubmit: 'Mover',
    moved: (system: string) => `Certificado movido a ${system}`,
  },
  en: {
    external: 'External',
    externalHint: (system: string) =>
      `This certificate is installed on ${system}, not in Spain Assist.`,
    menu: 'More options',
    download: 'Download .p12',
    move: 'Move to the operating system',
    moveTitle: (system: string) => `Move the certificate to ${system}`,
    moveLead: (system: string) =>
      `I’ll install your certificate and its private key on ${system} and delete it from Spain Assist.`,
    movePoints: (system: string) => [
      'Other programs, such as your browser or AutoFirma, will be able to use it too. The system will ask you the first time each one does.',
      'I’ll keep using it from there, and I’ll ask you every time.',
      `You won’t be able to download or delete it here any more: that is done on ${system}.`,
    ],
    moveWarning: 'If you want a backup copy (.p12), download it before moving it.',
    moveSubmit: 'Move',
    moved: (system: string) => `Certificate moved to ${system}`,
  },
});
