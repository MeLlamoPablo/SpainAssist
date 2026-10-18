import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AppInfo,
  FEATURES_OFF,
  type FeatureFlags,
  type Language,
  PRODUCTION_SERVICES,
  type SaArgs,
  type SaEvent,
  type SaMethod,
  type SaResult,
  setExtraTrustedHosts,
} from '@sa/shared';
import { createTestKeyProvider, type KeyProvider } from '@sa/vault';
import { resolveAgentHostScript } from '../agents/host';
import { ensurePrivateDir } from '../core/fs';
import { createLogger, type Logger } from '../core/logger';
import type { Clock, IdFactory } from '../core/util';
import {
  type AgentLib,
  type BrowserFactory,
  noBiometric,
  type ProviderLib,
  type VaultPort,
} from '../ports';
import type { FetchFn } from '../remote/http';
import { devCodexLib } from './codex-dev';
import type { SaEnv } from './env';
import {
  certificateOrigins,
  openVault,
  piiLib,
  agentLib as realAgentLib,
  browserFactory as realBrowserFactory,
  providerLib as realProviderLib,
  signerLib,
} from './libs';
import { type AppPaths, createAppPaths } from './paths';
import { createMainServices, type MainDeps, type MainServices } from './services';

/**
 * The app without Electron: the real main-process services (`createMainServices`: agents, bridge,
 * procedures, vault, browser, prompts, providers...) in plain Node, with no window. The first
 * user is the eval suite (`tools/eval`, docs/EVAL.md), which plays the user through `invoke`
 * and `on`; any tool or test that needs the real app logic can use it too. It is not part of the
 * packaged app: `index.ts` does not import it.
 *
 * Everything the Electron entry reads from the OS or the environment is explicit here, and
 * nothing is read from `process.env`: never call `parseEnv` for it (it fills in the production
 * services). The defaults are offline and local:
 *  - `env.e2e` is on, which makes the browser headless, lets it accept invalid certificates and
 *    keeps it from downloading Chromium, and leaves the maps and relay services undefined;
 *  - no key server, feedback server, maps or relay URL (a production URL is refused);
 *  - every feature flag off, no Touch ID, the insecure test key provider, no updates;
 *  - `fetch` (the backends' HTTP) fails, and there is no map lookup, sidecar or signer fetch.
 */

/** The page the app's own renderer lives at: the only sender `invoke` calls come from. */
const HEADLESS_PAGE = 'app://bundle/index.html';

export interface HeadlessOptions {
  /** The profile directory (the app's userData): created if missing, reopened if it has data. */
  userDataDir: string;
  /**
   * Root of the private scratch directory (`paths.tmpDir`, removed by `close`). Default: the OS
   * temporary directory. Do not change `TMPDIR` for it: a long path breaks tsx's IPC socket.
   */
  tmpRoot?: string;
  /** Where "save to my computer" exports go. Default `<userDataDir>/exported-downloads`. */
  documentDownloadsDir?: string;
  /**
   * Overrides of the environment defaults (see the module comment), as `SaEnv`. URLs given here
   * must not be the production services'.
   */
  env?: Partial<SaEnv>;
  /** Default: every flag off. */
  features?: Partial<FeatureFlags>;
  /** Language of a profile that has none stored yet. Default Spanish. */
  language?: Language;
  /**
   * Seed of the vault's key provider. A vault directory opens with the seed it was made with,
   * wherever it is copied to. Default `sa-headless`.
   */
  keySeed?: string;
  /**
   * Overrides of the real provider functions (`app/libs.ts`), by name: stub the voucher calls
   * (`redeemVoucher`, `getVoucherCredit`), the models, or the Codex login. The defaults are the
   * real ones with the development-only Codex login, and reach the network only when their flow
   * runs (a sign-in, a voucher, a refresh).
   */
  providerLib?: Partial<ProviderLib>;
  /** Wrap `buildAgentLaunch` to patch the config or add environment, and the client to tee events. */
  agentLib?: AgentLib;
  /** Wrap the real one to change Chromium's options (network mapping, timeouts). */
  browserFactory?: BrowserFactory;
  /** HTTP of the main-process backends (feedback, voucher probing). Default: always fails. */
  fetch?: FetchFn;
  /** Address lookups for map forms. Default none: lookups are unavailable. */
  places?: MainDeps['places'];
  /**
   * The agent host script (default `env.agentHost`, else `@sa/agent`'s `dist/host.js`, built with
   * its `build` script): the eval's own host entry goes here.
   */
  hostScript?: string;
  /** Start the TLS sidecar for client-certificate logins (needs the Go binary). Default none. */
  startSidecar?: MainDeps['startSidecar'];
  /** Default: a logger writing `<logsDir>/main.log` at debug level, closed by `close`. */
  logger?: Logger;
  /** Where the default logger writes `main.log`. Default `<userDataDir>/logs`. */
  logsDir?: string;
  /**
   * Opens the vault, with the key provider the app made from `keySeed` (default: `Vault.open`).
   * Wrap or replace it to give the vault a clock, or to keep some secrets out of the profile
   * directory; the eval suite does both.
   */
  openVault?: (dir: string, keys: KeyProvider) => Promise<VaultPort>;
  /**
   * Record each procedure's browsing under `procedures/<id>/capture/` (HAR, trace, HTML), as
   * development builds do with SA_BROWSER_CAPTURE: personal data stays, typed secrets are scrubbed.
   */
  capture?: boolean;
  /** Time and ids, for reproducible runs (ids must look like `p_` plus 16 hex digits). */
  clock?: Clock;
  ids?: IdFactory;
  /** Idle agents stop after this many ms (default 10 minutes); they resume from their session. */
  idleMs?: number;
  /** `appInfo.version`. */
  version?: string;
}

export interface HeadlessApp {
  /** The wired services, for what the renderer API does not cover (observing, forcing). */
  services: MainServices;
  paths: AppPaths;
  /** The logger of the app: register secrets with `addSecret` so they are masked everywhere. */
  logger: Logger;
  /** The renderer API (`window.sa.invoke`): same methods, same zod validation, same sender checks. */
  invoke<M extends SaMethod>(method: M, ...args: SaArgs<M>): Promise<SaResult<M>>;
  /** The renderer's push events (`window.sa.on`). Returns the unsubscribe function. */
  on(listener: (event: SaEvent) => void): () => void;
  /**
   * Shuts the services down (agents, browsers, bridge; pending forms and phone calls stay in the
   * transcripts, the rest is cancelled), flushes what is written lazily and removes the scratch
   * directory. The profile directory stays: copy it to snapshot, reopen it to restore. Safe to
   * call twice.
   */
  close(): Promise<void>;
}

const PRODUCTION_HOSTS: ReadonlySet<string> = new Set(
  [
    PRODUCTION_SERVICES.keyServerUrl,
    PRODUCTION_SERVICES.feedbackServerUrl,
    PRODUCTION_SERVICES.mapsServerUrl,
    PRODUCTION_SERVICES.relayServerUrl,
    PRODUCTION_SERVICES.flagsUrl,
  ].map((url) => new URL(url).host),
);

/** The result of `parseEnv` on a normal environment would put these in: fail instead. */
function refuseProductionServices(env: SaEnv): void {
  const urls = {
    keyServerUrl: env.keyServerUrl,
    feedbackServerUrl: env.feedbackServerUrl,
    mapsServerUrl: env.mapsServerUrl,
    relayServerUrl: env.relayServerUrl,
    deciderUrl: env.deciderUrl,
  };
  for (const [name, url] of Object.entries(urls)) {
    if (url && PRODUCTION_HOSTS.has(new URL(url).host)) {
      throw new Error(
        `createHeadlessApp: env.${name} is a production service (${new URL(url).host}). Pass an explicit test or loopback URL, and build the environment by hand instead of parseEnv().`,
      );
    }
  }
}

const offlineFetch: FetchFn = async () => {
  throw new TypeError('fetch failed');
};

/**
 * What the loopback listener of a ChatGPT sign-in would show. Nothing opens a browser here, so
 * these are plain documents, not the app's designed pages (`providers/login-pages.ts`).
 */
const LOGIN_PAGES = {
  success: page('Listo. Ya puedes cerrar esta ventana.'),
  failure: page('No se pudo conectar. Vuelve a Spain Assist e inténtalo de nuevo.'),
  notFound: page('Esta dirección no es parte del inicio de sesión.'),
};

function page(text: string): string {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><title>Spain Assist</title><p>${text}</p></html>`;
}

function openLogger(
  opts: HeadlessOptions,
  paths: AppPaths,
  env: SaEnv,
): { logger: Logger; close(): void } {
  if (opts.logger) return { logger: opts.logger, close: () => {} };
  const logger = createLogger({
    dir: opts.logsDir ?? paths.logsDir,
    level: env.logLevel ?? 'debug',
  });
  return { logger, close: () => logger.close() };
}

export async function createHeadlessApp(opts: HeadlessOptions): Promise<HeadlessApp> {
  const userData = resolve(opts.userDataDir);
  const paths = createAppPaths(userData, opts.tmpRoot ?? tmpdir());
  const env: SaEnv = {
    e2e: true,
    browserHeadless: true,
    flagsToken: '',
    extraTrustedHosts: [],
    warnings: [],
    ...(opts.capture ? { browserCapture: true } : {}),
    ...opts.env,
  };
  refuseProductionServices(env);
  const appInfo: AppInfo = {
    name: 'Spain Assist',
    version: opts.version ?? '0.0.0-headless',
    platform: process.platform as AppInfo['platform'],
    installChannel: 'dev',
    // Only development builds may record browsing (see the capture option).
    isDev: !!opts.capture,
    isE2E: true,
    features: { ...FEATURES_OFF, ...opts.features },
    errorReports: false,
  };

  await ensurePrivateDir(userData);
  const { logger, close: closeLogger } = openLogger(opts, paths, env);

  // Process-global, as in the app: concurrent apps in one process must agree on it.
  setExtraTrustedHosts(env.extraTrustedHosts);

  // apps/desktop: the app path, from which @sa/agent resolves.
  const appDir = fileURLToPath(new URL('../../..', import.meta.url));
  let resolvedHostScript: string | undefined;
  let services: MainServices;
  try {
    services = await createMainServices({
      env,
      paths,
      documentDownloadsDir: opts.documentDownloadsDir ?? join(userData, 'exported-downloads'),
      systemLanguage: opts.language ?? 'es',
      logger,
      appInfo,
      keyProvider: createTestKeyProvider(opts.keySeed ?? 'sa-headless'),
      biometric: noBiometric,
      openVault: (dir, keys) =>
        opts.openVault ? opts.openVault(dir, keys) : openVault(dir, keys, logger),
      agentLib: opts.agentLib ?? realAgentLib,
      providerLib: { ...realProviderLib(devCodexLib), ...opts.providerLib },
      chatgptLoginPages: () => LOGIN_PAGES,
      browserFactory: opts.browserFactory ?? realBrowserFactory,
      ...(opts.startSidecar ? { startSidecar: opts.startSidecar } : {}),
      certificateOrigins,
      signer: signerLib,
      pii: piiLib,
      fetch: opts.fetch ?? offlineFetch,
      ...(opts.places ? { places: opts.places } : {}),
      openExternal: async () => {},
      revealWindow: () => {},
      openPath: async () => '',
      relaunch: () => {},
      hostScript: () => {
        resolvedHostScript ??= resolveAgentHostScript({
          override: opts.hostScript ?? env.agentHost,
          fromUrl: import.meta.url,
          appPath: appDir,
        });
        return resolvedHostScript;
      },
      nodeBinary: process.execPath,
      electronRunAsNode: false,
      isTrustedSender: (ctx) => ctx.isMainFrame,
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.ids ? { ids: opts.ids } : {}),
      ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
    });
  } catch (error) {
    closeLogger();
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    services,
    paths,
    logger,
    invoke: (method, ...args) =>
      services.router.dispatch(method, args, {
        senderUrl: HEADLESS_PAGE,
        isMainFrame: true,
      }) as Promise<SaResult<typeof method>>,
    on: (listener) => services.events.on(listener),
    close() {
      closing ??= (async () => {
        try {
          await services.shutdown();
          await rm(paths.tmpDir, { recursive: true, force: true });
        } finally {
          closeLogger();
        }
      })();
      return closing;
    },
  };
}
