import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKeyProvider, Vault } from '@sa/vault';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppPaths } from '../app/paths';
import { resetDevProfile } from './resetProfile';

const session = JSON.stringify({
  credential: { type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', expires: 1 },
  account: 'test@example.invalid',
});
const keys = createTestKeyProvider('reset-dev-test');
let directory: string;
let profile: string;
let vault: Vault;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sa-reset-test-'));
  profile = join(directory, 'profile');
  vault = await Vault.open(join(profile, 'vault'), keys);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('resetDevProfile', () => {
  it('keeps only Codex, drops its stored model, clears local files and resets onboarding', async () => {
    await vault.setSecret('provider.codex', 'Codex', session);
    await vault.setSecret('provider.byok', 'Other key', 'fake-api-key');
    await vault.setPersonal([{ key: 'givenName', value: 'Test' }], 'manual');
    await vault.addClave({ username: '99999999R', password: 'fake-password' });
    await vault.addDocument({
      name: 'test.txt',
      mimeType: 'text/plain',
      kind: 'other',
      source: 'user',
      bytes: Buffer.from('fake document'),
    });
    await writeFile(
      join(profile, 'settings.json'),
      JSON.stringify({
        onboardingCompleted: true,
        language: 'en',
        provider: { kind: 'codex', model: 'test-selected-model' },
      }),
    );
    await writeFile(join(profile, 'transcript.json'), 'fake transcript');
    await writeFile(join(profile, 'Cookies'), 'fake cookie');
    const paths = createAppPaths(profile, directory);
    await mkdir(paths.tmpDir);
    await writeFile(join(paths.tmpDir, 'document.txt'), 'fake decrypted document');
    const oldKey = await readFile(join(profile, 'vault', 'key.bin'));

    await resetDevProfile(profile, keys, directory);

    const reopened = await Vault.open(join(profile, 'vault'), keys);
    expect(await reopened.getSecret('provider.codex')).toBe(session);
    expect(reopened.listSecrets()).toHaveLength(1);
    expect(reopened.listPersonal()).toEqual([]);
    expect(reopened.listDocuments()).toEqual([]);
    expect(reopened.listCredentials()).toEqual([]);
    expect(await readdir(profile)).toEqual(['settings.json', 'vault']);
    expect(await readdir(join(profile, 'vault', 'documents'))).toEqual([]);
    expect(await readFile(join(profile, 'vault', 'key.bin'))).not.toEqual(oldKey);
    const settings = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'));
    expect(settings.onboardingCompleted).toBe(false);
    expect(settings.language).toBe('es');
    expect(settings.provider).toEqual({ kind: 'codex' });
    expect(await readdir(directory)).toEqual(['profile']);
  });

  it('restores the Codex selection when settings were deleted', async () => {
    await vault.setSecret('provider.codex', 'Codex', session);
    await resetDevProfile(profile, keys, directory);
    const settings = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'));
    expect(settings.provider).toEqual({ kind: 'codex' });
    expect(settings.onboardingCompleted).toBe(false);
  });

  it.each([undefined, 'invalid-json', JSON.stringify({ credential: { type: 'oauth' } })])(
    'resets everything without a valid Codex session (%s)',
    async (credential) => {
      if (credential) await vault.setSecret('provider.codex', 'Codex', credential);
      await vault.setSecret('provider.voucher', 'Voucher', 'fake-voucher-key');
      await vault.setPersonal([{ key: 'givenName', value: 'Test' }], 'manual');
      await writeFile(
        join(profile, 'settings.json'),
        JSON.stringify({ onboardingCompleted: true, provider: { kind: 'voucher' } }),
      );
      await writeFile(join(profile, 'Cookies'), 'fake cookie');

      expect(await resetDevProfile(profile, keys, directory)).toBe(false);

      const reopened = await Vault.open(join(profile, 'vault'), keys);
      expect(reopened.listSecrets()).toEqual([]);
      expect(reopened.listPersonal()).toEqual([]);
      expect(await readdir(profile)).toEqual(['settings.json', 'vault']);
      const settings = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'));
      expect(settings.onboardingCompleted).toBe(false);
      expect(settings.provider).toBeUndefined();
      expect(await readdir(directory)).toEqual(['profile']);
    },
  );
});
