import { z } from 'zod';
import {
  ConfirmPrompt,
  CredentialPrompt,
  FormPrompt,
  FormValue,
  PhoneCallPrompt,
  type PromptResponse,
  UserActionPrompt,
} from './chat';
import { ProcedureUpdate } from './procedure';
import { FeedbackKind, FeedbackVote } from './services';
import { PersonalDataInput } from './vault';

/**
 * Host bridge: the contract between the pi extension (running inside the agent child process)
 * and the Electron main process.
 *
 * Two kinds of agents use it:
 *   - the assistant (ASSISTANT_AGENT_ID): the orchestrator behind the single chat. It starts and
 *     briefs one agent per procedure (`procedures.*`) and may ask the user / use their data;
 *   - one agent per procedure: does all the work for it (research, browser, plan card).
 * Each method is available to one kind or both (see ASSISTANT_METHODS / PROCEDURE_METHODS).
 *
 * Transport: HTTP on 127.0.0.1 (random port). The agent process receives:
 *   SA_BRIDGE_URL      e.g. http://127.0.0.1:53123
 *   SA_BRIDGE_TOKEN    per-agent bearer token (also identifies the agent)
 *   SA_PROCEDURE_ID    the procedure this agent works on, or ASSISTANT_AGENT_ID
 *
 * Request:  POST {SA_BRIDGE_URL}/rpc/{method}
 *           Authorization: Bearer {SA_BRIDGE_TOKEN}
 *           Content-Type: application/json
 *           body = params (validated with BridgeParams[method])
 * Response: 200 { ok: true, result } | 4xx/5xx { ok: false, error: { code, message } }
 *
 * Methods that wait for the user (prompt.*) may take minutes: clients must use no timeout and
 * pass an AbortSignal (the request is cancelled when the agent run is aborted).
 * Secrets never cross this bridge in either direction.
 */

// ---------------------------------------------------------------------------------------------
// Browser observations
// ---------------------------------------------------------------------------------------------

export const BrowserTab = z.object({
  index: z.number().int(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
});
export type BrowserTab = z.infer<typeof BrowserTab>;

/** What the agent "sees" after every browser action. */
export const BrowserObservation = z.object({
  url: z.string(),
  title: z.string(),
  /**
   * Accessibility snapshot (YAML-like) with element refs, e.g. `- button "Entrar" [ref=e12]`.
   * Refs are valid until the next snapshot. Secrets typed by the app are masked as "••••".
   */
  snapshot: z.string(),
  /** True when the snapshot was cut to fit the size budget. */
  truncated: z.boolean().default(false),
  tabs: z.array(BrowserTab).default([]),
  /**
   * Files downloaded since the last observation. They stay in the procedure's temporary
   * downloads (not the vault) until the agent saves them with `downloads.save`.
   */
  downloads: z
    .array(z.object({ downloadId: z.string(), name: z.string(), mimeType: z.string() }))
    .default([]),
  /** Signatures performed by the app (AutoFirma replacement) since the last observation. */
  signatures: z
    .array(
      z.object({
        status: z.enum(['signed', 'rejected', 'failed']),
        format: z.string(),
        origin: z.string(),
        message: z.string().optional(),
      }),
    )
    .default([]),
  /** JS dialogs (alert/confirm) that appeared and how they were handled. */
  dialogs: z.array(z.string()).default([]),
  /**
   * Uncaught exceptions and unhandled promise rejections of the page's own scripts since the
   * last observation, e.g. `TypeError: x is not a function (/js/login.js:12)`.
   */
  pageErrors: z.array(z.string()).default([]),
  /** Short notes from the app, e.g. "Client certificate requested by www1.agenciatributaria.gob.es". */
  notes: z.array(z.string()).default([]),
  /** Media id of a low-res screenshot for the UI (not sent to the model). */
  imageId: z.string().optional(),
});
export type BrowserObservation = z.infer<typeof BrowserObservation>;

const Ref = z.string().min(1).max(32).describe('Element ref from the latest snapshot, e.g. "e12"');

// ---------------------------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------------------------

/** Agent id of the assistant (orchestrator). Procedure ids never take this value. */
export const ASSISTANT_AGENT_ID = 'assistant';

const ProcedureRef = z.string().min(1).max(64).describe('Procedure id, e.g. "p_0123456789abcdef"');

export const BridgeParams = {
  // --- procedure (its own agent) ---------------------------------------------------------------
  'procedure.get': z.object({}),
  'procedure.update': ProcedureUpdate,

  // --- procedures (assistant only) -----------------------------------------------------------
  /** Short list of every procedure (archived ones only when asked). */
  'procedures.list': z.object({ includeArchived: z.boolean().default(false) }),
  /** One procedure's card, as the user sees it. */
  'procedures.read': z.object({ procedureId: ProcedureRef }),
  /**
   * Create a procedure and start its agent with a brief. Returns right away: the procedure's
   * agent works on its own and its report reaches the assistant when it finishes a run.
   */
  'procedures.start': z.object({
    title: z.string().min(1).max(160),
    brief: z.string().min(1).max(4000),
  }),
  /** Pass a message (new information, a decision, a request) to a procedure's agent. */
  'procedures.message': z.object({
    procedureId: ProcedureRef,
    message: z.string().min(1).max(4000),
  }),
  /** Answer or dismiss a pending data form; never approves protected actions. */
  'procedures.respond': z.object({
    procedureId: ProcedureRef,
    promptId: z.string().min(1).max(128),
    values: z.record(z.string().max(64), FormValue).optional(),
  }),
  /** Dismiss obsolete data forms and prioritize new instructions. */
  'procedures.resume': z.object({
    procedureId: ProcedureRef,
    message: z.string().min(1).max(4000),
  }),
  /** Interrupt a procedure's current run without cancelling the procedure (assistant only). */
  'procedures.stop': z.object({ procedureId: ProcedureRef }),
  /** Stop a procedure's agent and mark the procedure cancelled. */
  'procedures.cancel': z.object({
    procedureId: ProcedureRef,
    reason: z.string().max(300).optional(),
  }),

  // --- prompts (block until the user answers) ------------------------------------------------
  'prompt.form': FormPrompt.omit({ kind: true }),
  /**
   * `certificate_site` asks the user to allow certificate logins on `site`, an https origin
   * outside the official list, after the agent checked it in `sources`. The app writes that
   * prompt's copy; `message` is shown as the agent's summary of what it checked.
   */
  'prompt.confirm': ConfirmPrompt.omit({ kind: true, biometric: true })
    .extend({
      confirmKind: z.enum(['action', 'submission', 'payment', 'certificate_site']),
      site: z.string().url().max(300).optional(),
      sources: z.array(z.string().url().max(500)).max(10).optional(),
    })
    .refine(
      (p) => p.confirmKind !== 'certificate_site' || (p.site && (p.sources?.length ?? 0) >= 3),
      {
        message: 'certificate_site needs the site and at least 3 sources.',
      },
    ),
  'prompt.userAction': UserActionPrompt.omit({ kind: true, imageId: true }).extend({
    /** Attach a screenshot of the current page (e.g. to show a QR inside the app). */
    attachScreenshot: z.boolean().default(false),
  }),
  'prompt.credential': CredentialPrompt.omit({ kind: true, replaceId: true }),
  'prompt.phoneCall': PhoneCallPrompt.omit({ kind: true }),

  // --- vault ---------------------------------------------------------------------------------
  /** Read personal data (values included), document list and credential summaries. */
  'vault.read': z.object({ keys: z.array(z.string()).max(50).optional() }),
  /** Save personal data learned during the conversation. */
  'vault.save': z.object({ items: z.array(PersonalDataInput).min(1).max(30) }),
  /** Read the contents of one saved document (procedure agents read it with document_read). */
  'vault.document': z.object({ documentId: z.string().min(1).max(120) }),

  // --- downloads (procedure agents) ----------------------------------------------------------
  /**
   * Move one of this procedure's temporary downloads into the vault under a readable name.
   * The app keeps the original file extension.
   */
  'downloads.save': z.object({
    downloadId: z.string().min(1).max(120),
    name: z.string().trim().min(1).max(120),
  }),

  // --- browser -------------------------------------------------------------------------------
  'browser.open': z.object({ url: z.string().url(), newTab: z.boolean().default(false) }),
  'browser.snapshot': z.object({}),
  'browser.click': z.object({ ref: Ref, element: z.string().max(200).optional() }),
  'browser.type': z.object({
    ref: Ref,
    text: z.string().max(5000),
    submit: z.boolean().default(false),
  }),
  /** Type a saved personal-data value without revealing it. */
  'browser.fillFromVault': z.object({
    ref: Ref,
    key: z.string().min(1).max(80),
    submit: z.boolean().default(false),
  }),
  /**
   * Log in on a Cl@ve Permanente page: types the saved DNI/NIE and password and submits. Without a
   * saved Cl@ve Permanente, or when the page `rejected` the saved password, the user first adds
   * (or corrects) it in the app's own form. The model never sees either value.
   */
  'browser.loginClave': z.object({
    usernameRef: Ref,
    passwordRef: Ref,
    rejected: z.boolean().default(false),
    /** Why the procedure needs it, shown if the user has to add it. */
    message: z.string().max(2000).optional(),
  }),
  /**
   * Ask the user for a one-off secret (a code, or a password for a site other than Cl@ve) and
   * type it straight into the page: the model never sees the value, and nothing is saved. Shown
   * as a native prompt in the procedure's chat.
   */
  'browser.fillFromUser': z.object({
    ref: Ref,
    title: z.string().min(1).max(160),
    message: z.string().max(1000).optional(),
    label: z.string().min(1).max(100),
    submit: z.boolean().default(false),
  }),
  'browser.select': z.object({ ref: Ref, values: z.array(z.string()).min(1).max(20) }),
  'browser.check': z.object({ ref: Ref, checked: z.boolean() }),
  'browser.press': z.object({ key: z.string().min(1).max(40) }),
  'browser.wait': z.object({
    text: z.string().max(200).optional(),
    textGone: z.string().max(200).optional(),
    seconds: z.number().min(0).max(60).optional(),
  }),
  'browser.back': z.object({}),
  'browser.tabs': z.object({
    action: z.enum(['list', 'select', 'close']),
    index: z.number().int().min(0).optional(),
  }),
  'browser.screenshot': z.object({ fullPage: z.boolean().default(false) }),
  'browser.upload': z.object({ ref: Ref, documentIds: z.array(z.string()).min(1).max(10) }),
  /** Enable TLS client-certificate login for this procedure's browser (may ask the user). */
  'browser.useCertificate': z.object({
    credentialId: z.string(),
    /** Origins added to the built-in list. Required for DNIe; first is its intended login site. */
    origins: z.array(z.string().url()).max(10).optional(),
  }),
  'browser.close': z.object({}),

  // --- feedback (community learnings) ----------------------------------------------------------
  'feedback.search': z.object({
    query: z.string().min(2).max(300),
    procedure: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  /** The app scrubs personal data (regex + exact match against the vault) before sending. */
  'feedback.submit': z.object({
    procedure: z.string().min(3).max(200),
    administration: z.string().max(200).optional(),
    region: z.string().max(100).optional(),
    kind: FeedbackKind,
    title: z.string().min(5).max(200),
    body: z.string().min(10).max(4000),
    tags: z.array(z.string().max(40)).max(10).optional(),
    urls: z.array(z.string().url()).max(5).optional(),
  }),
  /** Rates a learning from feedback.search (by its id). */
  'feedback.vote': z.object({ id: z.string().min(1).max(64), vote: FeedbackVote }),

  // --- agent host internals (not tools) ------------------------------------------------------
  /**
   * Current inference credential for this agent process, in pi-ai `Credential` shape
   * ({type:'api_key', key} | {type:'oauth', access, refresh, expires, ...}). Called by the agent
   * host's CredentialStore on every read, so key rotation is live. Never persisted by the host.
   */
  'agent.credential': z.object({ providerId: z.string() }),
  /**
   * Ask the app to refresh an expired/expiring OAuth credential (the app serializes refreshes
   * across agent processes and persists the result encrypted). Returns the fresh credential.
   */
  'agent.refreshCredential': z.object({ providerId: z.string() }),
  /**
   * The user's own Exa API key, for the web research of BYOK and custom endpoints. Null
   * when none is saved or the provider is not BYOK or custom. Read on every Exa call (the user
   * may add it while the agent runs) and sent only to Exa; never persisted by the host.
   */
  'agent.exaKey': z.object({}),
  /**
   * The voucher key's spend and cap, from LiteLLM's response headers on each LLM call (see
   * VoucherCreditResponse). It is the spend before that call: for one cap, the app keeps the
   * highest spend it has seen.
   */
  'agent.voucherSpend': z.object({
    spendUsd: z.number().nonnegative(),
    maxBudgetUsd: z.number().nonnegative(),
  }),
} as const;

export type BridgeMethod = keyof typeof BridgeParams;
export type BridgeParamsOf<M extends BridgeMethod> = z.input<(typeof BridgeParams)[M]>;

export interface VaultReadResult {
  personal: { key: string; label: string; value: string }[];
  documents: { id: string; name: string; mimeType: string; createdAt: string }[];
  credentials: {
    id: string;
    kind: string;
    label: string;
    policy: 'auto' | 'ask';
    usernameHint?: string;
    certificate?: { holderName?: string; issuer: string; validTo: string };
  }[];
}

/** A procedure as the assistant sees it in `procedures.list`: enough to pick one, no more. */
export interface ProcedureBrief {
  id: string;
  title: string;
  status: import('./procedure').ProcedureStatus;
  /** The procedure's agent: working, waiting for the user, or idle. */
  activity: import('./procedure').ProcedureActivity;
  nextAction?: import('./procedure').NextAction;
  archived: boolean;
  updatedAt: string;
}

export interface BridgeResults {
  'procedure.get': import('./procedure').Procedure;
  'procedure.update': import('./procedure').Procedure;
  'procedures.list': { procedures: ProcedureBrief[] };
  'procedures.read': import('./procedure').ProcedureListItem;
  'procedures.start': { procedureId: string; title: string };
  'procedures.message': { delivered: 'started' | 'queued' };
  'procedures.respond': { answered: boolean; dismissed: boolean };
  'procedures.resume': { delivered: 'started' | 'queued' };
  'procedures.stop': { stopped: boolean };
  'procedures.cancel': { cancelled: boolean };
  'prompt.form': Extract<PromptResponse, { kind: 'form' }>;
  'prompt.confirm': Extract<PromptResponse, { kind: 'confirm' }>;
  'prompt.userAction': Extract<PromptResponse, { kind: 'user_action' }>;
  'prompt.credential': Extract<PromptResponse, { kind: 'credential' }>;
  'prompt.phoneCall': Extract<PromptResponse, { kind: 'phone_call' }>;
  'vault.read': VaultReadResult;
  'vault.save': { saved: string[] };
  'vault.document': { id: string; name: string; mimeType: string; dataBase64: string };
  'downloads.save': { documentId: string; name: string };
  'browser.open': BrowserObservation;
  'browser.snapshot': BrowserObservation;
  'browser.click': BrowserObservation;
  'browser.type': BrowserObservation;
  'browser.fillFromVault': BrowserObservation;
  'browser.loginClave': BrowserObservation;
  'browser.fillFromUser': BrowserObservation;
  'browser.select': BrowserObservation;
  'browser.check': BrowserObservation;
  'browser.press': BrowserObservation;
  'browser.wait': BrowserObservation;
  'browser.back': BrowserObservation;
  'browser.tabs': { tabs: BrowserTab[] };
  'browser.screenshot': { mimeType: 'image/jpeg' | 'image/png'; dataBase64: string };
  'browser.upload': BrowserObservation;
  'browser.useCertificate': { enabled: boolean; origins: string[]; message?: string };
  'browser.close': { closed: boolean };
  'feedback.search': { results: import('./services').FeedbackEntry[] };
  'feedback.submit': { submitted: boolean; id?: string; redactions: number; reason?: string };
  'feedback.vote': { counted: boolean; reason?: string };
  'agent.credential': { credential: Record<string, unknown> | null };
  'agent.refreshCredential': { credential: Record<string, unknown> | null };
  'agent.exaKey': { key: string | null };
  'agent.voucherSpend': Record<string, never>;
}

/** Methods only the assistant may call. */
export const ASSISTANT_METHODS: ReadonlySet<BridgeMethod> = new Set<BridgeMethod>([
  'procedures.list',
  'procedures.read',
  'procedures.start',
  'procedures.message',
  'procedures.respond',
  'procedures.resume',
  'procedures.stop',
  'procedures.cancel',
  'prompt.form',
  'vault.read',
  'vault.save',
  'agent.credential',
  'agent.refreshCredential',
  'agent.voucherSpend',
]);

/** Methods a procedure's agent may call: everything except the assistant's `procedures.*`. */
export function procedureMayCall(method: BridgeMethod): boolean {
  return !method.startsWith('procedures.');
}

export const BridgeErrorCode = z.enum([
  'bad_request',
  'unauthorized',
  'not_found',
  'user_rejected', // the user declined a confirmation / credential use
  'policy_denied', // e.g. credential not allowed on this domain
  'browser_error',
  'unavailable', // e.g. feedback server unreachable
  'internal',
]);
export type BridgeErrorCode = z.infer<typeof BridgeErrorCode>;

export type BridgeResponse<M extends BridgeMethod> =
  | { ok: true; result: BridgeResults[M] }
  | { ok: false; error: { code: BridgeErrorCode; message: string } };

export const BRIDGE_ENV = {
  url: 'SA_BRIDGE_URL',
  token: 'SA_BRIDGE_TOKEN',
  procedureId: 'SA_PROCEDURE_ID',
  language: 'SA_LANGUAGE',
  /** JSON AgentHostConfig (non-secret): provider/model, session file, research settings... */
  config: 'SA_AGENT_CONFIG',
} as const;
