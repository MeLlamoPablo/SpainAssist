import { app } from 'electron';
import { createAppPaths } from '../app/paths';
import { silentLogger } from '../core/logger';
import { SettingsStore } from '../settings/store';
import { openDevProfile } from './profile';

/** Shows onboarding again on the next start. Everything else in the profile is kept. */
async function main() {
  const profile = await openDevProfile('reset:dev:onboarding');
  if (!profile) {
    app.exit(1);
    return;
  }
  const settings = await SettingsStore.open(createAppPaths(profile).settingsFile, {
    logger: silentLogger,
  });
  await settings.update({ onboardingCompleted: false });
  console.log('Onboarding is ready. Your data, settings and Codex session were kept.');
  console.log('Start the app with: corepack pnpm dev');
  app.exit(0);
}

main().catch(() => {
  console.error('Could not reset onboarding. Check the dev profile.');
  app.exit(1);
});
