import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sidecarBinaryPath } from '@sa/sidecar';
import type { Configuration, FileSet } from 'electron-builder';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CHROMIUM_DIR } from './src/main/browser/bundled';

async function loadConfig(env: Record<string, string> = {}): Promise<Configuration> {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return (await import('./electron-builder')).default;
}

const packageJson = (dir: string) =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, dir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };

describe('electron-builder config', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('copies sa-sidecar to where the packaged app looks for it', async () => {
    const [resource] = (await loadConfig()).extraResources as FileSet[];
    // beforePack builds into the development folder of the target: vendor/<platform>-<arch>.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder macros
    expect(resource.from).toBe('vendor/${platform}-${arch}');
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const binary = sidecarBinaryPath({
        packaged: true,
        resourcesPath: '/R',
        appPath: '/A',
        platform,
      });
      expect(resource.filter).toContain(path.basename(binary));
      expect(path.join('/R', resource.to ?? '', path.basename(binary))).toBe(binary);
    }
  });

  it('ships our licence and the third-party notices outside the ASAR', async () => {
    const resources = (await loadConfig()).extraResources as FileSet[];
    expect(resources).toContainEqual({ from: '../../LICENSE', to: 'LICENSE.txt' });
    expect(resources).toContainEqual({
      from: 'THIRD_PARTY_NOTICES.txt',
      to: 'THIRD_PARTY_NOTICES.txt',
    });
    expect(readFileSync(path.join(import.meta.dirname, '../../LICENSE'), 'utf8')).toMatch(
      /^MIT License/,
    );
  });

  it('ships the agent host with the packages it imports at runtime', async () => {
    const files = (await loadConfig()).files as (string | FileSet)[];
    expect(files).toContainEqual(
      expect.objectContaining({ to: 'agent-host', filter: expect.arrayContaining(['host.js']) }),
    );
    // Externals of packages/agent/scripts/build-host.mjs: they resolve from app.asar/node_modules.
    const agent = packageJson('../../packages/agent').dependencies;
    const desktop = packageJson('.').dependencies;
    for (const name of [
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
      'typebox',
      '@napi-rs/canvas',
    ])
      expect(desktop[name], name).toBe(agent[name]);
  });

  it('signs ad-hoc and skips notarization without a certificate', async () => {
    const config = await loadConfig({ CSC_LINK: '', CSC_NAME: '', SA_AZURE_SIGNING_ENDPOINT: '' });
    expect(config.mac).toMatchObject({ identity: '-', hardenedRuntime: false, notarize: false });
    expect(config.win).not.toHaveProperty('azureSignOptions');
  });

  it('uses the hardened runtime and notarizes with a Developer ID certificate', async () => {
    const config = await loadConfig({ CSC_LINK: '/secrets/developer-id.p12' });
    expect(config.mac).not.toHaveProperty('identity');
    expect(config.mac).toMatchObject({ hardenedRuntime: true, notarize: true });
  });

  it('signs Windows builds with Azure Artifact Signing when it is configured', async () => {
    const azure = {
      SA_AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
      SA_AZURE_SIGNING_PUBLISHER: 'Example S.L.',
      SA_AZURE_SIGNING_ACCOUNT: 'example',
    };
    await expect(loadConfig(azure)).rejects.toThrow(/SA_AZURE_SIGNING_PROFILE/);
    const config = await loadConfig({ ...azure, SA_AZURE_SIGNING_PROFILE: 'public' });
    expect(config.win).toMatchObject({
      azureSignOptions: {
        endpoint: azure.SA_AZURE_SIGNING_ENDPOINT,
        certificateProfileName: 'public',
      },
    });
  });

  it('ships the Chromium beforePack stages to where the packaged app looks for it', async () => {
    const resources = (await loadConfig()).extraResources as FileSet[];
    expect(resources).toContainEqual({
      from: `vendor/\${platform}-\${arch}/${BUNDLED_CHROMIUM_DIR}`,
      to: BUNDLED_CHROMIUM_DIR,
    });
  });

  it('builds the Microsoft Store package with its identity, versioned X.Y.Z.0', async () => {
    const config = await loadConfig();
    expect(config.win?.target).toEqual(['nsis', 'appx']);
    expect(config.appx).toMatchObject({
      identityName: '28203PabloCaballero.SpainAssist',
      publisher: 'CN=DC37CBF9-416F-4E91-807A-3F218DB76817',
      publisherDisplayName: 'Pablo Caballero',
      displayName: 'Spain Assist',
      capabilities: ['webcam', 'microphone'],
      languages: ['es-ES', 'en'],
      setBuildNumber: false,
    });
  });

  it('has every Store tile and logo, at scale 100 and 200', () => {
    const files = readdirSync(path.join(import.meta.dirname, 'packaging/appx'));
    for (const logo of ['StoreLogo', 'Square44x44Logo', 'Square150x150Logo', 'Wide310x150Logo'])
      for (const scale of [100, 200]) expect(files).toContain(`${logo}.scale-${scale}.png`);
  });
});
