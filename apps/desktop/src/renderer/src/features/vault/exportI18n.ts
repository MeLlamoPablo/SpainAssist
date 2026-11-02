import { defineDict } from '../../i18n';

/** Mis datos → Credenciales: exporting a certificate as a password-protected `.p12`. */
export const exportDict = defineDict({
  es: {
    action: 'Descargar copia (.p12)',
    title: 'Exportar certificado',
    lead: 'Guardo una copia de tu certificado y su clave privada en un archivo .p12, protegido con contraseña.',
    password: 'Contraseña del archivo',
    passwordHelp: (min: number) => `Al menos ${min} caracteres.`,
    repeat: 'Repite la contraseña',
    note: 'La necesitarás para instalar el certificado en otro sitio. No la guardo, así que no podré recuperarla.',
    warning:
      'Con el archivo y su contraseña, cualquiera puede identificarse y firmar como tú. Guárdalos por separado, en un lugar seguro.',
    short: (min: number) => `Usa al menos ${min} caracteres.`,
    mismatch: 'Las contraseñas no coinciden.',
    submit: 'Exportar…',
    saved: (name: string) => `Exportado: ${name}`,
  },
  en: {
    action: 'Download a copy (.p12)',
    title: 'Export certificate',
    lead: 'I’ll save a copy of your certificate and its private key in a .p12 file, protected with a password.',
    password: 'Password for the file',
    passwordHelp: (min: number) => `At least ${min} characters.`,
    repeat: 'Repeat the password',
    note: 'You’ll need it to install the certificate elsewhere. I don’t keep it, so I can’t recover it.',
    warning:
      'With the file and its password, anyone can identify themselves and sign as you. Keep them apart, somewhere safe.',
    short: (min: number) => `Use at least ${min} characters.`,
    mismatch: 'The passwords don’t match.',
    submit: 'Export…',
    saved: (name: string) => `Exported: ${name}`,
  },
});
