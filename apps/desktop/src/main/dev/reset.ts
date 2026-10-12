import { app, safeStorage } from 'electron';
import { silentLogger } from '../core/logger';
import { createSafeStorageKeyProvider } from '../vault/keyProvider';
import { openDevProfile } from './profile';
import { resetDevProfile } from './resetProfile';

async function main() {
  const profile = await openDevProfile('reset:dev');
  if (!profile) {
    app.exit(1);
    return;
  }
  const keys = await createSafeStorageKeyProvider(safeStorage, process.platform, silentLogger);
  const keptCodex = await resetDevProfile(profile, keys);
  console.log(
    keptCodex
      ? 'Dev data cleared. Codex session kept. Onboarding is ready.'
      : 'Dev data cleared. No Codex session was saved, so everything was reset.',
  );
  console.log('Start the app with: corepack pnpm dev');
  app.exit(0);
}

main().catch((error: unknown) => {
  // Only our own reset errors are safe to print. OS/vault errors stay out of logs.
  const message = error instanceof Error ? error.message : '';
  const safe = ['Could not prepare the reset.', 'Reset interrupted.', 'Missing dev vault.'].some(
    (prefix) => message.startsWith(prefix),
  );
  console.error(
    safe ? message : 'Reset failed. Check the dev profile and OS keychain availability.',
  );
  app.exit(1);
});
