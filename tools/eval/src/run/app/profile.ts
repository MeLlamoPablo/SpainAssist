/**
 * The profile of a run: the app's user data directory (vault, procedures, pi sessions, settings).
 * A fresh run seeds it from the fixture through the calls the UI makes; a restored run starts from
 * a checkpoint's copy. A checkpoint is a copy of it: what a restart of the real app would keep.
 */
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { HeadlessApp } from '@sa/desktop/headless';
import type { FixtureSeed } from '../../contracts';

/**
 * What a profile copy leaves out: the logs (they belong to the run that wrote them), the staging
 * folder of downloads (temporary downloads never outlive a start of the app) and the scanner's
 * transcripts (the app writes none in a run).
 */
const NOT_COPIED = new Set(['logs', 'downloads', 'scanner', 'exported-downloads']);

/** Copies a profile directory into `to` (replacing what is there), without what is not state. */
export async function copyProfile(from: string, to: string): Promise<void> {
  if (!existsSync(from)) throw new Error(`The profile ${from} does not exist`);
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true, mode: 0o700 });
  await cp(from, to, {
    recursive: true,
    filter: (source) => {
      const top = relative(from, source).split(sep)[0] ?? '';
      return !NOT_COPIED.has(top);
    },
  });
}

export function isEmptyDirectory(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

/** The label a custom personal field needs (the UI asks the user for one). */
function customLabel(key: string): string {
  const slug = key.slice('custom.'.length);
  return slug.charAt(0).toUpperCase() + slug.slice(1).replace(/[-_]+/g, ' ');
}

/**
 * Puts the fixture's saved data in the vault, through the renderer API (the app validates it as
 * it does what a user types). `registerSecret` is told every password first.
 */
export async function seedVault(
  app: HeadlessApp,
  seed: FixtureSeed | undefined,
  registerSecret: (password: string) => void,
): Promise<void> {
  const personal = Object.entries(seed?.personal ?? {}).map(([key, value]) =>
    key.startsWith('custom.') ? { key, value, label: customLabel(key) } : { key, value },
  );
  if (personal.length > 0) await app.invoke('vault.setPersonal', personal);
  for (const clave of seed?.claves ?? []) {
    registerSecret(clave.password);
    await app.invoke('vault.addClave', {
      username: clave.username,
      password: clave.password,
      ...(clave.label ? { label: clave.label } : {}),
    });
  }
}

/** The one place a profile is: `<runDir>/profile`. */
export const profileDirOf = (runDir: string): string => join(runDir, 'profile');
