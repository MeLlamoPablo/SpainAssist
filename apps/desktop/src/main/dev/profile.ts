import { join, resolve } from 'node:path';
import { app } from 'electron';

/**
 * Points Electron at the dev profile (SA_USER_DATA_DIR or the usual one), takes the profile's
 * single-instance lock and waits for the app. Returns undefined if the app is running.
 */
export async function openDevProfile(command: string): Promise<string | undefined> {
  app.setName('SpainAssistant');
  const profile = process.env.SA_USER_DATA_DIR?.trim()
    ? resolve(process.env.SA_USER_DATA_DIR)
    : join(app.getPath('appData'), 'SpainAssistant');
  app.setPath('userData', profile);
  if (!app.requestSingleInstanceLock()) {
    console.error(`Close the dev app and stop its dev command before running ${command}.`);
    return undefined;
  }
  await app.whenReady();
  return profile;
}
