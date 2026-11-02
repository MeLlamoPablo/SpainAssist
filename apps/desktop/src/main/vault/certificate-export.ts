import { basename, join } from 'node:path';
import { CertificateExportPassword, type Language, safeFileName } from '@sa/shared';
import { UserError } from '../core/errors';
import { writeFileAtomic } from '../core/fs';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import type { Biometric, VaultPort } from '../ports';

/** What the OS save dialog shows (Electron's `dialog.showSaveDialog`). */
export interface SavePathRequest {
  title: string;
  /** Absolute path: the folder it opens in and the file name it suggests. */
  defaultPath: string;
  buttonLabel: string;
  filters: Array<{ name: string; extensions: string[] }>;
}

/** The OS save dialog: the path the user chose, or undefined when they cancelled. */
export type ChooseSavePath = (request: SavePathRequest) => Promise<string | undefined>;

export interface CertificateExportDeps {
  vault: VaultPort;
  biometric: Biometric;
  logger: Logger;
  lang: () => Language;
  /** The folder the save dialog opens in (the user's Downloads). */
  downloadsDir: string;
  /** None without a window (headless, tests that don't set one): exports are unavailable. */
  chooseSavePath?: ChooseSavePath;
}

const STRINGS = {
  touchId: { es: 'exportar tu certificado digital', en: 'export your digital certificate' },
  title: { es: 'Exportar certificado', en: 'Export certificate' },
  button: { es: 'Exportar', en: 'Export' },
  filter: { es: 'Certificado digital (.p12)', en: 'Digital certificate (.p12)' },
  fileName: { es: 'Certificado {holder}', en: 'Certificate {holder}' },
  fileNameNoHolder: { es: 'Certificado digital', en: 'Digital certificate' },
  unavailable: {
    es: 'Aquí no se puede exportar el certificado.',
    en: 'The certificate can’t be exported here.',
  },
} as const satisfies Record<string, { es: string; en: string }>;

function text(lang: Language, key: keyof typeof STRINGS, holder = ''): string {
  return STRINGS[key][lang].replace('{holder}', holder);
}

/**
 * Mis datos → a certificate's download button: Touch ID when available (the dialog where the user
 * typed the password twice is the confirmation elsewhere, as for certificate use), then the OS save
 * dialog, then the certificate with its key and chain under `password`, as a 0600 file. Returns the
 * file name, or null when the user cancelled Touch ID or the save dialog.
 */
export async function exportCertificate(
  deps: CertificateExportDeps,
  id: string,
  password: string,
): Promise<string | null> {
  const lang = deps.lang();
  const credential = deps.vault.getCredential(id);
  if (credential?.kind !== 'certificate')
    throw new UserError(t(lang, 'vaultNotFound'), 'not_found');
  if (!CertificateExportPassword.safeParse(password).success)
    throw new UserError(t(lang, 'invalidRequest'), 'bad_request');
  deps.logger.addSecret(password);
  if (!deps.chooseSavePath) throw new UserError(text(lang, 'unavailable'), 'unavailable');

  if (!(await deps.biometric.prompt(text(lang, 'touchId')))) return null;

  const holder = credential.certificate?.holderName;
  const name = safeFileName(
    `${holder ? text(lang, 'fileName', holder) : text(lang, 'fileNameNoHolder')}.p12`,
    'Certificado.p12',
  );
  const path = await deps.chooseSavePath({
    title: text(lang, 'title'),
    defaultPath: join(deps.downloadsDir, name),
    buttonLabel: text(lang, 'button'),
    filters: [{ name: text(lang, 'filter'), extensions: ['p12', 'pfx'] }],
  });
  if (!path) return null;

  const p12 = await deps.vault.exportCertificate(id, password);
  // The user confirmed replacing an existing file in the dialog. Atomic: a failure leaves it.
  await writeFileAtomic(path, p12, 0o600);
  deps.logger.info('certificate exported');
  return basename(path);
}
