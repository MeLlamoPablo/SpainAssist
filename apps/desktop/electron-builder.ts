/**
 * electron-builder configuration (docs/research/electron-packaging.md §6.11).
 *
 *   corepack pnpm --filter @sa/desktop package       # installers for this OS and CPU
 *   corepack pnpm --filter @sa/desktop package:dir   # only the unpacked app, to check it
 *   corepack pnpm --filter @sa/desktop package:msix  # the Microsoft Store package (Windows x64)
 *
 * - Package on the OS and CPU you ship for (one CI runner each): native modules such as
 *   @napi-rs/canvas are installed for this machine only, so `beforePack` refuses other targets.
 * - `beforePack` builds sa-sidecar for the target with Go (`vendor/<platform>-<arch>/`), and
 *   `extraResources` copies it to `<resources>/vendor/`, where the app looks for it
 *   (`sidecarBinaryPath` in @sa/sidecar). It stays outside the ASAR, executable.
 * - `beforePack` also stages playwright-core's pinned Chromium (scripts/chromium.ts), which
 *   `extraResources` copies to `<resources>/chromium/`: every build bundles the agent's browser,
 *   and the app never downloads one (the Microsoft Store forbids it, policy 10.2.2).
 * - The agent host (`packages/agent/dist/host.js`) goes into app.asar as `agent-host/host.js`,
 *   next to the node_modules that hold its external imports (`dependencies`).
 * - Signing only happens when its environment variables are set. Without them, macOS builds are
 *   ad-hoc signed (no notarization: Gatekeeper warns once) and Windows builds are unsigned.
 * - Updates: `publish` points the app at this repo's GitHub Releases (electron-updater).
 *   The Microsoft Store package (`appx`) updates through the Store instead.
 * - Windows ships twice from one pack (`win.target`, release.yml): the NSIS installer on GitHub
 *   Releases and an MSIX for the Microsoft Store (the `appx` options; `package:msix` builds
 *   only the MSIX).
 * - Linux ships as a .deb, the only Linux target.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildSidecar } from '@sa/sidecar/build';
// The beforePack context has the same type as afterPack's (`PackContext`, not exported).
import { type AfterPackContext, Arch, type Configuration } from 'electron-builder';
import { stageChromium } from './scripts/chromium';
import { BUNDLED_CHROMIUM_DIR } from './src/main/browser/bundled';

const env = process.env;

/**
 * macOS: a Developer ID Application certificate, as a .p12 (`CSC_LINK` + `CSC_KEY_PASSWORD`) or
 * a keychain identity (`CSC_NAME`). Notarization then runs when the notarytool variables are set
 * too: `APPLE_API_KEY` (path of the .p8) + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`, or
 * `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
 */
const macSigning = !!(env.CSC_LINK || env.CSC_NAME);

/**
 * Windows: Azure Artifact Signing when `SA_AZURE_SIGNING_ENDPOINT` is set (Entra ID auth from
 * `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`). Otherwise electron-builder signs
 * with a .pfx in `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` when present, and skips signing without.
 */
function azureSignOptions() {
  const endpoint = env.SA_AZURE_SIGNING_ENDPOINT;
  if (!endpoint) return undefined;
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} must be set with SA_AZURE_SIGNING_ENDPOINT`);
    return value;
  };
  return {
    endpoint,
    publisherName: required('SA_AZURE_SIGNING_PUBLISHER'),
    codeSigningAccountName: required('SA_AZURE_SIGNING_ACCOUNT'),
    certificateProfileName: required('SA_AZURE_SIGNING_PROFILE'),
  };
}
const azure = azureSignOptions();

/** The agent host bundle (`corepack pnpm --filter @sa/agent build`), relative to apps/desktop. */
const AGENT_HOST_DIR = '../../packages/agent/dist';

/** Written by `scripts/package.mjs` (scripts/notices.ts) before electron-builder runs. */
const NOTICES = 'THIRD_PARTY_NOTICES.txt';

async function beforePack(context: AfterPackContext): Promise<void> {
  const platform = context.electronPlatformName as NodeJS.Platform;
  const arch = Arch[context.arch];
  if (platform !== process.platform || arch !== process.arch)
    throw new Error(
      `Package ${platform}-${arch} on a ${platform}-${arch} machine: native modules are installed ` +
        `for this one (${process.platform}-${process.arch}) only.`,
    );
  const projectDir = context.packager.projectDir;
  if (!existsSync(path.join(projectDir, AGENT_HOST_DIR, 'host.js')))
    throw new Error('The agent host is not built: run "corepack pnpm --filter @sa/agent build".');
  // A missing extraResources source is only a warning: never ship without the notices.
  if (!existsSync(path.join(projectDir, NOTICES)))
    throw new Error(`${NOTICES} is missing: package with the package* scripts, which write it.`);
  try {
    await buildSidecar({ outDir: path.join(projectDir, 'vendor'), platform, arch });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(
      e.code === 'ENOENT'
        ? 'Packaging needs Go 1.19+ to build sa-sidecar (https://go.dev/dl).'
        : `sa-sidecar did not build: ${e.stderr || e.message}`,
    );
  }
  stageChromium(path.join(projectDir, 'vendor', `${platform}-${arch}`, BUNDLED_CHROMIUM_DIR));
}

/** Microsoft Store identity of the app (Partner Center, Store ID 9ND5MF94VKGC). */
const STORE_IDENTITY = {
  identityName: '28203PabloCaballero.SpainAssist',
  publisher: 'CN=DC37CBF9-416F-4E91-807A-3F218DB76817',
  publisherDisplayName: 'Pablo Caballero',
};

const config: Configuration = {
  appId: 'es.spainassist.desktop',
  productName: 'Spain Assist',
  copyright: 'Copyright © 2026 Pablo Rodríguez Caballero',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder macros
  artifactName: 'SpainAssist-${os}-${arch}.${ext}',
  directories: { buildResources: 'packaging', output: 'dist' },
  files: [
    'out/**',
    '!out/**/*.map',
    {
      from: AGENT_HOST_DIR,
      to: 'agent-host',
      filter: ['host.js', 'host.js.LEGAL.txt', 'package.json'],
    },
  ],
  extraResources: [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder macros
    { from: 'vendor/${platform}-${arch}', to: 'vendor', filter: ['sa-sidecar', 'sa-sidecar.exe'] },
    // The agent's browser, staged by beforePack (scripts/chromium.ts, src/main/browser/bundled.ts).
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder macros
    { from: 'vendor/${platform}-${arch}/chromium', to: BUNDLED_CHROMIUM_DIR },
    // Outside the ASAR, so users can read them. electron-builder adds Electron's
    // LICENSE.electron.txt and Chromium's LICENSES.chromium.html (in Resources on macOS).
    { from: '../../LICENSE', to: 'LICENSE.txt' },
    { from: NOTICES, to: NOTICES },
    {
      from: 'packaging/installer',
      to: 'installer',
      filter: ['progress.html', 'serif.ttf', 'inter.woff2', 'icon.png'],
    },
  ],
  asar: true,
  // With a macOS certificate, fail rather than skip signing when its identity isn't found
  // (electron-builder only warns). Windows CI never sets the macOS variables.
  forceCodeSigning: macSigning,
  // Fail when a production dependency can't be collected, instead of shipping without it.
  allowMissingDependencies: false,
  // The UI is in Spanish and English: drop Chromium's other locales.
  electronLanguages: ['en', 'es'],
  beforePack,
  electronFuses: {
    // The agent host runs this binary as Node (ELECTRON_RUN_AS_NODE). Turn it off when the host
    // moves to utilityProcess.
    runAsNode: true,
    enableCookieEncryption: true,
    // Also gates NODE_EXTRA_CA_CERTS, which the agent host inherits behind corporate proxies.
    // Turn it off together with runAsNode.
    enableNodeOptionsEnvironmentVariable: true,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    // The renderer is served from app://, not file://.
    grantFileProtocolExtraPrivileges: false,
  },
  // Where updates come from: written into the app as `app-update.yml` and used for the
  // `latest*.yml` update files next to the installers. CI uploads them to the release itself
  // (`--publish never`, .github/workflows/release.yml). Windows, macOS (from the zip, signed
  // releases only) and the Linux .deb update themselves.
  publish: { provider: 'github', owner: 'MeLlamoPablo', repo: 'SpainAssist' },
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.productivity',
    // Without a certificate: ad-hoc, which Apple Silicon needs to run the app at all. The hardened
    // runtime needs a real identity (library validation would reject Electron's frameworks).
    ...(macSigning ? {} : { identity: '-' }),
    hardenedRuntime: macSigning,
    notarize: macSigning,
    // Every nested binary (Electron helpers, native modules, sa-sidecar) gets the inherit file.
    entitlements: 'packaging/entitlements.mac.plist',
    entitlementsInherit: 'packaging/entitlements.mac.inherit.plist',
    extendInfo: {
      NSCameraUsageDescription: 'Spain Assist usa la cámara para escanear tus documentos.',
      NSMicrophoneUsageDescription:
        'Spain Assist usa el micrófono para grabar las llamadas que tú le pidas.',
    },
  },
  dmg: {
    title: 'Spain Assist',
    background: 'packaging/installer/background.tiff',
    window: { width: 720, height: 442 },
    iconSize: 112,
    iconTextSize: 14,
    // A single real Finder item. Opening it installs and relaunches the app automatically.
    contents: [{ x: 360, y: 260, type: 'file' }],
  },
  win: {
    // NSIS for GitHub Releases, appx for the Store. `package:msix` builds only the appx.
    target: ['nsis', 'appx'],
    ...(azure ? { azureSignOptions: azure } : {}),
  },
  // The Microsoft Store package. The Store signs it on submission, so CI leaves it unsigned
  // (Azure signing would sign it too, with a publisher that doesn't match, and fail); a local
  // test build needs a certificate whose subject is `publisher` (sideloading). Tiles: packaging/appx/
  // (packaging/render-icon.mjs). The Store updates it, and uninstalling it removes its data.
  appx: {
    ...STORE_IDENTITY,
    applicationId: 'SpainAssist',
    displayName: 'Spain Assist',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder macros
    artifactName: 'SpainAssist-${os}-${arch}.msix',
    // runFullTrust is always added. The scanner uses the camera; call recordings the microphone.
    capabilities: ['webcam', 'microphone'],
    languages: ['es-ES', 'en'],
    backgroundColor: 'transparent',
    // Version X.Y.Z.0: the Store reserves the fourth part, so never take CI's build number.
    setBuildNumber: false,
  },
  // A .deb only: no AppImage, snap or apt repository. Installed apps update themselves from
  // `latest-linux.yml`: electron-builder writes `package-type` (`deb`) next to
  // `app-update.yml`, and the .deb's after-install script sets up chrome-sandbox and, on
  // Ubuntu 24+, an AppArmor profile for it.
  linux: {
    target: ['deb'],
    category: 'Office',
    executableName: 'spain-assist',
    synopsis: 'Tu ayuda con los trámites en España',
    // Published in every .deb's control file (Maintainer, Vendor).
    maintainer: 'Pablo Rodríguez Caballero <pablo@rodriguezcaballero.me>',
    vendor: 'Spain Assist',
  },
  deb: { packageName: 'spain-assist' },
};

export default config;
