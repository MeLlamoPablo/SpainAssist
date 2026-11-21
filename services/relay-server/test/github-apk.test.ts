import { afterEach, describe, expect, it } from 'vitest';
import { type GithubApk, newestAndroidApk, watchGithubApk } from '../src/github-apk';

const REPO = 'MeLlamoPablo/SpainAssist';

function apkOf(version: string) {
  return {
    url: `https://github.com/${REPO}/releases/download/android/v${version}/SpainAssist-${version}.apk`,
    version,
    sha256: version.replaceAll('.', '').padEnd(64, 'a'),
  };
}

/** A release as GitHub's API lists it, with its APK unless `assets` says otherwise. */
function release(tag: string, overrides: Record<string, unknown> = {}) {
  const version = tag.replace(/^android\/v/, '');
  const apk = apkOf(version);
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: `SpainAssist-${version}.apk`,
        browser_download_url: apk.url,
        digest: `sha256:${apk.sha256}`,
      },
    ],
    ...overrides,
  };
}

/** A fake GitHub that answers each request with the next response (the last one repeats). */
function fakeGithub(...responses: (unknown[] | number)[]) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: init?.headers as Record<string, string> });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return typeof next === 'number'
      ? new Response('', { status: next })
      : Response.json(next ?? []);
  };
  return { fetch: fetcher as typeof fetch, requests };
}

const watchers: GithubApk[] = [];

function watch(github: ReturnType<typeof fakeGithub>, log: string[] = []) {
  const watcher = watchGithubApk({ repo: REPO, fetch: github.fetch, log: (l) => log.push(l) });
  watchers.push(watcher);
  return watcher;
}

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
});

describe('newest Android APK on GitHub', () => {
  it('picks the highest android/vX.Y.Z release that has its APK', () => {
    const releases = [
      release('v0.5.0'),
      release('android/v0.3.5'),
      release('android/v0.10.0'),
      release('android/v0.4.0'),
    ];
    expect(newestAndroidApk(releases)).toEqual(apkOf('0.10.0'));
  });

  it('skips drafts, prereleases and releases without a usable APK', () => {
    const usable = release('android/v0.3.5');
    const releases = [
      release('android/v0.9.0', { draft: true }),
      release('android/v0.8.0', { prerelease: true }),
      release('android/v0.7.0', { assets: [] }),
      release('android/v0.6.0', { assets: [{ ...usable.assets[0], name: 'other.apk' }] }),
      release('android/v0.5.0', { assets: [{ ...usable.assets[0], digest: null }] }),
      release('android/v0.4.0', {
        assets: [{ ...usable.assets[0], browser_download_url: 'http://example.test/a.apk' }],
      }),
      { tag_name: 'android/v1.0.0' },
      usable,
    ];
    expect(newestAndroidApk(releases)).toEqual(apkOf('0.3.5'));
  });

  it('finds none in an empty or unexpected answer', () => {
    expect(newestAndroidApk([])).toBeUndefined();
    expect(newestAndroidApk({ message: 'Not Found' })).toBeUndefined();
  });
});

describe('watching GitHub for the APK', () => {
  it('reads the releases at start, without credentials', async () => {
    const github = fakeGithub([release('android/v0.3.5')]);
    const watcher = watch(github);
    expect(watcher.current()).toBeUndefined();
    await watcher.ready;
    expect(watcher.current()).toEqual(apkOf('0.3.5'));
    expect(github.requests[0]?.url).toBe(
      `https://api.github.com/repos/${REPO}/releases?per_page=100`,
    );
    expect(github.requests[0]?.headers).not.toHaveProperty('Authorization');
  });

  it('follows a new release, and keeps the last APK while GitHub fails', async () => {
    const log: string[] = [];
    const github = fakeGithub(
      [release('android/v0.3.5')],
      503,
      [release('android/v0.3.6'), release('android/v0.3.5')],
      [],
    );
    const watcher = watch(github, log);
    await watcher.ready;
    await watcher.refresh();
    expect(watcher.current()).toEqual(apkOf('0.3.5'));
    await watcher.refresh();
    expect(watcher.current()).toEqual(apkOf('0.3.6'));
    // GitHub answering with no Android release means there is none: back to the store.
    await watcher.refresh();
    expect(watcher.current()).toBeUndefined();
    expect(log).toEqual([
      'android apk: 0.3.5',
      'android apk: reading GitHub failed (HTTP 503)',
      'android apk: 0.3.6',
      'android apk: none',
    ]);
  });
});
