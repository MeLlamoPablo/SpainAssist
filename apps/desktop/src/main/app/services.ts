import { X509Certificate } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatGPTLoginPages } from '@sa/agent';
import type { CaptureOptions } from '@sa/browser';
import {
  type AppInfo,
  ASSISTANT_AGENT_ID,
  dniePhoneOffered,
  type Language,
  type UiEvent,
  type WindowControlsStyle,
} from '@sa/shared';
import type { Sidecar } from '@sa/sidecar';
import { certificateInfo, type KeyProvider } from '@sa/vault';
import { AgentManager } from '../agents/manager';
import { createBridgeHandlers } from '../bridge/handlers';
import { type BridgeCall, BridgeServer } from '../bridge/server';
import { TokenRegistry } from '../bridge/tokens';
import { BrowserHolder } from '../browser/holder';
import { PromptManager } from '../chat/prompts';
import { ChatService } from '../chat/service';
import { CodemodeAgents } from '../codemode/agents';
import { CodemodeCoordinator } from '../codemode/coordinator';
import { createCodemodeHandlers } from '../codemode/handlers';
import { WorkflowService } from '../codemode/workflows';
import { CompanionService } from '../companion/service';
import { ConversationService } from '../conversation/service';
import { UserError } from '../core/errors';
import { EventBus } from '../core/events';
import { ensurePrivateDir } from '../core/fs';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { type Clock, errorMessage, type IdFactory, newId, systemClock } from '../core/util';
import type { CrlSetStore } from '../crlset/store';
import { exportTranscripts } from '../export/transcripts';
import { FNMT_AUTHORITIES } from '../fnmt/authorities';
import { FnmtBroker } from '../fnmt/broker';
import { registerIpcHandlers } from '../ipc/handlers';
import { type IpcCallContext, IpcRouter } from '../ipc/router';
import { MediaStore } from '../media/store';
import { type DataImport, noDataImport } from '../migrate/nsis-import';
import { OsCertificates } from '../os-certificates/service';
import type { OsKeyStore } from '../os-certificates/store';
import { withOsCertificates } from '../os-certificates/vault';
import { CallTranscriber } from '../phone/transcriber';
import { createMaps, type Maps } from '../places/maps';
import { pendingFormPins } from '../places/resolve-form';
import type {
  AgentLib,
  Biometric,
  BrowserFactory,
  PiiLib,
  ProviderLib,
  SignerLib,
  VaultPort,
} from '../ports';
import { ProcedureService } from '../procedures/service';
import { ProcedureStore } from '../procedures/store';
import { ProviderManager } from '../providers/manager';
import { ModelListsSource } from '../providers/model-lists';
import { FeedbackService } from '../remote/feedback';
import type { FetchFn } from '../remote/http';
import { AppStateStore, SettingsStore } from '../settings/store';
import { createUpdates, type Updates } from '../updates/updater';
import type { ChooseSavePath } from '../vault/certificate-export';
import { setPersonalPartial } from '../vault/partial';
import { VaultService } from '../vault/service';
import type { SaEnv } from './env';
import { type AppPaths, assistantPaths, CHAT_VERSION } from './paths';

/** Everything the composition root needs from the outside world (Electron or tests). */
export interface MainDeps {
  env: SaEnv;
  paths: AppPaths;
  logger: Logger;
  appInfo: AppInfo;
  keyProvider: KeyProvider;
  biometric: Biometric;
  openVault(dir: string, keys: KeyProvider): Promise<VaultPort>;
  /**
   * The OS certificate store (macOS keychain), where the app finds external certificates
   * (`os-certificates/service.ts`); none on other systems or in tests.
   */
  osKeyStore?: OsKeyStore;
  /** Tests: CAs (DER) whose certificates count as external ones, besides FNMT's. */
  osCertificateAuthorities?: readonly Uint8Array[];
  agentLib: AgentLib;
  providerLib: ProviderLib;
  browserFactory: BrowserFactory;
  startSidecar?: () => Promise<Sidecar>;
  /**
   * The Chromium the packaged app ships with (`browser/bundled.ts`). Without it, Playwright's
   * cache (development, tests); SA_BROWSER_EXECUTABLE overrides both.
   */
  browserExecutable?: string;
  /** Chrome's CRLSet for the agent's browser (`crlset/store.ts`); none in tests. */
  crlSets?: Pick<CrlSetStore, 'component'>;
  certificateOrigins: readonly string[];
  signer?: SignerLib;
  pii: PiiLib;
  /** fetch for our backends and search APIs. */
  fetch: FetchFn;
  /** fetch for AutoFirma triphase signing (Electron net.fetch). */
  signerFetch?: typeof fetch;
  /** Tests: the relay socket for DNIe signatures (`@sa/companion/testing`). */
  relaySocket?: typeof WebSocket;
  /** Map lookups (public places, the home); injectable for offline tests. */
  places?: Pick<Maps, 'place' | 'home'>;
  /** The app's own updates (`updates/updater.ts`); unsupported when absent (tests, dev). */
  updates?: Updates;
  /** The Microsoft Store build's import of the GitHub (NSIS) install's data; none elsewhere. */
  dataImport?: DataImport;
  openExternal(url: string): Promise<void>;
  /**
   * The pages of the ChatGPT sign-in's loopback listener. A dependency, not an import of
   * `providers/login-pages.ts`, which imports fonts and styles with Vite-only suffixes: this
   * file then loads in plain Node (`createHeadlessApp`).
   */
  chatgptLoginPages(): ChatGPTLoginPages;
  /** Show the app window (`app.reveal`). */
  revealWindow(): void;
  /** Style the window controls (`app.windowControls`); none without a window. */
  windowControls?(style: WindowControlsStyle): void;
  openPath(path: string): Promise<string>;
  /** Opens the program that manages the OS certificate store; none where there isn't one. */
  openSystemCertificates?(): Promise<void>;
  /** The OS save dialog (certificate exports); none without a window. */
  chooseSavePath?: ChooseSavePath;
  /** User exports, separate from browser download staging. */
  documentDownloadsDir: string;
  /** Language for a profile that has none stored yet (from the OS); Spanish when absent. */
  systemLanguage?: Language;
  /** Restart the app (after wiping all data). */
  relaunch(): void;
  /** Resolves the agent host script (throws when it is not built). */
  hostScript(): string;
  nodeBinary: string;
  electronRunAsNode: boolean;
  isTrustedSender(ctx: IpcCallContext): boolean;
  clock?: Clock;
  ids?: IdFactory;
  /** Idle agent shutdown (default 10 min). */
  idleMs?: number;
  /** Hears every bridge call of the agents before it runs (the eval suite; none in the app). */
  onBridgeCall?: (call: BridgeCall) => void;
}

export interface MainServices {
  events: EventBus;
  router: IpcRouter;
  settings: SettingsStore;
  state: AppStateStore;
  procedures: ProcedureService;
  conversation: ConversationService;
  prompts: PromptManager;
  chat: ChatService;
  agents: AgentManager;
  tokens: TokenRegistry;
  bridge: BridgeServer;
  providers: ProviderManager;
  vault: VaultService;
  media: MediaStore;
  browser: BrowserHolder;
  /** DNIe with the phone; only with the `dnie-phone` feature flag. */
  companion?: CompanionService;
  feedback: FeedbackService;
  /** Agents, their workflows and the coordinator that drives them (docs/codemode.md). */
  codemode: {
    workflows: WorkflowService;
    directory: CodemodeAgents;
    coordinator: CodemodeCoordinator;
  };
  deleteProcedure(id: string): Promise<void>;
  wipeAll(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Builds and wires every main-process service. No Electron imports here: Electron-specific
 * pieces (safeStorage, Touch ID, shell, net.fetch...) come in through `deps`.
 */
export async function createMainServices(deps: MainDeps): Promise<MainServices> {
  const { env, paths } = deps;
  const logger = deps.logger;
  const clock = deps.clock ?? systemClock;
  const ids = deps.ids ?? newId;
  // In prerelease the DNIe's plumbing (pairing, relay, a saved DNIe) is there from launch, so the
  // user can save their DNIe without a restart; agents only offer it once it is saved.
  const dnieStage = deps.appInfo.features.dniePhone;
  const dniePhone = dnieStage !== 'off';
  const dnieOffered = () =>
    dniePhoneOffered(
      dnieStage,
      vaultPort.listCredentials().some((c) => c.kind === 'dnie'),
    );

  const assistant = assistantPaths(paths.assistantDir);
  for (const dir of [
    paths.userData,
    paths.assistantDir,
    paths.proceduresDir,
    paths.tmpDir,
    paths.downloadsDir,
  ])
    await ensurePrivateDir(dir);

  const events = new EventBus();
  const updates = deps.updates ?? createUpdates({ logger });
  updates.onStatus((status) => events.emit({ type: 'updates.status', status }));
  const settings = await SettingsStore.open(paths.settingsFile, {
    events,
    logger: logger.child('settings'),
    language: deps.systemLanguage,
  });
  const state = await AppStateStore.open(paths.stateFile, logger);
  const lang = () => settings.get().language;

  const osCertificates = deps.osKeyStore
    ? new OsCertificates({
        store: deps.osKeyStore,
        authorities: [...FNMT_AUTHORITIES, ...(deps.osCertificateAuthorities ?? [])],
        certificateInfo: (der) => certificateInfo(new X509Certificate(der)),
        logger: logger.child('os-certificates'),
      })
    : undefined;
  const ownVault = await deps.openVault(paths.vaultDir, deps.keyProvider);
  const vaultPort = osCertificates ? withOsCertificates(ownVault, osCertificates) : ownVault;
  const vaultFn = () => vaultPort;

  const procedureStore = new ProcedureStore(paths.proceduresDir, logger.child('store'));
  const procedures = new ProcedureService({
    store: procedureStore,
    events,
    logger: logger.child('procedures'),
    ids,
    clock,
    lang,
  });
  await procedures.init();

  const conversation = new ConversationService({
    dir: assistant.dir,
    transcriptFile: assistant.transcriptFile,
    events,
    logger: logger.child('conversation'),
    ids,
    clock,
  });
  await conversation.init();

  const prompts = new PromptManager({
    procedures,
    conversation,
    logger: logger.child('prompts'),
    clock,
    lang,
    onAsking: (agentId, asking) => directory.setAsking(agentId, asking),
  });
  const media = new MediaStore((pid) => procedureStore.paths(pid).mediaDir);
  const tokens = new TokenRegistry();

  // docs/codemode.md: agents independent of procedures, durable workflows.
  const directory = new CodemodeAgents({
    dir: join(paths.userData, 'agents'),
    events,
    logger: logger.child('codemode'),
    clock,
  });
  let codemodeCoordinator!: CodemodeCoordinator;
  const workflows = new WorkflowService({
    dir: join(paths.userData, 'workflows'),
    events,
    logger: logger.child('workflows'),
    clock,
    placeLookup: (address, signal) => places.place(address, signal),
    agentAlive: (id) => agents.isActive(id),
    onEnd: (end) => {
      codemodeCoordinator.onWorkflowEnd(end);
      // Development capture mode: a run's end saves the capture of its procedures' browsing.
      if (capture)
        for (const id of end.workflow.procedures) void browser.finishCapture(id).catch(() => {});
    },
    onDetachedEvent: (workflow) => codemodeCoordinator.onDetachedEvent(workflow),
    // What the user typed into fields with a vaultKey goes to Mis datos, always.
    saveAnswers: async (_workflow, answers) => {
      const current = new Map(vaultPort.listPersonal().map((p) => [p.key, p.value]));
      const changed = answers.filter((a) => current.get(a.key) !== a.value);
      if (!changed.length) return;
      const { saved } = await setPersonalPartial(
        vaultPort,
        changed,
        'form',
        logger.child('workflows'),
      );
      if (!saved.length) return;
      events.emit({ type: 'vault.changed' });
      const labels = saved.map((p) => p.label).join(', ');
      conversation.addNotice('info', t(lang(), 'savedToVault', { labels }));
    },
    onStale: (workflow) => codemodeCoordinator.onStale(workflow),
  });
  await directory.init();
  await workflows.init();
  workflows.startSweeping();
  events.on((e) => {
    if (e.type === 'codemode.workflow') codemodeCoordinator.onWorkflowChanged(e.workflow.agentId);
  });

  // Late-bound references (circular wiring between agents, providers and the bridge).
  let providers!: ProviderManager;
  let bridge!: BridgeServer;

  const places =
    deps.places ?? createMaps({ endpoint: env.mapsServerUrl, access: () => providers.userKey() });
  const agents = new AgentManager({
    lib: deps.agentLib,
    prompts,
    tokens,
    bridgeUrl: () => bridge.url(),
    sink: (agentId) => (agentId === ASSISTANT_AGENT_ID ? conversation : directory.sinkFor(agentId)),
    workDir: (agentId) =>
      agentId === ASSISTANT_AGENT_ID ? assistant.workDir : directory.paths(agentId).workDir,
    onRunEnd: (agentId, result) => {
      providers.creditSpent();
      codemodeCoordinator.onRunEnd(agentId, result);
    },
    onGone: (agentId) => codemodeCoordinator.onAgentGone(agentId),
    keepAlive: (agentId) => codemodeCoordinator.keepAlive(agentId),
    buildConfig: async (agentId) => {
      const s = settings.get();
      const isAssistant = agentId === ASSISTANT_AGENT_ID;
      const kind = isAssistant ? 'orchestrator' : directory.kindOf(agentId);
      if (!kind) throw new Error(`No agent "${agentId}".`);
      // Load before events arrive.
      if (!isAssistant) await directory.transcript(agentId);
      return {
        role: kind,
        procedureId: agentId,
        extraTrustedHosts: [...env.extraTrustedHosts],
        sessionFile: isAssistant
          ? assistant.sessionFile(CHAT_VERSION)
          : directory.paths(agentId).sessionFile,
        language: s.language,
        model: await providers.agentModel(isAssistant ? 'assistant' : 'procedure'),
        research: {
          // Voucher users research through the key server (paid from the voucher).
          keyServerUrl: env.keyServerUrl,
          // BYOK and custom endpoints research with Exa, keyless or with the user's key.
          ...(providers.researchesWithExa() ? { exa: true } : {}),
          // ChatGPT plans research on the models their plan offers.
          chatgptModels: await providers.researchModels(),
        },
        // Community learnings respect the sharing setting at call time. Sharing and rating also
        // need a user key (one vote per user and learning), which the server checks.
        ...(env.feedbackServerUrl
          ? {
              feedback: {
                submit: providers.hasUserKey(),
                vote: providers.hasUserKey(),
              },
            }
          : {}),
        dniePhone: dnieOffered(),
        certificateRequests: true,
      };
    },
    hostScript: deps.hostScript,
    nodeBinary: deps.nodeBinary,
    electronRunAsNode: deps.electronRunAsNode,
    logger: logger.child('agents'),
    clock,
    lang,
    mediaExists: (mediaId) => media.exists(mediaId.split('.')[0] ?? '', mediaId),
    ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
  });

  providers = new ProviderManager({
    keyServerUrl: env.keyServerUrl,
    devUserKey: env.devUserKey,
    settings,
    state,
    vault: vaultFn,
    lib: deps.providerLib,
    models: new ModelListsSource({
      url: env.modelListsUrl,
      fetch: deps.fetch,
      lib: deps.providerLib,
      logger: logger.child('models'),
      clock,
    }),
    fetch: deps.fetch,
    events,
    openExternal: deps.openExternal,
    loginPages: deps.chatgptLoginPages,
    onChanged: () => agents.stopAll(),
    logger: logger.child('providers'),
    lang,
    clock,
  });
  await providers.init();
  if (env.provider) {
    const { kind: _, ...input } = env.provider;
    await providers.preconfigure(input);
  }

  const vault = new VaultService({
    vault: vaultPort,
    events,
    logger: logger.child('vault'),
    biometric: deps.biometric,
    tmpDir: paths.tmpDir,
    downloadsDir: deps.documentDownloadsDir,
    openPath: deps.openPath,
    openSystemCertificates: deps.openSystemCertificates,
    lang,
    dniePhone,
    onCredentialDeleted: () => browser.closeAll(),
    chooseSavePath: deps.chooseSavePath,
    ...(osCertificates ? { osCertificates } : {}),
  });
  // Remove plaintext copies left by versions that used userData/tmp.
  await rm(join(paths.userData, 'tmp'), { recursive: true, force: true }).catch((err) =>
    logger.warn('legacy document cleanup failed', { error: errorMessage(err) }),
  );
  await vault.cleanupTmp();

  // Behind the feature flag: without it there is no pairing and no relay connection.
  const companion = dniePhone
    ? new CompanionService({
        relayUrl: env.relayServerUrl,
        // Development: a phone can't reach this machine's loopback relay.
        lanRelay: deps.appInfo.isDev && !env.e2e,
        appVersion: deps.appInfo.version,
        events,
        prompts,
        procedures,
        vault: vaultFn,
        ...(deps.signer ? { certificateInfo: deps.signer.certificateInfo } : {}),
        ...(deps.relaySocket ? { socket: deps.relaySocket } : {}),
        logger: logger.child('companion'),
        lang,
      })
    : undefined;

  const certificates = await deps.startSidecar?.().then(
    (sidecar) => {
      logger.info('sa-sidecar started');
      // Its error pages (a failed certificate login) are shown in the browser: in the app's language.
      sidecar.setLanguage(lang());
      return sidecar;
    },
    (err) => {
      logger.warn('certificate logins unavailable: sa-sidecar could not start', {
        error: errorMessage(err),
      });
      return undefined;
    },
  );
  // Development only: never in packaged builds (parseEnv drops SA_BROWSER_CAPTURE there too).
  const capture: CaptureOptions | undefined =
    env.browserCapture && deps.appInfo.isDev
      ? {
          // Never recreate the folder of a procedure deleted in the meantime.
          dir: (id) => (procedures.has(id) ? join(paths.proceduresDir, id, 'capture') : undefined),
          // Unscrubbed files while a context is open; tmpDir is private and wiped with the data.
          scratchDir: join(paths.tmpDir, 'browser-capture'),
        }
      : undefined;
  const crlSets = deps.crlSets;
  // FNMT certificate requests.
  const certificateRequests = new FnmtBroker({
    vault: vaultFn,
    prompts,
    procedures,
    events,
    logger: logger.child('fnmt'),
    lang,
  });
  const browser = new BrowserHolder({
    certificates,
    certificateLoginsAvailable: !deps.startSidecar || !!certificates,
    factory: deps.browserFactory,
    executablePath: env.browserExecutable ?? deps.browserExecutable,
    ...(crlSets ? { crlSet: () => crlSets.component() } : {}),
    ignoreHTTPSErrors: env.e2e,
    headless: env.e2e || deps.appInfo.isDev ? env.browserHeadless : undefined,
    ...(capture ? { capture } : {}),
    downloadsDir: paths.downloadsDir,
    media,
    vault: vaultFn,
    procedures,
    prompts,
    biometric: deps.biometric,
    events,
    ...(deps.signer ? { signer: deps.signer } : {}),
    certificateRequests: certificateRequests.handle,
    ...(companion ? { companion } : {}),
    ...(osCertificates ? { osCertificates } : {}),
    ...(deps.signerFetch ? { fetch: deps.signerFetch } : {}),
    logger: logger.child('browser'),
    lang,
  });
  if (capture)
    logger.warn(
      'browser capture is on: procedures/<id>/capture/ gets HARs, traces and HTML with personal data (typed secrets scrubbed). Use synthetic accounts only.',
    );
  // Temporary downloads never outlive the run that made them.
  await browser.downloads
    .reset()
    .catch((err) => logger.warn('download cleanup failed', { error: errorMessage(err) }));

  const feedback = new FeedbackService({
    // Without a URL, feedback.* bridge calls fail as 'unavailable'.
    feedbackServerUrl: env.feedbackServerUrl,
    access: () => providers.userKey(),
    author: () => providers.agentAuthor('procedure'),
    fetch: deps.fetch,
    settings: () => settings.get(),
    vault: vaultFn,
    pii: deps.pii,
    logger: logger.child('feedback'),
    lang,
    appVersion: deps.appInfo.version,
  });

  codemodeCoordinator = new CodemodeCoordinator({
    agents,
    directory,
    workflows,
    procedures,
    conversation,
    prompts,
    logger: logger.child('codemode'),
    clock,
    lang,
    documents: () => vaultFn().listDocuments(),
  });

  bridge = new BridgeServer({
    tokens,
    handlers: {
      ...createBridgeHandlers({
        procedures,
        conversation,
        prompts,
        vault: vaultFn,
        browser,
        media,
        events,
        providers,
        feedback,
        biometric: deps.biometric,
        certificateOrigins: deps.certificateOrigins,
        logger: logger.child('bridge'),
        lang,
        dniePhone,
      }),
      ...createCodemodeHandlers({
        workflows,
        procedures,
        directory,
        coordinator: codemodeCoordinator,
        browser,
      }),
    },
    logger: logger.child('bridge'),
    agentExists: (id) => id === ASSISTANT_AGENT_ID || directory.has(id),
    roleOf: (id) => (id === ASSISTANT_AGENT_ID ? 'orchestrator' : directory.kindOf(id)),
    procedureExists: (id) => procedures.has(id),
    ...(deps.onBridgeCall ? { onCall: deps.onBridgeCall } : {}),
  });
  await bridge.listen();

  const chat = new ChatService({
    conversation,
    agents,
    prompts,
    vault: vaultFn,
    logger: logger.child('chat'),
    clock,
    lang,
    decorate: (text) => codemodeCoordinator.decorateUserMessage(text),
  });

  settings.onChange((next, prev) => {
    if (next.language === prev.language) return;
    certificates?.setLanguage(next.language);
    void agents.stopAll();
  });
  // Agents read whether the DNIe is offered when they start (buildConfig): in prerelease, saving
  // or deleting the DNIe changes it, so restart them.
  if (dnieStage === 'prerelease') {
    let offered = dnieOffered();
    events.on((e) => {
      if (e.type !== 'vault.changed' || dnieOffered() === offered) return;
      offered = !offered;
      void agents.stopAll();
    });
  }

  async function deleteProcedure(id: string): Promise<void> {
    procedures.require(id);
    prompts.cancelAll(id);
    await browser.close(id).catch((err) =>
      logger.warn('could not close the browser of a deleted procedure', {
        error: errorMessage(err),
      }),
    );
    await browser.downloads.discard(id);
    await procedures.delete(id);
    workflows.forgetProcedure(id);
    directory.forgetProcedure(id);
  }

  async function wipeAll(): Promise<void> {
    logger.warn('wiping all local data');
    await agents.stopAll();
    prompts.cancelEverything();
    tokens.revokeAll();
    companion?.unpair();
    await browser.closeAll();
    await vaultPort.wipe();
    await procedures.deleteAll();
    await workflows.deleteAll();
    await directory.deleteAll();
    await conversation.clear();
    await rm(paths.assistantDir, { recursive: true, force: true }).catch(() => {});
    await settings.reset();
    await state.reset();
    for (const dir of [paths.tmpDir, paths.downloadsDir, paths.logsDir])
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    deps.relaunch();
  }

  async function shutdown(): Promise<void> {
    prompts.suspend();
    companion?.shutdown();
    await agents.stopAll().catch(() => {});
    await browser.closeAll().catch(() => {});
    await certificates?.close().catch(() => {});
    await bridge.close().catch(() => {});
    await procedures.flush().catch(() => {});
    await conversation.flush().catch(() => {});
    workflows.dispose();
    await workflows.flush().catch(() => {});
    await directory.flush().catch(() => {});
    await vault.cleanupTmp().catch(() => {});
  }

  const router = new IpcRouter({
    isTrustedSender: deps.isTrustedSender,
    logger: logger.child('ipc'),
    lang,
  });
  const transcriber = new CallTranscriber({
    access: () => providers.userKey(),
    fetch: deps.fetch,
    logger: logger.child('phone'),
    lang,
  });
  registerIpcHandlers(router, {
    appInfo: deps.appInfo,
    settings,
    providers,
    procedures,
    chat,
    vault,
    media,
    browser,
    companion,
    logger,
    places: {
      home: (address) => places.home(address),
      pins: (itemId, fieldKey) => {
        const item = prompts.pendingItem(itemId);
        const pins = prompts.mapPins(itemId);
        if (item?.prompt.kind !== 'form' || !pins)
          throw new UserError(t(lang(), 'promptNotPending'), 'not_pending');
        return pendingFormPins(item.prompt, pins, fieldKey, places.place);
      },
    },
    phoneCalls: {
      available: () => transcriber.available(),
      transcribe: (itemId, wav) => {
        if (prompts.pendingItem(itemId)?.prompt.kind !== 'phone_call')
          throw new UserError(t(lang(), 'promptNotPending'), 'not_pending');
        return transcriber.transcribe(wav);
      },
    },
    updates,
    dataImport: deps.dataImport ?? noDataImport,
    openExternal: deps.openExternal,
    revealWindow: deps.revealWindow,
    windowControls: deps.windowControls ?? (() => {}),
    exportTranscripts: () =>
      exportTranscripts({
        appInfo: deps.appInfo,
        assistantDir: paths.assistantDir,
        proceduresDir: paths.proceduresDir,
        scanTranscriptsDir: paths.scanTranscriptsDir,
        logsDir: paths.logsDir,
        downloadsDir: deps.documentDownloadsDir,
        flush: async () => {
          await Promise.all([procedures.flush(), conversation.flush()]);
        },
        clock,
        lang,
      }),
    deleteProcedure,
    wipeAll,
    codemode: {
      state: () => ({ agents: directory.infos(), workflows: workflows.infos() }),
      uiEvent: (workflowId: string, key: string, event: UiEvent) =>
        workflows.userEvent(workflowId, key, event),
      pins: async (workflowId: string, key: string, addresses: string[]) => {
        const signal = AbortSignal.timeout(20_000);
        await workflows.locateOpen(workflowId, key, signal);
        return workflows.pins(workflowId, key, addresses);
      },
      agentLog: async (agentId: string) => structuredClone(await directory.transcript(agentId)),
      stopAgent: async (agentId: string) => {
        if (directory.kindOf(agentId) === 'agent') await codemodeCoordinator.stopAgent(agentId);
      },
      uiFailed: (workflowId: string, key: string, rev: number, detail: string) =>
        workflows.uiFailed(workflowId, key, rev, detail),
      cancelWorkflow: async (workflowId: string) => {
        await workflows.cancel(workflowId, 'The user dismissed it');
      },
    },
  });

  return {
    events,
    router,
    settings,
    state,
    procedures,
    conversation,
    prompts,
    chat,
    agents,
    tokens,
    bridge,
    providers,
    vault,
    media,
    browser,
    companion,
    feedback,
    codemode: { workflows, directory, coordinator: codemodeCoordinator },
    deleteProcedure,
    wipeAll,
    shutdown,
  };
}
