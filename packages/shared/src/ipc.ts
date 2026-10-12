import type { Attachment, ChatItem, ConversationState, PromptResponse } from './chat';
import type { ProcedureListItem } from './procedure';
import type {
  ByokInput,
  CustomProviderInput,
  FeatureFlags,
  ModelOption,
  ProviderOption,
  ProviderStatus,
  Settings,
  SettingsPatch,
} from './settings';
import type {
  CredentialPolicy,
  CredentialSummary,
  DocumentKind,
  DocumentMeta,
  PersonalDataInput,
  PersonalSaveIssue,
  VaultOverview,
} from './vault';

/**
 * Renderer <-> main API. The preload script exposes `window.sa` (see SaApi) using two channels:
 *   - ipcRenderer.invoke(SA_INVOKE_CHANNEL, method, ...args)  -> Promise<result>
 *   - ipcRenderer.on(SA_EVENT_CHANNEL, (_e, event: SaEvent))   -> push events
 * Main validates all inputs (never trust the renderer blindly).
 */

export const SA_INVOKE_CHANNEL = 'sa:invoke';
export const SA_EVENT_CHANNEL = 'sa:event';

export interface AppInfo {
  name: string;
  version: string;
  platform: 'darwin' | 'win32' | 'linux';
  isDev: boolean;
  /** True when running under the e2e test harness. */
  isE2E: boolean;
  features: FeatureFlags;
}

export interface SendMessageInput {
  text: string;
  attachments?: Attachment[];
}

export interface AddDocumentInput {
  name: string;
  mimeType: string;
  kind: DocumentKind;
  /** File contents. */
  bytes: Uint8Array;
  procedureId?: string;
  source?: 'user' | 'scan';
}

export interface AddClaveInput {
  /** DNI/NIE used as Cl@ve username. */
  username: string;
  password: string;
  label?: string;
}

export interface AddCertificateInput {
  fileName: string;
  bytes: Uint8Array;
  passphrase: string;
  label?: string;
}

/** A call recording: WAV, 16-bit PCM, mono, 16 kHz (PHONE_CALL_AUDIO), at most PHONE_CALL_MAX_SECONDS. */
export interface TranscribeCallInput {
  wav: Uint8Array;
}

export type LoginResult = { ok: true; status: ProviderStatus } | { ok: false; error: string };

/** A redeemed voucher: `addedUsd` is its amount (it may have topped up the existing key). */
export type RedeemVoucherResult =
  | { ok: true; status: ProviderStatus; addedUsd: number }
  | { ok: false; error: string };

/** The address fields saved in Mis datos, to place the user's home on a map. */
export interface HomeAddress {
  street: string;
  postalCode?: string;
  municipality: string;
}

/** A map position. Mapbox results: show as pins only, never store or display the numbers. */
export interface MapPoint {
  latitude: number;
  longitude: number;
}

/** Method name -> [args tuple, result]. */
export interface SaMethods {
  /** The best match for the home address in Spain, or null when nothing matches it. */
  'places.locateHome': [[address: HomeAddress], MapPoint | null];
  /**
   * Pins of a pending form's map field, in option order (null: not found), or null when the
   * field has no map (the user's address lookups are used up): show only the list.
   */
  'places.pins': [[promptItemId: string, fieldKey: string], (MapPoint | null)[] | null];
  'app.info': [[], AppInfo];
  /** Open an https URL in the user's default browser (official sources, help links). */
  'app.openExternal': [[url: string], void];
  /**
   * Shows the window. During the onboarding it opens invisible so the renderer can warm the GPU
   * up first; the renderer calls this once it can draw without stalls.
   */
  'app.reveal': [[], void];
  /**
   * Saves every stored transcript (the conversation, each procedure's activity log and agent
   * session) in a new .zip in Downloads, for analysis; returns its file name.
   */
  'app.exportTranscripts': [[], string];
  /** The app's own updates (see UpdateStatus); changes arrive as `updates.status` events. */
  'updates.status': [[], UpdateStatus];

  'settings.get': [[], Settings];
  'settings.update': [[patch: SettingsPatch], Settings];

  'providers.status': [[], ProviderStatus];
  /** Starts the ChatGPT OAuth flow in the system browser; resolves when finished. */
  'providers.loginChatGPT': [[], LoginResult];
  /**
   * Development builds only: legacy Codex device-code login. Emits `providers.loginProgress` with
   * the user code and verification URL; resolves when finished. Cancel with `cancelLogin`.
   */
  'providers.loginCodexDevice': [[], LoginResult];
  'providers.cancelLogin': [[], void];
  'providers.redeemVoucher': [[code: string], RedeemVoucherResult];
  'providers.setByok': [[input: ByokInput], LoginResult];
  'providers.setCustom': [[input: CustomProviderInput], LoginResult];
  'providers.listByok': [[], ProviderOption[]];
  /** Models the connected provider can use (current model first if the list lacks it). */
  'providers.listModels': [[], ModelOption[]];
  'providers.setModel': [[model: string], ProviderStatus];
  'providers.logout': [[], ProviderStatus];

  /** Procedures are created by the assistant (from the conversation), never directly. */
  'procedures.list': [[], ProcedureListItem[]];
  'procedures.get': [[id: string], ProcedureListItem | null];
  /** What the procedure's agent did (tool calls, reports, errors). */
  'procedures.log': [[id: string], ChatItem[]];
  'procedures.rename': [[id: string, title: string], ProcedureListItem];
  'procedures.archive': [[id: string, archived: boolean], ProcedureListItem];
  /** Stops the procedure's agent (its pending prompts are cancelled). */
  'procedures.stop': [[id: string], void];
  'procedures.delete': [[id: string], void];
  'procedures.markRead': [[id: string], void];

  /** The single, perpetual conversation with the assistant. */
  'chat.transcript': [[], ChatItem[]];
  'chat.state': [[], ConversationState];
  'chat.send': [[input: SendMessageInput], void];
  /** Stops the assistant's current reply (procedures keep working). */
  'chat.abort': [[], void];
  /** Answers a prompt, whoever asked it (the assistant or a procedure's agent). */
  'chat.respond': [[promptItemId: string, response: PromptResponse], void];

  'vault.overview': [[], VaultOverview];
  'vault.setPersonal': [[items: PersonalDataInput[]], VaultOverview];
  /** Saves every valid item and reports the rejected ones instead of failing (document scans). */
  'vault.setPersonalPartial': [
    [items: PersonalDataInput[]],
    { overview: VaultOverview; rejected: PersonalSaveIssue[] },
  ];
  'vault.deletePersonal': [[keys: string[]], VaultOverview];
  'vault.addDocument': [[input: AddDocumentInput], DocumentMeta];
  'vault.deleteDocument': [[id: string], VaultOverview];
  /** Decrypts to a temp file and opens it with the OS default app. */
  'vault.openDocument': [[id: string], void];
  /** Saves a decrypted copy in Downloads without overwriting; returns its file name. */
  'vault.downloadDocument': [[id: string], string];
  /** Data URL for images (and PDFs' first page if supported), for previews. */
  'vault.previewDocument': [[id: string], string | null];
  'vault.addClave': [[input: AddClaveInput], CredentialSummary];
  'vault.addClaveMovil': [[], CredentialSummary];
  /** "I sign with my DNIe and my phone" (one per vault; adding it again returns it). */
  'vault.addDnie': [[], CredentialSummary];
  /**
   * Saves the DNIe PIN (`DniePin`), or removes it with null. The only time the PIN crosses IPC:
   * main never sends it back (the summary's `pin` says only whether one is saved).
   */
  'vault.setDniePin': [[id: string, pin: string | null], CredentialSummary];
  /** Validates the passphrase and extracts certificate metadata. */
  'vault.addCertificate': [[input: AddCertificateInput], CredentialSummary];
  'vault.setCredentialPolicy': [[id: string, policy: CredentialPolicy], CredentialSummary];
  'vault.deleteCredential': [[id: string], VaultOverview];
  /** Deletes ALL local data: vault, procedures, sessions, settings. */
  'vault.wipeAll': [[], void];

  /**
   * Phone calls (`phone_call` prompts). `transcriptionAvailable`: whether the connected provider
   * can transcribe recordings (vouchers and ChatGPT accounts, through our gateway). `transcribe`:
   * the recording of a pending phone-call prompt; resolves with the text for the user to review.
   */
  'phoneCall.transcriptionAvailable': [[], boolean];
  'phoneCall.transcribe': [[promptItemId: string, input: TranscribeCallInput], { text: string }];

  /**
   * The phone pairing for DNIe signatures. `pair` starts one (a new QR code) unless a pairing is
   * active; `unpair` ends it on both sides.
   */
  'companion.status': [[], CompanionStatus];
  'companion.pair': [[], CompanionStatus];
  'companion.unpair': [[], CompanionStatus];

  /** Data URL of a stored media item (e.g. screenshot) or null. */
  'media.get': [[id: string], string | null];
  /** Bring the procedure's browser window to the front (if open). */
  'browser.show': [[procedureId: string], void];
}

export type SaMethod = keyof SaMethods;
export type SaArgs<M extends SaMethod> = SaMethods[M][0];
export type SaResult<M extends SaMethod> = SaMethods[M][1];

export type SaEvent =
  | { type: 'procedure.upserted'; procedure: ProcedureListItem }
  | { type: 'procedure.deleted'; procedureId: string }
  /** Upsert by item id, in a procedure's activity log. */
  | { type: 'procedure.log'; procedureId: string; item: ChatItem }
  /** Upsert by item id, in the conversation. */
  | { type: 'chat.item'; item: ChatItem }
  /** Append text to a streaming assistant item of the conversation. */
  | { type: 'chat.delta'; itemId: string; delta: string }
  | { type: 'chat.state'; state: ConversationState }
  | { type: 'providers.status'; status: ProviderStatus }
  /** `userCode`: device-code logins (the user types it at `url`). */
  | { type: 'providers.loginProgress'; message: string; url?: string; userCode?: string }
  | { type: 'vault.changed' }
  | { type: 'settings.changed'; settings: Settings }
  | { type: 'companion.changed'; status: CompanionStatus }
  | { type: 'updates.status'; status: UpdateStatus };

/**
 * The app's own updates (electron-updater, GitHub Releases). They download in the background and
 * install when the app quits; with the `must-update` flag, main installs one as soon as it's
 * downloaded and restarts.
 * - `unsupported`: this build can't update itself (development, e2e, macOS until builds are
 *   signed, Linux); `idle`: no check yet;
 * - `checking`, `upToDate`;
 * - `downloading` the new `version`, `percent` 0–100; `ready`: downloaded, installs on quit;
 * - `error`: the last check or download failed (it retries on the next check).
 */
export type UpdateStatus =
  | { state: 'unsupported' | 'idle' | 'checking' | 'upToDate' | 'error' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string };

/**
 * The desktop's pairing with the phone app (`@sa/companion`):
 * - `unavailable`: no relay server (some test runs); `off`: no pairing;
 * - `connecting`: reaching the relay; `waiting`: no phone has scanned the QR code yet;
 * - `away`: the phone paired but isn't connected now (app closed, phone asleep);
 * - `connected`.
 */
export interface CompanionStatus {
  state: 'unavailable' | 'off' | 'connecting' | 'waiting' | 'away' | 'connected';
  /** The pairing link for the QR code, while no phone is connected. Memory only. */
  link?: string;
  /** The paired phone's model ("Pixel 8"). */
  device?: string;
  /** When the pairing ends (ISO 8601). */
  expiresAt?: string;
}

export interface SaApi {
  invoke<M extends SaMethod>(method: M, ...args: SaArgs<M>): Promise<SaResult<M>>;
  /** Subscribe to push events. Returns an unsubscribe function. */
  on(listener: (event: SaEvent) => void): () => void;
}
