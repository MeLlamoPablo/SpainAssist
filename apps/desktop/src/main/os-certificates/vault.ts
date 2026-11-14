import type { CredentialSummary } from '@sa/shared';
import { VaultError } from '@sa/vault';
import type { VaultPort } from '../ports';
import { isOsCredentialId, type OsCertificates } from './service';

/**
 * The vault plus the external certificates (`OsCertificates`), so everything that lists or looks
 * up credentials (Mis datos, the agent, logins, signatures) sees them as `certificate`
 * credentials marked `external`. They aren't in the vault: nothing about them can be changed,
 * exported or deleted through it. A certificate that is also in the vault shows once, as the
 * vault's, marked `inSystem`.
 */
export function withOsCertificates(vault: VaultPort, os: OsCertificates): VaultPort {
  const credentials = (): CredentialSummary[] => {
    const own = vault.listCredentials().map((c) => {
      if (c.kind !== 'certificate' || !c.certificate) return c;
      if (os.has(c.certificate.fingerprint)) return { ...c, inSystem: true };
      return os.movable(c.certificate) ? { ...c, canMoveToSystem: true } : c;
    });
    const held = new Set(
      own.filter((c) => c.kind === 'certificate').map((c) => c.certificate?.fingerprint),
    );
    return [...own, ...os.list().filter((c) => !held.has(c.certificate?.fingerprint))];
  };
  const notInVault = async (): Promise<never> => {
    throw new VaultError('not_found', 'An external certificate is not in the vault');
  };
  const overrides: Partial<VaultPort> = {
    overview: (opts) => ({ ...vault.overview(opts), credentials: credentials() }),
    listCredentials: credentials,
    getCredential: (id) => credentials().find((c) => c.id === id),
    setCredentialPolicy: (id, policy) =>
      isOsCredentialId(id) ? notInVault() : vault.setCredentialPolicy(id, policy),
    getCredentialSecret: (id) =>
      isOsCredentialId(id) ? notInVault() : vault.getCredentialSecret(id),
    exportCertificate: (id, passphrase) =>
      isOsCredentialId(id) ? notInVault() : vault.exportCertificate(id, passphrase),
    deleteCredential: (id) => (isOsCredentialId(id) ? notInVault() : vault.deleteCredential(id)),
    // The vault keeps no record of external certificates, so nothing to update.
    markCredentialUsed: async (id) => {
      if (!isOsCredentialId(id)) await vault.markCredentialUsed(id);
    },
  };
  return new Proxy(vault, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property as keyof VaultPort];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
