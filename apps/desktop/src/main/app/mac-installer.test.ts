import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupInstaller,
  identifyInstaller,
  isSameInstaller,
  rememberInstaller,
} from './mac-installer';

const manifest = 'a'.repeat(64);
const image = (path: string, mount: string) => ({
  'image-path': path,
  'system-entities': [{ 'mount-point': mount }],
});
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const userData = await mkdtemp(join(tmpdir(), 'sa-installer-test-'));
  tempDirs.push(userData);
  const path = join(userData, 'renamed-download.dmg');
  await writeFile(path, 'download');
  await rememberInstaller(userData, { image: path, mount: '/Volumes/Spain Assist' }, manifest);
  const trash = vi.fn(async () => {});
  const detach = vi.fn(async () => {});
  const images = vi.fn(async () => [image(path, '/Volumes/Spain Assist')]);
  return {
    path,
    options: { userData, manifest: async () => manifest, images, detach, trash },
  };
}

describe('macOS installer identity and cleanup', () => {
  it('finds the exact signed build even when the running app is translocated', async () => {
    const images = [
      image('/Downloads/other.dmg', '/Volumes/Other'),
      image('/Downloads/renamed.dmg', '/Volumes/Spain Assist'),
    ];
    const read = vi.fn(async (path: string) =>
      path.includes('/Other/') ? 'b'.repeat(64) : manifest,
    );
    expect(
      await identifyInstaller(images, manifest, '/private/translocated/Spain Assist.app', read),
    ).toEqual({
      image: '/Downloads/renamed.dmg',
      mount: '/Volumes/Spain Assist',
    });
  });

  it('uses the running app volume when multiple DMGs contain the same signed build', async () => {
    const images = [
      image('/Desktop/test-v2.dmg', '/Volumes/Spain Assist'),
      image('/Desktop/test-v3.dmg', '/Volumes/Spain Assist 1'),
    ];
    expect(
      await identifyInstaller(
        images,
        manifest,
        '/Volumes/Spain Assist 1/Spain Assist.app',
        async () => manifest,
      ),
    ).toEqual({ image: '/Desktop/test-v3.dmg', mount: '/Volumes/Spain Assist 1' });
  });

  it('still checks the manifest of the running volume before recording it', async () => {
    expect(
      await identifyInstaller(
        [image('/Desktop/test.dmg', '/Volumes/Spain Assist')],
        manifest,
        '/Volumes/Spain Assist/Spain Assist.app',
        async () => 'b'.repeat(64),
      ),
    ).toBeUndefined();
  });

  it('never guesses between identical mounted builds or includes unrelated image types', async () => {
    const read = async () => manifest;
    expect(
      await identifyInstaller(
        [image('/a.dmg', '/Volumes/A'), image('/b.dmg', '/Volumes/B')],
        manifest,
        '/private/translocated/Spain Assist.app',
        read,
      ),
    ).toBeUndefined();
    expect(
      await identifyInstaller(
        [image('/a.sparseimage', '/Volumes/A'), image('/a.dmg', '/private/translocated')],
        manifest,
        undefined,
        read,
      ),
    ).toBeUndefined();
  });

  it('ejects before trashing exactly the recorded DMG, then consumes the marker', async () => {
    const { path, options } = await fixture();
    await cleanupInstaller(options);
    expect(options.detach).toHaveBeenCalledWith('/Volumes/Spain Assist');
    expect(options.trash).toHaveBeenCalledWith(path);
    expect(options.detach.mock.invocationCallOrder[0]).toBeLessThan(
      options.trash.mock.invocationCallOrder[0] ?? 0,
    );
    await cleanupInstaller(options);
    expect(options.trash).toHaveBeenCalledTimes(1);
  });

  it('handles an image already ejected by Electron', async () => {
    const { path, options } = await fixture();
    options.images.mockResolvedValue([]);
    await cleanupInstaller(options);
    expect(options.detach).not.toHaveBeenCalled();
    expect(options.trash).toHaveBeenCalledWith(path);
  });

  it('keeps the file if ejection fails and does not retry on future launches', async () => {
    const { options } = await fixture();
    options.detach.mockRejectedValue(new Error('Resource busy'));
    await expect(cleanupInstaller(options)).rejects.toThrow('Resource busy');
    expect(options.trash).not.toHaveBeenCalled();
    await cleanupInstaller(options);
    expect(options.detach).toHaveBeenCalledTimes(1);
  });

  it('does not eject a volume mounted at a different path', async () => {
    const { path, options } = await fixture();
    options.images.mockResolvedValue([image(path, '/Volumes/Another')]);
    await cleanupInstaller(options);
    expect(options.detach).not.toHaveBeenCalled();
    expect(options.trash).not.toHaveBeenCalled();
  });

  it('does not delete a changed file or clean up from another app build', async () => {
    const { path, options } = await fixture();
    await writeFile(path, 'replacement download');
    await cleanupInstaller(options);
    expect(options.trash).not.toHaveBeenCalled();
    const current = await stat(path);
    expect(
      isSameInstaller(
        { image: path, mount: '/Volumes/A', manifest, ...current },
        'b'.repeat(64),
        current,
      ),
    ).toBe(false);
  });

  it('does not repeat a denied Trash operation', async () => {
    const { options } = await fixture();
    options.trash.mockRejectedValue(new Error('Permission denied'));
    await expect(cleanupInstaller(options)).rejects.toThrow('Permission denied');
    await cleanupInstaller(options);
    expect(options.trash).toHaveBeenCalledTimes(1);
    await expect(
      readFile(join(options.userData, 'pending-mac-install.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rechecks the download after waiting for ejection', async () => {
    const { path, options } = await fixture();
    options.detach.mockImplementationOnce(async () => {
      await writeFile(path, 'a different file now occupies this path');
    });
    await cleanupInstaller(options);
    expect(options.trash).not.toHaveBeenCalled();
  });
});
