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
import { CodemodeSlug, type UiEvent } from './codemode';
import { Procedure as ProcedureSchema, ProcedureUpdate } from './procedure';
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

/**
 * An element: a ref from the latest snapshot ("e12"), or, from codemode workflows, `loc:` and the
 * JSON of a Playwright locator chain (see @sa/browser locator.ts).
 */
const Ref = z
  .string()
  .min(1)
  .max(4000)
  .describe('Element ref from the latest snapshot, e.g. "e12"');

// ---------------------------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------------------------

/** Agent id of the assistant (orchestrator). Procedure ids never take this value. */
export const ASSISTANT_AGENT_ID = 'assistant';

const ProcedureRef = z.string().min(1).max(64).describe('Procedure id, e.g. "p_0123456789abcdef"');

const ProcedureId = z.string().min(1).max(64);
const RunId = z.string().min(1).max(64);
const AgentId = z.string().min(1).max(64);
const StateKey = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/, 'Letters, digits and _.:- (max 100).');

/** A procedure's private working context: for agents, never shown to the user. */
export const WorkingContext = z.object({
  notes: z.string().max(20_000),
  data: z.record(z.string().max(100), z.unknown()),
});
export type WorkingContext = z.infer<typeof WorkingContext>;
export const WORKING_CONTEXT_MAX_BYTES = 64 * 1024;

/** The bridge header with which a codemode agent acts on a procedure (its browser, its card). */
export const PROCEDURE_HEADER = 'x-sa-procedure';

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
  /**
   * Pass a message (new information, a decision, a request) to a procedure's agent: after its
   * current run, or right after its current tool calls when it answers a pending data form
   * (cancelled) or is `urgent` (a correction, cancelling all its pending requests). Never aborts
   * the run.
   */
  'procedures.message': z.object({
    procedureId: ProcedureRef,
    message: z.string().min(1).max(4000),
    urgent: z.boolean().optional(),
  }),
  /** Answer or dismiss a pending data form; never approves protected actions. */
  'procedures.respond': z.object({
    procedureId: ProcedureRef,
    promptId: z.string().min(1).max(128),
    values: z.record(z.string().max(64), FormValue).optional(),
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

  // --- codemode (the `codemode` feature flag; docs/codemode.md) ------------------------------
  /**
   * Starts a run of a workflow: creates its record, or resumes it with its durable state when the
   * id exists (another live run of it is refused with `conflict`). Returns the run's id.
   */
  'workflow.begin': z.object({
    workflowId: CodemodeSlug,
    title: z.string().max(120).optional(),
    procedures: z.array(ProcedureId).max(20).optional(),
    source: z.string().min(1).max(200_000),
  }),
  'workflow.memo': z.object({
    runId: RunId,
    key: StateKey,
    value: z.unknown().optional(),
    delete: z.boolean().optional(),
  }),
  /** Interfaces of a run: open (validated, its map addresses located), render, durable, close. */
  'workflow.ui': z.object({
    runId: RunId,
    action: z.enum(['open', 'render', 'durable', 'close']),
    key: StateKey,
    rev: z.number().int().nonnegative().optional(),
    tree: z.unknown().optional(),
    name: StateKey.optional(),
    value: z.unknown().optional(),
    result: z.unknown().optional(),
  }),
  /**
   * Long poll: the user's events on the run's open interfaces after `after`. Answers at once when
   * there are some, else within 25 s with none; `ended` when the run was cancelled from outside.
   */
  'workflow.events': z.object({ runId: RunId, after: z.number().int().nonnegative() }),
  /** The calling agent's status on the meter (api.setStatus). */
  'workflow.setStatus': z.object({ status: z.string().min(1).max(120) }),
  /** The run ended. `deliver`: the agent's tool already returned, so main tells the agent. */
  'workflow.end': z.object({
    runId: RunId,
    outcome: z.object({
      status: z.enum(['succeeded', 'failed', 'cancelled']),
      value: z.string().max(100_000).optional(),
      error: z.string().max(10_000).optional(),
      code: z.string().max(40).optional(),
      /** console output and the user's notes, for an agent that hears the outcome later. */
      logs: z.string().max(10_000).optional(),
    }),
    deliver: z.boolean().default(false),
  }),
  /** This agent's workflows to resume when its process starts (they were waiting for the user). */
  'workflow.resumable': z.object({}),
  'workflows.list': z.object({}),
  'workflows.get': z.object({ id: CodemodeSlug }),
  'workflows.cancel': z.object({ id: CodemodeSlug, reason: z.string().max(300).optional() }),

  /** Every procedure's card (no private context). */
  'procs.list': z.object({ includeArchived: z.boolean().default(false) }),
  'procs.get': z.object({ id: ProcedureId }),
  /**
   * A procedure by a key stable within the run's workflow (or a full id): created the first time,
   * the same one on every later run. Adds it to the workflow's procedures.
   */
  'procs.getOrCreate': ProcedureUpdate.extend({
    runId: RunId,
    id: z.string().min(1).max(64),
    title: ProcedureSchema.shape.title,
  }),
  /** Optimistic concurrency: `conflict` when the procedure changed since `expectedVersion`. */
  'procs.update': z.object({
    id: ProcedureId,
    expectedVersion: z.number().int().nonnegative(),
    patch: ProcedureUpdate,
  }),
  'procs.context': z.object({ id: ProcedureId }),
  'procs.setContext': z.object({ id: ProcedureId, context: WorkingContext.partial() }),

  /** The coordinator's background agents (codemode only). */
  'agents.start': z.object({
    status: z.string().min(1).max(120),
    brief: z.string().min(1).max(8000),
    procedures: z.array(ProcedureId).max(20).optional(),
  }),
  'agents.message': z.object({
    agentId: AgentId,
    message: z.string().min(1).max(4000),
    urgent: z.boolean().optional(),
    status: z.string().min(1).max(120).optional(),
  }),
  'agents.stop': z.object({ agentId: AgentId }),
  'agents.list': z.object({}),

  /** Reads and light actions on a locator, or on the page with an empty target. */
  'browser.query': z.object({
    target: z.string().max(4000),
    op: z.enum([
      'textContent',
      'innerText',
      'inputValue',
      'getAttribute',
      'isVisible',
      'isEnabled',
      'isChecked',
      'count',
      'allTextContents',
      'allInnerTexts',
      'waitFor',
      'hover',
      'focus',
      'dblclick',
      'press',
      'evaluate',
      'evaluateAll',
    ]),
    args: z
      .object({
        name: z.string().max(100).optional(),
        key: z.string().max(40).optional(),
        fn: z.string().max(20_000).optional(),
        arg: z.unknown().optional(),
        state: z.string().max(20).optional(),
        timeout: z.number().int().min(0).max(60_000).optional(),
      })
      .default({}),
  }),
  'browser.reload': z.object({}),
  'browser.info': z.object({}),

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
  'procedures.message': { delivered: 'started' | 'queued'; cancelledPrompts: number };
  'procedures.respond': { answered: boolean; dismissed: boolean };
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
  'workflow.begin': {
    runId: string;
    resumed: boolean;
    procedures: string[];
    state: {
      memo: Record<string, { value?: unknown }>;
      ui: Record<
        string,
        {
          status: 'open' | 'closed';
          result?: unknown;
          durable?: Record<string, unknown>;
          rev?: number;
        }
      >;
    };
  };
  'workflow.memo': Record<string, never>;
  'workflow.ui': Record<string, never>;
  'workflow.events': { events: { seq: number; key: string; event: UiEvent }[]; ended?: boolean };
  'workflow.setStatus': Record<string, never>;
  'workflow.end': Record<string, never>;
  'workflow.resumable': {
    workflows: { workflowId: string; title?: string; source: string; procedures: string[] }[];
  };
  'workflows.list': {
    workflows: {
      id: string;
      title?: string;
      status: string;
      agentId: string;
      procedures: string[];
      openUi: string[];
    }[];
  };
  'workflows.get': {
    id: string;
    title?: string;
    status: string;
    agentId: string;
    procedures: string[];
    memoKeys: string[];
    openUi: string[];
    result?: unknown;
    error?: string;
  };
  'workflows.cancel': { cancelled: boolean };
  'procs.list': { procedures: VersionedProcedure[] };
  'procs.get': VersionedProcedure;
  'procs.getOrCreate': VersionedProcedure & { created: boolean };
  'procs.update': VersionedProcedure;
  'procs.context': WorkingContext;
  'procs.setContext': Record<string, never>;
  'agents.start': { agentId: string };
  'agents.message': { delivered: 'started' | 'queued'; cancelledPrompts: number };
  'agents.stop': { stopped: boolean };
  'agents.list': {
    agents: {
      id: string;
      status: string;
      activity: string;
      now?: string;
      procedures: string[];
    }[];
  };
  'browser.query': { value: unknown; observation?: BrowserObservation };
  'browser.reload': BrowserObservation;
  'browser.info': { url: string; title: string };
  'agent.credential': { credential: Record<string, unknown> | null };
  'agent.refreshCredential': { credential: Record<string, unknown> | null };
  'agent.exaKey': { key: string | null };
  'agent.voucherSpend': Record<string, never>;
}

/** A procedure card as codemode agents read it (no runtime state, no private context). */
export type VersionedProcedure = import('./procedure').Procedure;

/** Methods only the assistant may call. */
export const ASSISTANT_METHODS: ReadonlySet<BridgeMethod> = new Set<BridgeMethod>([
  'procedures.list',
  'procedures.read',
  'procedures.start',
  'procedures.message',
  'procedures.respond',
  'procedures.stop',
  'procedures.cancel',
  'prompt.form',
  'vault.read',
  'vault.save',
  'agent.credential',
  'agent.refreshCredential',
  'agent.voucherSpend',
]);

/** Codemode methods (`codemode` flag): no legacy agent may call them. */
const CODEMODE_PREFIXES = ['workflow.', 'workflows.', 'procs.', 'agents.'] as const;
const CODEMODE_BROWSER: ReadonlySet<BridgeMethod> = new Set<BridgeMethod>([
  'browser.query',
  'browser.reload',
  'browser.info',
]);

export function isCodemodeMethod(method: BridgeMethod): boolean {
  return (
    CODEMODE_PREFIXES.some((prefix) => method.startsWith(prefix)) || CODEMODE_BROWSER.has(method)
  );
}

/** Methods a procedure's agent may call: everything except the assistant's and codemode's. */
export function procedureMayCall(method: BridgeMethod): boolean {
  return !method.startsWith('procedures.') && !isCodemodeMethod(method);
}

/** The roles of the codemode harness. */
export type CodemodeBridgeRole = 'orchestrator' | 'agent';

/**
 * What each codemode role may call. The coordinator only delegates: its agents and reading the
 * cards (its tools, packages/agent/src/tools/coordinator.ts). Agents: everything else, workflows,
 * procedures, vault, the browser and the user prompts, but no agents of their own.
 */
export function codemodeMayCall(role: CodemodeBridgeRole, method: BridgeMethod): boolean {
  if (method.startsWith('procedures.') || method.startsWith('procedure.')) return false;
  if (method.startsWith('agent.')) return true;
  if (role === 'orchestrator')
    return method.startsWith('agents.') || method === 'procs.list' || method === 'procs.get';
  return !method.startsWith('agents.');
}

export const BridgeErrorCode = z.enum([
  'bad_request',
  'unauthorized',
  'not_found',
  'user_rejected', // the user declined a confirmation / credential use
  'policy_denied', // e.g. credential not allowed on this domain
  'browser_error',
  'unavailable', // e.g. feedback server unreachable
  'conflict', // codemode: a procedure changed since it was read, a page is locked, a workflow runs elsewhere
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
