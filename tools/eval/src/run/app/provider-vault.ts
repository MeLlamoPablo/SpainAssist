/**
 * The vault of a run, with the model credential kept out of the profile directory.
 *
 * The app keeps the credential of its AI provider (the voucher key, the Codex tokens) in the vault,
 * sealed with the key provider the profile was made with. A run's key provider is the fixed
 * `createTestKeyProvider` seed, which anyone can read in the source, so a sealed key in a profile is
 * as good as plaintext in a run directory, a checkpoint or an archive. The credential belongs to
 * the machine's credentials home (`evalHome`), never to run artifacts.
 *
 * So the `provider.*` secrets are held in memory by this wrapper and never reach the disk: the
 * real `ProviderManager` still reads and writes them through the vault interface, exactly as in
 * the product. A profile restored from a checkpoint has none, and `activateProvider` puts the
 * credential back through the provider's own flow.
 */

import type { HeadlessOptions } from '@sa/desktop/headless';
import { Vault, type VaultOptions } from '@sa/vault';

type OpenVault = NonNullable<HeadlessOptions['openVault']>;
export type VaultPort = Awaited<ReturnType<OpenVault>>;
type KeyProvider = Parameters<OpenVault>[1];

/** The ids of the app's provider secrets (`core/secrets.ts`: `provider.voucher`, `provider.codex`...). */
const PROVIDER_SECRET = /^provider\./;

interface MemorySecret {
  label: string;
  value: string;
  createdAt: string;
}

/** `vault` with every `provider.*` secret answered from memory instead of the profile. */
export function withMemoryProviderSecrets(vault: VaultPort, now: () => Date): VaultPort {
  const memory = new Map<string, MemorySecret>();
  const override: Partial<Record<keyof VaultPort, unknown>> = {
    listSecrets: () =>
      [
        ...vault.listSecrets(),
        ...[...memory].map(([id, secret]) => ({
          id,
          label: secret.label,
          createdAt: secret.createdAt,
        })),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    setSecret: async (id: string, label: string, value: string) => {
      if (!PROVIDER_SECRET.test(id)) return vault.setSecret(id, label, value);
      memory.set(id, {
        label,
        value,
        createdAt: memory.get(id)?.createdAt ?? now().toISOString(),
      });
    },
    getSecret: async (id: string) =>
      PROVIDER_SECRET.test(id) ? memory.get(id)?.value : vault.getSecret(id),
    deleteSecret: async (id: string) => {
      if (PROVIDER_SECRET.test(id)) memory.delete(id);
      else await vault.deleteSecret(id);
    },
    wipe: async () => {
      memory.clear();
      await vault.wipe();
    },
  };
  return new Proxy(vault, {
    get(target, property) {
      if (Object.hasOwn(override, property)) return override[property as keyof VaultPort];
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * `HeadlessOptions.openVault` of a run: the vault of the profile with the given clock (so the
 * dates the app stamps agree with the app's own) and the provider secrets in memory only.
 */
export function openRunVault(now: () => Date): OpenVault {
  return async (dir: string, keys: KeyProvider) => {
    const options: VaultOptions = { now };
    const vault = await Vault.open(dir, keys, options);
    return withMemoryProviderSecrets(vault, now);
  };
}
