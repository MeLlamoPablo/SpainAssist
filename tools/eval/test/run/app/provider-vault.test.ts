import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKeyProvider, Vault } from '@sa/vault';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRunVault, withMemoryProviderSecrets } from '../../../src/run/app/provider-vault';

let dir: string;
const keys = () => createTestKeyProvider('provider-vault-test');
const KEY = 'sk-never-on-disk-5d2f8a91c4e7';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-provider-vault-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function everyFileHolds(root: string, needle: string): boolean {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (everyFileHolds(path, needle)) return true;
    } else if (statSync(path).isFile() && readFileSync(path).includes(needle)) return true;
  }
  return false;
}

describe('the vault of a run', () => {
  it('answers provider secrets from memory and never writes them', async () => {
    const vault = await openRunVault(() => new Date('2026-10-16T10:00:00.000Z'))(dir, keys());
    await vault.setSecret('provider.voucher', 'Voucher', KEY);
    await vault.setSecret(
      'provider.codex',
      'Codex',
      JSON.stringify({ credential: { access: KEY } }),
    );
    expect(await vault.getSecret('provider.voucher')).toBe(KEY);
    expect(vault.listSecrets().map((s) => [s.id, s.label])).toEqual([
      ['provider.codex', 'Codex'],
      ['provider.voucher', 'Voucher'],
    ]);
    expect(vault.listSecrets()[0]?.createdAt).toBe('2026-10-16T10:00:00.000Z');
    // The directory holds sealed data only, and not this.
    expect(everyFileHolds(dir, KEY)).toBe(false);

    // Another vault on the same directory (a restored profile) has none of them.
    await vault.addClave({ username: '53918274H', password: 'Contraseña-larga-1' });
    const reopened = await Vault.open(dir, keys());
    expect(reopened.listSecrets()).toEqual([]);
    expect(await reopened.getSecret('provider.voucher')).toBeUndefined();
    expect(reopened.listCredentials().map((c) => c.kind)).toEqual(['clave_permanente']);
  });

  it('keeps the other secrets of the app where they always were', async () => {
    const vault = await openRunVault(() => new Date())(dir, keys());
    await vault.setSecret('research.exa', 'Exa', 'exa-key-persisted-0001');
    await vault.setSecret('provider.voucher', 'Voucher', KEY);
    const reopened = await Vault.open(dir, keys());
    expect(reopened.listSecrets().map((s) => s.id)).toEqual(['research.exa']);
    expect(await reopened.getSecret('research.exa')).toBe('exa-key-persisted-0001');
  });

  it('replaces and deletes a provider secret, and wipes it with the vault', async () => {
    const vault = await openRunVault(() => new Date())(dir, keys());
    await vault.setSecret('provider.voucher', 'Voucher', 'primero-1234');
    await vault.setSecret('provider.voucher', 'Voucher', 'segundo-5678');
    expect(await vault.getSecret('provider.voucher')).toBe('segundo-5678');
    expect(vault.listSecrets()).toHaveLength(1);
    await vault.deleteSecret('provider.voucher');
    expect(await vault.getSecret('provider.voucher')).toBeUndefined();
    await vault.setSecret('provider.codex', 'Codex', 'tercero-9012');
    await vault.wipe();
    expect(await vault.getSecret('provider.codex')).toBeUndefined();
  });

  it('is the real vault for everything else, with the clock it was given', async () => {
    const vault = await openRunVault(() => new Date('2030-05-06T07:08:09.000Z'))(dir, keys());
    await vault.setPersonal([{ key: 'givenName', value: 'Lucía' }], 'manual');
    expect(vault.listPersonal()[0]).toMatchObject({
      key: 'givenName',
      updatedAt: '2030-05-06T07:08:09.000Z',
    });
    const real = await Vault.open(join(dir, 'other'), keys());
    expect(withMemoryProviderSecrets(real, () => new Date()).overview()).toMatchObject({
      personal: [],
      documents: [],
    });
  });
});
