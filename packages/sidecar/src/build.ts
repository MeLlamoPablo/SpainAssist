/**
 * Builds sa-sidecar (`packages/sidecar/go`) with the Go toolchain: a static binary, no cgo, for
 * the host or any target in GOOS/GOARCH terms (cross-compiling needs nothing else). Go's build
 * cache makes a rebuild without changes take about a second.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { SIDECAR_TARGETS, type SidecarTarget, vendorBinaryPath } from './layout';

const GO_DIR = path.join(import.meta.dirname, '..', 'go');
const REPO = path.join(import.meta.dirname, '..', '..', '..');

/** Where the desktop app looks for it in development (`layout.ts`). */
export const DEV_VENDOR_DIR = path.join(REPO, 'apps', 'desktop', 'vendor');

const GOOS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'darwin',
  win32: 'windows',
  linux: 'linux',
};
const GOARCH: Partial<Record<string, string>> = { arm64: 'arm64', x64: 'amd64' };

export interface BuildOptions {
  /** Default DEV_VENDOR_DIR. The binary goes to `<outDir>/<platform>-<arch>/`. */
  outDir?: string;
  /** Default: the host's. */
  platform?: NodeJS.Platform;
  arch?: string;
}

/** Builds the sidecar and resolves with the binary's path. Rejects with ENOENT without Go. */
export async function buildSidecar(options: BuildOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const goos = GOOS[platform];
  const goarch = GOARCH[arch];
  if (!goos || !goarch) throw new Error(`Unsupported target ${platform}-${arch}`);
  const out = vendorBinaryPath(options.outDir ?? DEV_VENDOR_DIR, platform, arch);
  await fs.mkdir(path.dirname(out), { recursive: true });
  // The Go linker ad-hoc signs darwin/arm64 binaries itself, which Apple Silicon requires.
  await promisify(execFile)(
    'go',
    ['build', '-buildvcs=false', '-trimpath', '-ldflags=-s -w', '-o', out, '.'],
    { cwd: GO_DIR, env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' } },
  );
  return out;
}

/** Builds every shipped target (`SIDECAR_TARGETS`), one after another (Go parallelizes). */
export async function buildAllSidecars(
  options: Pick<BuildOptions, 'outDir'> = {},
  targets: readonly SidecarTarget[] = SIDECAR_TARGETS,
): Promise<string[]> {
  const built: string[] = [];
  for (const target of targets) built.push(await buildSidecar({ ...options, ...target }));
  return built;
}
