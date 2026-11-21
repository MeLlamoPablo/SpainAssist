/**
 * The APK offered outside Google Play, read from GitHub: the newest `android/vX.Y.Z` release
 * with its `SpainAssist-X.Y.Z.apk`, which `.github/workflows/android-apk.yml` attaches. GitHub
 * gives the file's SHA-256 (`digest`). Read at start and every `refreshMs`; a failed read keeps
 * the last value and tries again after `retryMs`. GitHub listing no such release means none.
 */
import { z } from 'zod';
import type { AndroidApk } from './app';

const TAG = /^android\/v(\d+)\.(\d+)\.(\d+)$/;
const DIGEST = /^sha256:([0-9a-f]{64})$/;

const Release = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.string(),
      digest: z.string().nullish(),
    }),
  ),
});

/** The newest Android release in a GitHub releases listing that has its APK. */
export function newestAndroidApk(releases: unknown): AndroidApk | undefined {
  let newest: { apk: AndroidApk; order: number[] } | undefined;
  for (const item of Array.isArray(releases) ? releases : []) {
    const release = Release.safeParse(item);
    if (!release.success || release.data.draft || release.data.prerelease) continue;
    const tag = TAG.exec(release.data.tag_name);
    if (!tag) continue;
    const order = tag.slice(1).map(Number);
    const version = order.join('.');
    const asset = release.data.assets.find((a) => a.name === `SpainAssist-${version}.apk`);
    const sha256 = DIGEST.exec(asset?.digest ?? '')?.[1];
    if (!asset || !sha256 || !asset.browser_download_url.startsWith('https://')) continue;
    if (newest && !isHigher(order, newest.order)) continue;
    newest = { apk: { url: asset.browser_download_url, version, sha256 }, order };
  }
  return newest?.apk;
}

function isHigher(a: number[], b: number[]): boolean {
  const index = a.findIndex((part, i) => part !== b[i]);
  return index !== -1 && (a[index] as number) > (b[index] as number);
}

export interface GithubApkOptions {
  /** owner/name. */
  repo: string;
  fetch?: typeof fetch;
  refreshMs?: number;
  retryMs?: number;
  log?: (line: string) => void;
}

export interface GithubApk {
  current: () => AndroidApk | undefined;
  /** The first read. */
  ready: Promise<void>;
  refresh: () => Promise<void>;
  stop: () => void;
}

export function watchGithubApk(options: GithubApkOptions): GithubApk {
  const fetcher = options.fetch ?? fetch;
  const url = `https://api.github.com/repos/${options.repo}/releases?per_page=100`;
  let apk: AndroidApk | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const schedule = (ms: number) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), ms);
    timer.unref();
  };

  const refresh = async () => {
    try {
      const response = await fetcher(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'spainassist-relay',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = newestAndroidApk(await response.json());
      if (next?.url !== apk?.url) options.log?.(`android apk: ${next?.version ?? 'none'}`);
      apk = next;
      schedule(options.refreshMs ?? 10 * 60_000);
    } catch (error) {
      options.log?.(`android apk: reading GitHub failed (${(error as Error).message})`);
      schedule(options.retryMs ?? 60_000);
    }
  };

  return {
    current: () => apk,
    ready: refresh(),
    refresh,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
