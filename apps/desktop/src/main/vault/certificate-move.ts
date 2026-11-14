import { randomBytes, X509Certificate } from 'node:crypto';
import type { Language } from '@sa/shared';
import { pkcs12ToPem } from '@sa/vault';
import { UserError } from '../core/errors';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { errorMessage } from '../core/util';
import type { OsCertificates } from '../os-certificates/service';
import { OsKeyStoreError } from '../os-certificates/store';
import type { Biometric, VaultPort } from '../ports';

export interface CertificateMoveDeps {
  vault: VaultPort;
  biometric: Biometric;
  logger: Logger;
  lang: () => Language;
  /** None where the app can't use the OS certificate store: nothing can be moved. */
  osCertificates?: OsCertificates;
}

const STRINGS = {
  touchId: {
    es: 'mover tu certificado digital al sistema operativo',
    en: 'move your digital certificate to the operating system',
  },
  touchIdUse: {
    es: 'usar el certificado digital del sistema operativo',
    en: 'use the operating system’s digital certificate',
  },
  unavailable: {
    es: 'Aquí no se puede mover el certificado al sistema operativo.',
    en: 'The certificate can’t be moved to the operating system here.',
  },
  notMovable: {
    es: 'Este certificado no se puede mover: Spain Assist solo usa desde el sistema operativo los certificados de la FNMT.',
    en: 'This certificate can’t be moved: Spain Assist only uses FNMT certificates from the operating system.',
  },
  denied: {
    es: 'El sistema no ha permitido añadir el certificado. Sigue guardado en Spain Assist.',
    en: 'The system didn’t allow adding the certificate. It is still saved in Spain Assist.',
  },
  failed: {
    es: 'No se ha podido mover el certificado. Sigue guardado en Spain Assist.',
    en: 'The certificate couldn’t be moved. It is still saved in Spain Assist.',
  },
  useDenied: {
    es: 'El sistema no ha permitido usar su certificado. El tuyo sigue guardado en Spain Assist.',
    en: 'The system didn’t allow using its certificate. Yours is still saved in Spain Assist.',
  },
  notSame: {
    es: 'No he podido comprobar que el certificado del sistema operativo es el mismo. El tuyo sigue guardado en Spain Assist.',
    en: 'I couldn’t check that the operating system’s certificate is the same one. Yours is still saved in Spain Assist.',
  },
} as const satisfies Record<string, { es: string; en: string }>;

/**
 * Mis datos → a certificate's menu → "Mover al sistema operativo": Touch ID when available (the
 * dialog that explained the move is the confirmation elsewhere), then the certificate with its
 * key and chain goes into the OS store (macOS: the login keychain). Only once the app has found
 * it there and signed with it does the vault's copy go, so a failure leaves everything as it
 * was. From then on it shows as an external certificate. Returns false when the user cancelled
 * Touch ID.
 *
 * A certificate that is already in the OS store (`inSystem`, "Usar el del sistema operativo")
 * has nothing to install: the vault's copy goes only once the system's has proven to be the
 * same certificate, byte for byte, and to sign with its key.
 */
export async function moveCertificateToSystem(
  deps: CertificateMoveDeps,
  id: string,
): Promise<boolean> {
  const lang = deps.lang();
  const credential = deps.vault.getCredential(id);
  if (credential?.kind !== 'certificate' || credential.external)
    throw new UserError(t(lang, 'vaultNotFound'), 'not_found');
  const os = deps.osCertificates;
  if (!os) throw new UserError(STRINGS.unavailable[lang], 'unavailable');

  const inSystem = credential.certificate ? os.has(credential.certificate.fingerprint) : false;

  if (!(await deps.biometric.prompt(STRINGS[inSystem ? 'touchIdUse' : 'touchId'][lang])))
    return false;

  // Only in memory, for the OS import: the 3DES encoding every macOS release reads.
  const passphrase = randomBytes(24).toString('base64url');
  deps.logger.addSecret(passphrase);
  const p12 = await deps.vault.exportCertificate(id, passphrase);
  const der = new X509Certificate((await pkcs12ToPem(p12, passphrase)).cert).raw;
  if (!os.eligible(der)) throw new UserError(STRINGS.notMovable[lang], 'bad_request');
  try {
    if (inSystem) await os.prove(der);
    else await os.install(p12, passphrase, der);
  } catch (err) {
    const denied = err instanceof OsKeyStoreError && err.code === 'denied';
    deps.logger.warn(
      inSystem
        ? 'the OS store’s certificate not proven the same'
        : 'certificate not moved to the OS store',
      { error: errorMessage(err), status: err instanceof OsKeyStoreError ? err.status : undefined },
    );
    const message = inSystem
      ? STRINGS[denied ? 'useDenied' : 'notSame']
      : STRINGS[denied ? 'denied' : 'failed'];
    throw new UserError(message[lang], 'unavailable');
  }
  await deps.vault.deleteCredential(id);
  deps.logger.info(
    inSystem ? 'vault certificate dropped for the OS store’s' : 'certificate moved to the OS store',
  );
  return true;
}
