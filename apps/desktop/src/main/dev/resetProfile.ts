import assert from 'node:assert/strict';
import { lstat, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_SETTINGS } from '@sa/shared';
import { type KeyProvider, Vault } from '@sa/vault';
import { z } from 'zod';
import { createAppPaths } from '../app/paths';
import { writeFileAtomic } from '../core/fs';
import { SECRET_IDS } from '../core/secrets';

const CodexSession = z.object({
  credential: z.object({
    type: z.literal('oauth'),
    access: z.string().min(1),
    refresh: z.string().min(1),
    expires: z.number(),
  }),
});

/**
 * Keeps only a valid Codex session, or nothing. Returns whether Codex was kept.
 * Caller must hold the profile's Electron single-instance lock. No network requests.
 */
export async function resetDevProfile(profile: string, keys: KeyProvider, tempRoot?: string) {
  const paths = createAppPaths(profile, tempRoot);
  if (!(await lstat(paths.vaultDir)).isDirectory()) throw new Error('Missing dev vault.');
  // Read and validate everything before deleting any data. Never print validation errors:
  // they can contain values from the credential.
  const original = await Vault.open(paths.vaultDir, keys);
  const session = await original.getSecret(SECRET_IDS.codex);
  let validSession = false;
  try {
    validSession = session !== undefined && CodexSession.safeParse(JSON.parse(session)).success;
  } catch {
    // Malformed JSON is treated like a missing credential.
  }
  // Without a valid Codex session, everything is reset.
  const kept = validSession ? session : undefined;
  const settings = kept
    ? { ...DEFAULT_SETTINGS, provider: { kind: 'codex' as const } }
    : DEFAULT_SETTINGS;

  // Stage a verified encrypted replacement before destroying the original vault.
  const staging = await mkdtemp(join(dirname(profile), '.sa-dev-reset-'));
  let deleting = false;
  try {
    const replacement = await Vault.open(join(staging, 'vault'), keys);
    if (kept) await replacement.setSecret(SECRET_IDS.codex, 'Codex', kept);
    await writeFileAtomic(join(staging, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
    const check = await Vault.open(join(staging, 'vault'), keys);
    assert.equal(await check.getSecret(SECRET_IDS.codex), kept);
    assert.equal(check.listSecrets().length, kept ? 1 : 0);
    assert.equal(check.listPersonal().length, 0);
    assert.equal(check.listDocuments().length, 0);
    assert.equal(check.listCredentials().length, 0);

    deleting = true;
    await Vault.destroy(paths.vaultDir);
    for (const name of await readdir(profile)) {
      // Keep Electron's lock until this process exits.
      if (!name.startsWith('Singleton')) {
        await rm(join(profile, name), { recursive: true, force: true });
      }
    }
    await rm(paths.tmpDir, { recursive: true, force: true });
    await rename(join(staging, 'vault'), paths.vaultDir);
    await rename(join(staging, 'settings.json'), paths.settingsFile);
    await rm(staging, { recursive: true, force: true });
  } catch {
    if (!deleting) {
      await rm(staging, { recursive: true, force: true });
      throw new Error('Could not prepare the reset. Original data was kept.');
    }
    throw new Error(`Reset interrupted. Encrypted recovery files are in ${staging}.`);
  }
  return kept !== undefined;
}
