import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import {
  type AppInfo,
  FEATURES_OFF,
  PRODUCTION_SERVICES,
  SA_EVENT_CHANNEL,
  SA_INVOKE_CHANNEL,
  setExtraTrustedHosts,
} from '@sa/shared';
import { Sidecar, sidecarBinaryPath } from '@sa/sidecar';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  type Session,
  safeStorage,
  session,
  shell,
  systemPreferences,
} from 'electron';
import type { AppUpdater } from 'electron-updater';
import { z } from 'zod';
import { type CameraAccess, SCANNER_CHANNEL } from '../scanner';
import { resolveAgentHostScript } from './agents/host';
import { parseEnv } from './app/env';
import {
  agentLib,
  browserFactory,
  certificateOrigins,
  ensureBrowser,
  openVault,
  piiLib,
  providerLib,
  signerLib,
  testKeyProvider,
} from './app/libs';
import { createAppPaths } from './app/paths';
import {
  APP_ENTRY_URL,
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  createAppProtocolHandler,
  isAppUrl,
} from './app/protocol';
import { createMainServices, type MainServices } from './app/services';
import { ensurePrivateDir } from './core/fs';
import { createLogger, type Logger } from './core/logger';
import { errorMessage } from './core/util';
import { catastro } from './places/catastro';
import { noBiometric } from './ports';
import { featuresFromNames, loadFeatureFlags } from './remote/flags';
import { createCameraRequester, logCameraEvent } from './scanner/camera';
import { OpenRouterFrameGate } from './scanner/decider';
import { DocumentScanner } from './scanner/service';
import { prepareScanStorage } from './scanner/transcript';
import { languageForLocales } from './settings/store';
import { createUpdates, updatesSupported } from './updates/updater';
import { createSafeStorageKeyProvider, createTouchIdBiometric } from './vault/keyProvider';

// ---------------------------------------------------------------------------------------------
// Before `ready`: environment, paths, privileged scheme, single instance.
// ---------------------------------------------------------------------------------------------

const isDev = !app.isPackaged;
// Launch Services does not inherit the terminal environment. Receive it privately,
// before reading configuration; API keys must never appear in launcher arguments.
// The launcher keeps the socket open while it lives: quit when it closes, so a killed
// launcher never leaves this app running under launchd.
const launchSocket = process.argv.find((arg) => arg.startsWith('--sa-dev-launch-socket='));
if (isDev && launchSocket) {
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(launchSocket.slice('--sa-dev-launch-socket='.length));
    let received = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('Dev launcher timed out')));
    socket.on('data', (chunk) => {
      received += chunk;
      const end = received.indexOf('\n');
      if (end === -1) return;
      socket.setTimeout(0);
      resolve(received.slice(0, end));
    });
    socket.on('error', reject);
    socket.on('close', () => {
      reject(new Error('Dev launcher stopped'));
      app.quit();
    });
  });
  Object.assign(process.env, z.record(z.string(), z.string()).parse(JSON.parse(raw)));
}
// The macOS dev launcher needs the native PID to stop/restart the Launch Services app.
if (isDev && process.env.SA_DEV_LAUNCH_PID_FILE)
  writeFileSync(process.env.SA_DEV_LAUNCH_PID_FILE, String(process.pid), { mode: 0o600 });
// Dev builds: local service keys from apps/desktop/.env. Variables already set win.
if (isDev) {
  try {
    process.loadEnvFile(join(app.getAppPath(), '.env'));
  } catch {
    // No .env: fine.
  }
}
const env = parseEnv(process.env, { packaged: app.isPackaged });
const devUrl = isDev ? process.env.ELECTRON_RENDERER_URL : undefined;
// Packaged builds carry the icon electron-builder makes from this PNG; dev runs Electron's binary.
const devIcon = isDev ? join(app.getAppPath(), 'packaging/icon.png') : undefined;

// Internal name (also the macOS safeStorage keychain item and the userData folder): renaming it
// would orphan existing vaults. UI-facing copy uses "Spain Assist".
app.setName('SpainAssistant');
app.setPath(
  'userData',
  env.userDataDir ? resolve(env.userDataDir) : join(app.getPath('appData'), 'SpainAssistant'),
);
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);

let services: MainServices | undefined;
let logger: (Logger & { close(): void }) | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;

const gotLock = env.e2e || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(main, fatal);
}

function fatal(err: unknown): void {
  logger?.error('startup failed', { error: errorMessage(err) });
  dialog.showErrorBox(
    'Spain Assist',
    `No se ha podido iniciar la aplicación.\n\n${errorMessage(err)}`,
  );
  app.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------------------------

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Spain Assist',
    icon: devIcon,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#faf9f7',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      // A hidden window would otherwise throttle timers and rendering.
      backgroundThrottling: !env.hideWindow,
    },
  });
  // Electron's default File/Edit/View/Window bar means nothing to this app. macOS keeps it, in
  // the system menu bar, for the standard shortcuts (copy, paste, quit).
  if (process.platform !== 'darwin') win.removeMenu();
  // For the onboarding, the window opens invisible and click-through: the renderer draws (and
  // warms the GPU up) and calls `app.reveal` once it can run without stalls.
  if (!env.hideWindow)
    win.once('ready-to-show', () => {
      if (revealed.has(win) || services?.settings.get().onboardingCompleted) return win.show();
      waiting.add(win);
      win.setOpacity(0);
      win.setIgnoreMouseEvents(true);
      win.showInactive();
      setTimeout(() => revealWindow(win), REVEAL_TIMEOUT_MS);
    });
  // The app window never navigates away or opens windows; external https links go to the OS.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', (_e, details) =>
    logger?.error('renderer process gone', { reason: details.reason }),
  );
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  void win.loadURL(devUrl ?? APP_ENTRY_URL);
  return win;
}

/** Windows the renderer has asked to show. */
const revealed = new WeakSet<BrowserWindow>();
/** Windows open but invisible, waiting for `app.reveal`. */
const waiting = new WeakSet<BrowserWindow>();
/** Shows the window even if the renderer never asks (it warms up for at most 5 s). */
const REVEAL_TIMEOUT_MS = 7000;

function revealWindow(win: BrowserWindow | undefined): void {
  if (!win || win.isDestroyed() || revealed.has(win)) return;
  revealed.add(win);
  // Not shown yet: 'ready-to-show' shows it as usual.
  if (!waiting.has(win)) return;
  waiting.delete(win);
  win.setOpacity(1);
  win.setIgnoreMouseEvents(false);
  win.show();
}

function restrictPermissions(
  ses: Session,
  requestCamera: () => Promise<CameraAccess>,
  requestMicrophone: () => Promise<CameraAccess>,
): void {
  // Camera (document scanning), microphone (recording phone calls) and clipboard writes for the
  // app's own page; nothing else. One device per request: never camera and microphone at once.
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (!isAppUrl(details.requestingUrl, devUrl)) {
      if (permission === 'media') logger?.warn('camera permission rejected: untrusted page');
      return callback(false);
    }
    if (permission === 'media') {
      const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
      logger?.info('media browser permission requested', { mediaTypes: types });
      const device = types.every((t) => t === 'video')
        ? 'camera'
        : types.every((t) => t === 'audio')
          ? 'microphone'
          : undefined;
      if (!device) return callback(false);
      if (process.platform === 'darwin' && !env.e2e) {
        void (device === 'camera' ? requestCamera() : requestMicrophone()).then(
          (access) => callback(access.granted),
          () => callback(false),
        );
        return;
      }
      return callback(true);
    }
    callback(permission === 'clipboard-sanitized-write');
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (!isAppUrl(`${origin}/`, devUrl) && !isAppUrl(origin, devUrl)) {
      if (permission === 'media')
        logger?.warn('camera permission check rejected: untrusted origin');
      return false;
    }
    return permission === 'media' || permission === 'clipboard-sanitized-write';
  });
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const paths = createAppPaths(app.getPath('userData'));
  await ensurePrivateDir(paths.userData);
  logger = createLogger({
    dir: paths.logsDir,
    level: env.logLevel ?? (isDev ? 'debug' : 'info'),
    console: isDev && !env.e2e,
  });
  const log = logger;
  for (const warning of env.warnings) log.warn(warning);
  log.info('starting', { version: app.getVersion(), e2e: env.e2e, dev: isDev });
  if (process.platform === 'darwin' && !env.e2e)
    log.info('camera OS permission at startup', {
      status: systemPreferences.getMediaAccessStatus('camera'),
    });

  // Asked once per launch, in parallel with the rest of startup: flag changes apply on restart.
  const features = env.featureFlags
    ? Promise.resolve(featuresFromNames(env.featureFlags))
    : env.e2e
      ? Promise.resolve(FEATURES_OFF)
      : loadFeatureFlags({
          fetch,
          url: PRODUCTION_SERVICES.flagsUrl,
          token: env.flagsToken,
          appName: 'desktop',
          appVersion: app.getVersion(),
          logger: log,
        });

  setExtraTrustedHosts(env.extraTrustedHosts);

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  const requestCamera = createCameraRequester(
    systemPreferences,
    log,
    process.platform === 'darwin' && !env.e2e,
  );
  const requestMicrophone = createCameraRequester(
    systemPreferences,
    log,
    process.platform === 'darwin' && !env.e2e,
    'microphone',
  );
  restrictPermissions(session.defaultSession, requestCamera, requestMicrophone);
  // Identify the desktop client to OSM, as its tile policy asks; HTTP caching stays enabled.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://tile.openstreetmap.org/*'] },
    (details, callback) =>
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          'User-Agent': `SpainAssist/${app.getVersion()} (Electron desktop)`,
        },
      }),
  );

  const keyProvider = env.e2e
    ? testKeyProvider(log)
    : await createSafeStorageKeyProvider(safeStorage, process.platform, log);
  const biometric = env.e2e
    ? noBiometric
    : createTouchIdBiometric(systemPreferences, process.platform, log);

  let hostScript: string | undefined;
  const appInfo: AppInfo = {
    name: 'Spain Assist',
    version: app.getVersion(),
    platform: process.platform as AppInfo['platform'],
    isDev,
    isE2E: env.e2e,
    features: await features,
  };
  log.info('feature flags', appInfo.features);

  const updatesLog = log.child('updates');
  const updates = createUpdates({
    backend: updatesSupported({
      packaged: app.isPackaged,
      platform: process.platform,
      e2e: env.e2e,
      linuxPackageType: await linuxPackageType(),
    })
      ? await loadAutoUpdater(updatesLog)
      : undefined,
    logger: updatesLog,
    urgent: appInfo.features.mustUpdate,
  });

  services = await createMainServices({
    env,
    paths,
    documentDownloadsDir: env.e2e
      ? join(paths.userData, 'exported-downloads')
      : app.getPath('downloads'),
    // e2e runs stay in Spanish whatever the machine's language.
    systemLanguage: env.e2e ? undefined : languageForLocales(app.getPreferredSystemLanguages()),
    logger: log,
    appInfo,
    updates,
    keyProvider,
    biometric,
    openVault: (dir, keys) => openVault(dir, keys, log),
    agentLib,
    providerLib: providerLib(fetch),
    browserFactory,
    startSidecar: () =>
      Sidecar.start({
        binaryPath: sidecarBinaryPath({
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath(),
        }),
        logger: log.child('sidecar'),
        ...(env.e2e ? { insecureUpstream: true } : {}),
      }),
    ensureBrowser,
    certificateOrigins,
    signer: signerLib,
    pii: piiLib,
    fetch,
    signerFetch: net.fetch as unknown as typeof fetch,
    openExternal: async (url) => {
      if (!url.startsWith('https://')) throw new Error('Only https URLs can be opened');
      await shell.openExternal(url);
    },
    revealWindow: () => revealWindow(mainWindow),
    openPath: (path) => shell.openPath(path),
    relaunch: () => {
      app.relaunch();
      app.exit(0);
    },
    hostScript: () => {
      hostScript ??= resolveAgentHostScript({
        override: env.agentHost,
        fromUrl: import.meta.url,
        appPath: app.getAppPath(),
      });
      return hostScript;
    },
    nodeBinary: process.execPath,
    electronRunAsNode: true,
    isTrustedSender: (ctx) => ctx.isMainFrame && isAppUrl(ctx.senderUrl, devUrl),
  });
  const s = services;

  if (!devUrl) {
    protocol.handle(
      APP_SCHEME,
      createAppProtocolHandler(join(import.meta.dirname, '../renderer'), (url) => net.fetch(url)),
    );
  }

  ipcMain.handle(SA_INVOKE_CHANNEL, (event, method: unknown, ...args: unknown[]) => {
    const frame = event.senderFrame;
    return s.router.dispatch(method, args, {
      senderUrl: frame?.url,
      isMainFrame:
        !!frame && frame.parent === null && !!mainWindow && event.sender === mainWindow.webContents,
    });
  });
  const scanner = new DocumentScanner(
    s.providers,
    () => s.settings.get().language,
    await prepareScanStorage(paths.scanTranscriptsDir, isDev),
    // The user key (voucher, ChatGPT or Codex development key, D12); the dev .env key overrides.
    new OpenRouterFrameGate({
      apiKey: env.deciderApiKey,
      endpoint: env.deciderUrl,
      access: () => s.providers.scanGateAccess(),
    }),
    env.e2e
      ? undefined
      : (fields, signal) =>
          catastro.postalCode(
            fields,
            signal,
            isDev ? (result) => log.info('scanner postal code lookup', result) : undefined,
          ),
    log,
  );
  mainWindow?.on('closed', () => void scanner.cancel());
  mainWindow?.webContents.on('did-start-navigation', () => void scanner.cancel());
  app.on('before-quit', () => void scanner.cancel());
  ipcMain.handle(SCANNER_CHANNEL, (event, method: unknown, input: unknown) => {
    const frame = event.senderFrame;
    if (
      !frame ||
      frame.parent !== null ||
      event.sender !== mainWindow?.webContents ||
      !isAppUrl(frame.url, devUrl)
    )
      throw new Error('Forbidden');
    if (method === 'requestCamera') return requestCamera();
    if (method === 'openCameraSettings') {
      if (process.platform === 'darwin' && !env.e2e)
        return shell.openExternal(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
        );
      return;
    }
    if (method === 'cameraEvent') {
      const cameraEvent = z
        .object({
          stage: z.enum(['starting', 'ready', 'failed', 'timeout']),
          errorName: z
            .string()
            .regex(/^[A-Za-z]+Error$/)
            .max(60)
            .optional(),
        })
        .strict()
        .parse(input);
      logCameraEvent(log, cameraEvent);
      return;
    }
    if (method === 'start')
      return scanner.start(input, (update) => {
        if (!event.sender.isDestroyed()) event.sender.send('sa:scanner:event', update);
      });
    if (method === 'frames') return scanner.frames(input);
    if (method === 'cancel') return scanner.cancel(input);
    if (method === 'status') return scanner.status();
    if (method === 'read') return scanner.read(input);
    throw new Error('Unknown scanner method');
  });
  s.events.on((event) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send(SA_EVENT_CHANNEL, event);
  });

  if (env.hideWindow) app.dock?.hide();
  else if (devIcon) app.dock?.setIcon(devIcon);
  mainWindow = createWindow();
  app.on('activate', () => {
    if (!mainWindow) mainWindow = createWindow();
  });
  updates.start();
  app.on('before-quit', () => updates.stop());
  log.info('ready', { bridge: 'listening', methods: s.router.methods().length });
}

/**
 * How a packaged Linux app was installed: electron-builder writes `deb` (or `rpm`, `pacman`) to
 * `<resources>/package-type` for those packages, and electron-updater picks its updater from it.
 */
async function linuxPackageType(): Promise<string | undefined> {
  if (process.platform !== 'linux' || !app.isPackaged) return undefined;
  return readFile(join(process.resourcesPath, 'package-type'), 'utf8').then(
    (type) => type.trim(),
    () => undefined,
  );
}

/**
 * electron-updater, loaded only where the app updates itself; its own log goes to ours. When it
 * can't load, the app runs without updates instead of failing to start.
 */
async function loadAutoUpdater(log: Logger) {
  let autoUpdater: AppUpdater;
  try {
    autoUpdater = (await import('electron-updater')).default.autoUpdater;
  } catch (err) {
    log.error('updates unavailable: electron-updater did not load', { error: errorMessage(err) });
    return undefined;
  }
  autoUpdater.logger = {
    debug: (message: unknown) => log.debug(String(message)),
    info: (message: unknown) => log.debug(String(message)),
    warn: (message: unknown) => log.warn(String(message)),
    error: (message: unknown) => log.warn(String(message)),
  };
  return autoUpdater;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitting || !services) return;
  event.preventDefault();
  quitting = true;
  const s = services;
  void s
    .shutdown()
    .catch((err) => logger?.error('shutdown failed', { error: errorMessage(err) }))
    .finally(() => {
      logger?.info('bye');
      logger?.close();
      app.quit();
    });
});
