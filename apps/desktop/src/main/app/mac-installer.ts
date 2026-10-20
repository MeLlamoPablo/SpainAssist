import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const absolutePath = z.string().refine(isAbsolute);
const diskImage = z.object({
  'image-path': absolutePath,
  'system-entities': z.array(z.object({ 'mount-point': absolutePath.optional() })),
});
const diskImages = z.object({ images: z.array(diskImage).default([]) });
type DiskImage = z.infer<typeof diskImage>;
const pendingInstall = z.object({
  image: absolutePath.refine((path) => path.toLowerCase().endsWith('.dmg')),
  mount: absolutePath.refine((path) => path.startsWith('/Volumes/')),
  dev: z.number(),
  ino: z.number(),
  size: z.number(),
  mtimeMs: z.number(),
  manifest: z.string().regex(/^[a-f0-9]{64}$/),
});
type PendingInstall = z.infer<typeof pendingInstall>;

/** JSON conversion uses Apple's parser, rather than interpreting hdiutil's human output. */
export async function mountedDiskImages(): Promise<DiskImage[]> {
  const { stdout } = await execute('/usr/bin/hdiutil', ['info', '-plist'], {
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const json = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', '--', '-'],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (error, output) => (error ? reject(error) : resolve(output)),
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(stdout);
  });
  return diskImages.parse(JSON.parse(json)).images;
}

/** CodeResources identifies this exact signed build and works through App Translocation. */
export async function bundleManifest(bundle: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(join(bundle, 'Contents/_CodeSignature/CodeResources')))
    .digest('hex');
}

/** Never infer a Downloads filename or choose the first mounted installer. */
export async function identifyInstaller(
  images: DiskImage[],
  manifest: string,
  sourceBundle?: string,
  readManifest = bundleManifest,
): Promise<{ image: string; mount: string } | undefined> {
  const matches: { image: string; mount: string }[] = [];
  for (const image of images) {
    if (!image['image-path'].toLowerCase().endsWith('.dmg')) continue;
    for (const entity of image['system-entities']) {
      const mount = entity['mount-point'];
      if (!mount?.startsWith('/Volumes/')) continue;
      try {
        if ((await readManifest(join(mount, 'Spain Assist.app'))) === manifest)
          matches.push({ image: image['image-path'], mount });
      } catch {
        // Other mounted images are unrelated, unreadable, or have no Spain Assist bundle.
      }
    }
  }
  // Different DMGs can contain the same signed app (for example, artwork-only updates).
  // Prefer the actual running bundle's volume; retain the unique-manifest fallback for
  // App Translocation, where the executable path no longer points into /Volumes.
  const sourceMatches = matches.filter(
    ({ mount }) => join(mount, 'Spain Assist.app') === sourceBundle,
  );
  if (sourceMatches.length === 1) return sourceMatches[0];
  return matches.length === 1 ? matches[0] : undefined;
}

const markerPath = (userData: string) => join(userData, 'pending-mac-install.json');

export async function rememberInstaller(
  userData: string,
  source: { image: string; mount: string },
  manifest: string,
): Promise<void> {
  const { dev, ino, size, mtimeMs } = await stat(source.image);
  const pending = pendingInstall.parse({ ...source, manifest, dev, ino, size, mtimeMs });
  await mkdir(userData, { recursive: true, mode: 0o700 });
  await writeFile(markerPath(userData), JSON.stringify(pending), { mode: 0o600 });
}

/** Revalidate the exact file before moving it to Trash, including across the relaunch. */
export function isSameInstaller(
  pending: PendingInstall,
  manifest: string,
  current: Pick<PendingInstall, 'dev' | 'ino' | 'size' | 'mtimeMs'>,
): boolean {
  return (
    pending.manifest === manifest &&
    pending.dev === current.dev &&
    pending.ino === current.ino &&
    pending.size === current.size &&
    pending.mtimeMs === current.mtimeMs
  );
}

/** Only the first launch after a recorded copy offers to move the installer to Trash. */
export async function hasPendingInstaller(userData: string): Promise<boolean> {
  return access(markerPath(userData)).then(
    () => true,
    () => false,
  );
}

export async function forgetInstaller(userData: string): Promise<void> {
  await rm(markerPath(userData), { force: true });
}

export async function cleanupInstaller(options: {
  userData: string;
  manifest: () => Promise<string>;
  images: () => Promise<DiskImage[]>;
  detach: (mount: string) => Promise<void>;
  trash: (image: string) => Promise<void>;
}): Promise<void> {
  const marker = markerPath(options.userData);
  let raw: string;
  try {
    raw = await readFile(marker, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // Consume once, including denied access or a busy volume. Never nag on subsequent launches.
  await forgetInstaller(options.userData);
  const pending = pendingInstall.parse(JSON.parse(raw));
  const manifest = await options.manifest();
  if (!isSameInstaller(pending, manifest, await stat(pending.image))) return;
  const attached = (await options.images()).find((image) => image['image-path'] === pending.image);
  if (attached) {
    // A remounted image must still be on the original volume, never eject another disk.
    if (!attached['system-entities'].some((entity) => entity['mount-point'] === pending.mount))
      return;
    await options.detach(pending.mount);
  }
  // Detach must succeed before trashing. Electron may already have ejected the source volume.
  if (!isSameInstaller(pending, manifest, await stat(pending.image))) return;
  await options.trash(pending.image);
}

export async function detachInstaller(mount: string): Promise<void> {
  await execute('/usr/bin/hdiutil', ['detach', mount], { timeout: 15_000 });
}
