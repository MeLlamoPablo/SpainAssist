import { HostOpError, WorkflowRun, type WorkflowState } from '@sa/agent/workflow-run';
import {
  emptyProcedure,
  type ProcedureListItem,
  type Prompt,
  type PromptItem,
  type PromptResponse,
  UI_FAILED,
  type UiAnswer,
  type UiEvent,
  uiTreeAnswers,
  uiTreeProblem,
  type WorkflowUi,
} from '@sa/shared';

/**
 * Runs a playground workflow for real: the kernel in QuickJS, as the agent host does, with main's
 * side played here. Durable state lives in memory (so "resume" re-runs from it, as after a
 * restart), trees are checked like main checks them, and the host's operations answer with
 * example data. Questions (`api.user.*`) become real prompt items the page shows.
 */

export type RunStatus = 'running' | 'waiting_user' | 'succeeded' | 'failed' | 'cancelled';

export interface RunLine {
  id: number;
  kind: 'call' | 'event' | 'state' | 'log' | 'error';
  text: string;
  /** Lines with the same id replace each other (a value as the user types it). */
  replace?: string;
}

export interface RunView {
  workflowId: string;
  status: RunStatus;
  /** Open interfaces, oldest first. */
  ui: WorkflowUi[];
  /** Questions it asked (`api.user.*`), still waiting. */
  prompts: PromptItem[];
  /** Procedures it created or changed, as the user's list shows them. */
  procedures: ProcedureListItem[];
  /** Its line on the meter (`api.setStatus`). */
  agentStatus?: string;
  /** When its current stretch of work started (ISO). */
  since?: string;
  lines: RunLine[];
  /** What `main` returned (JSON). */
  result?: string;
  error?: string;
  /** Its durable state: memoized steps and interfaces. */
  state: WorkflowState;
}

export interface RunnerHost {
  lang: 'es' | 'en';
  /** Shows a question; `onAnswer` gets it once answered or cancelled. Returns how to withdraw it. */
  ask(item: PromptItem, onAnswer: (item: PromptItem) => void): () => void;
  onChange(view: RunView): void;
  /** How long the example host takes to answer a lookup (ms). */
  delayMs?: number;
  /** The log of the run this one resumes. */
  history?: RunLine[];
  /** Saves an interface's answers to Mis datos, as main does when it closes. */
  saveAnswers?(answers: UiAnswer[]): Promise<void>;
  /** Procedures as the app has them (they outlive runs). */
  procedures?: ProcedureListItem[];
}

const LINE_LIMIT = 300;

export class PlaygroundRun {
  private readonly run: WorkflowRun;
  private readonly view: RunView;
  private readonly withdraw = new Set<() => void>();
  private readonly procedures = new Map<string, ProcedureListItem>();
  private nextLine = 0;
  private nextPrompt = 0;
  private finished = false;

  constructor(
    readonly workflowId: string,
    source: string,
    state: WorkflowState,
    private readonly host: RunnerHost,
  ) {
    this.view = {
      workflowId,
      status: 'running',
      ui: [],
      prompts: [],
      procedures: [],
      lines: host.history ?? [],
      state: structuredClone(state),
      since: new Date().toISOString(),
    };
    this.run = new WorkflowRun({
      workflowId,
      source,
      state: structuredClone(state),
      procedures: [],
      call: (op, args, { signal }) => this.call(op, args as Record<string, unknown>, signal),
      store: {
        setMemo: async (key, value) => {
          this.view.state.memo[key] = { value };
          this.line('state', `memo "${key}" ${short(value)}`);
        },
        deleteMemo: async (key) => {
          delete this.view.state.memo[key];
          this.line('state', `memo "${key}" deleted`);
        },
        openUi: async (key, tree, rev) => {
          // Main refuses what the app can't draw: present() throws there.
          const problem = uiTreeProblem(tree);
          if (problem)
            throw new HostOpError(
              'bad_request',
              `The interface "${key}" cannot be shown: ${problem}`,
              'not_started',
            );
          const prev = this.view.state.ui[key];
          this.view.state.ui[key] = { status: 'open', durable: prev?.durable ?? {}, rev };
          this.view.ui = [
            ...this.view.ui.filter((u) => u.key !== key),
            { key, status: 'open', tree, rev, openedAt: new Date().toISOString() },
          ];
          this.line('call', `ui.present("${key}")`);
        },
        renderUi: (key, tree, rev) => {
          const problem = uiTreeProblem(tree);
          if (problem) {
            // Main drops it and keeps the last tree (the host only logs the failure).
            this.line('error', `render of "${key}" refused: ${problem}`);
            return;
          }
          this.view.ui = this.view.ui.map((u) => (u.key === key ? { ...u, tree, rev } : u));
          const saved = this.view.state.ui[key];
          if (saved) saved.rev = rev;
          this.changed();
        },
        setDurable: (key, name, value) => {
          const saved = this.view.state.ui[key];
          if (saved) saved.durable = { ...saved.durable, [name]: value };
          this.line(
            'state',
            `useDurableState "${name}" = ${short(value)}`,
            `durable:${key}:${name}`,
          );
        },
        closeUi: async (key, result) => {
          // Like main: what the user answered in fields with a vaultKey goes to Mis datos.
          const answers = uiTreeAnswers(this.view.ui.find((u) => u.key === key)?.tree);
          this.view.state.ui[key] = { status: 'closed', result };
          this.view.ui = this.view.ui.filter((u) => u.key !== key);
          this.line('call', `ui.close("${key}") → ${short(result)}`);
          if (answers.length) {
            this.line(
              'state',
              `the app saves to Mis datos: ${answers.map((a) => a.key).join(', ')}`,
            );
            await host.saveAnswers?.(answers);
          }
        },
      },
      onLog: (text) => this.line('log', text),
    });
    for (const p of host.procedures ?? []) this.procedures.set(p.id, p);
    if (host.history?.length) {
      // Recorded, not announced: nothing is told about a run before start().
      this.nextLine = Math.max(...host.history.map((l) => l.id)) + 1;
      this.view.lines = [
        ...host.history,
        { id: this.nextLine++, kind: 'state', text: '— resumed from its durable state —' },
      ];
    }
    void this.run.done.then((outcome) => {
      this.finished = true;
      for (const withdraw of this.withdraw) withdraw();
      this.withdraw.clear();
      // The run is over: nothing of it waits for the user any more.
      this.view.prompts = [];
      this.view.ui = [];
      this.view.status = outcome.status;
      if (outcome.status === 'succeeded') this.view.result = outcome.value;
      else if (outcome.status === 'failed') this.view.error = outcome.error;
      else this.view.error = outcome.reason;
      this.changed();
    });
  }

  start(): void {
    void this.run.start();
    this.changed();
  }

  stop(reason = 'Stopped in the playground'): void {
    this.run.cancel(reason);
  }

  /** The user acted on an interface (`codemode.uiEvent`). */
  uiEvent(key: string, event: UiEvent): boolean {
    const outcome = this.run.dispatch(key, event);
    const value = event.value === undefined ? '' : ` ${short(event.value)}`;
    this.line('event', `${event.handler}${value}${outcome === 'ok' ? '' : ` (${outcome})`}`);
    return outcome !== 'closed';
  }

  /** The app could not draw an interface: present() throws at its line, as main makes it. */
  uiFailed(key: string, rev: number, detail: string): boolean {
    if (!this.view.ui.some((u) => u.key === key)) return false;
    this.view.ui = this.view.ui.filter((u) => u.key !== key);
    this.line('error', `the app could not draw "${key}": ${detail}`);
    this.run.dispatch(key, { handler: UI_FAILED, rev, value: detail });
    return true;
  }

  private changed(): void {
    if (!this.finished)
      this.view.status =
        this.view.ui.length || this.view.prompts.length ? 'waiting_user' : 'running';
    this.host.onChange({
      ...this.view,
      ui: [...this.view.ui],
      prompts: [...this.view.prompts],
      procedures: [...this.procedures.values()],
      lines: [...this.view.lines],
      state: structuredClone(this.view.state),
    });
  }

  /** Adds a line to the log; one with `replace` overwrites the previous line with that id. */
  private line(kind: RunLine['kind'], text: string, replace?: string): void {
    const last = this.view.lines.at(-1);
    if (replace && last?.replace === replace)
      this.view.lines = [...this.view.lines.slice(0, -1), { ...last, text }];
    else {
      const line = { id: this.nextLine++, kind, text, ...(replace ? { replace } : {}) };
      this.view.lines = [...this.view.lines, line].slice(-LINE_LIMIT);
    }
    this.changed();
  }

  // --- the host's operations, with example data ------------------------------------------------

  private async call(op: string, args: Record<string, unknown>, signal: AbortSignal) {
    const tr = (es: string, en: string) => (this.host.lang === 'en' ? en : es);
    switch (op) {
      case 'setStatus':
        this.view.agentStatus = String(args.status);
        this.view.since = new Date().toISOString();
        this.line('call', `setStatus(${short(args.status)})`);
        return undefined;
      case 'fetchUrl': {
        this.line('call', `fetchUrl(${short(args.url)})`);
        await this.wait(signal);
        return examplePage(String(args.url));
      }
      case 'search': {
        this.line('call', `search(${short(args.prompt)})`);
        await this.wait(signal);
        return tr(
          'Sí. Con el DNI y el contrato de alquiler a tu nombre basta; si no está a tu nombre, añade la autorización del casero.',
          'Yes. Your DNI and a rental contract in your name are enough; if it is not in your name, add the landlord’s authorisation.',
        );
      }
      case 'procedures.getOrCreate': {
        const id = `p_${String(args.id)}`;
        const existing = this.procedures.get(id);
        if (existing) return fieldsOf(existing);
        const { id: _key, ...fields } = args;
        const created = {
          ...emptyProcedure(id, String(args.title)),
          status: 'in_progress',
          ...fields,
          id,
          version: 1,
          runtime: { activity: 'idle', unread: false },
        } as ProcedureListItem;
        this.procedures.set(id, created);
        this.line('call', `procedures.getOrCreate(${short(args.id)}) → ${id}`);
        return fieldsOf(created);
      }
      case 'procedures.get': {
        const found = this.procedures.get(String(args.id));
        if (!found)
          throw new HostOpError('not_found', `No procedure ${String(args.id)}`, 'not_started');
        return fieldsOf(found);
      }
      case 'procedures.list':
        return [...this.procedures.values()].map(fieldsOf);
      case 'procedures.update': {
        const found = this.procedures.get(String(args.id));
        if (!found)
          throw new HostOpError('not_found', `No procedure ${String(args.id)}`, 'not_started');
        if (args.expectedVersion !== found.version)
          throw new HostOpError(
            'conflict',
            'The procedure changed since you read it.',
            'not_started',
          );
        const updated = {
          ...found,
          ...(args.patch as Partial<ProcedureListItem>),
          version: (found.version ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        } as ProcedureListItem;
        // nextAction: null clears it.
        if (updated.nextAction === null) delete updated.nextAction;
        this.procedures.set(String(args.id), updated);
        this.line('call', `procedure.update(${short(args.patch)})`);
        return fieldsOf(updated);
      }
      case 'user.confirm':
      case 'user.requestAction':
      case 'user.requestCredential':
      case 'user.phoneCall':
        return this.ask(op, args, signal);
    }
    this.line('error', `${op}: not available in the playground`);
    throw new HostOpError(
      'not_available',
      `${op} is not available in the playground: it answers ui, state, setStatus, fetchUrl, search, procedures and user.`,
      'not_started',
    );
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, this.host.delayMs ?? 1400);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      });
    });
  }

  /** A question of the host's (approvals, actions, credentials, calls), answered on the page. */
  private ask(op: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const prompt = promptOf(op, args);
    const item: PromptItem = {
      id: `${this.workflowId}-prompt-${this.nextPrompt++}`,
      type: 'prompt',
      createdAt: new Date().toISOString(),
      prompt,
      status: 'pending',
    };
    this.line('call', `${op}(${short(args.title)})`);
    return new Promise((resolve, reject) => {
      const done = () => {
        this.withdraw.delete(withdraw);
        this.view.prompts = this.view.prompts.filter((p) => p.id !== item.id);
      };
      const withdraw = this.host.ask(item, (answered) => {
        done();
        const response: PromptResponse | undefined = answered.response;
        if (answered.status !== 'answered' || !response) {
          this.line('event', `${op} → cancelled`);
          reject(
            new HostOpError('user_rejected', 'The user dismissed the question.', 'not_started'),
          );
          return;
        }
        this.line('event', `${op} → ${short(response)}`);
        resolve(response);
      });
      this.withdraw.add(withdraw);
      signal.addEventListener('abort', () => {
        withdraw();
        done();
        reject(signal.reason);
      });
      this.view.prompts = [...this.view.prompts, item];
      this.changed();
    });
  }
}

/** A procedure as workflows read it: no runtime. */
function fieldsOf(procedure: ProcedureListItem) {
  const { runtime: _runtime, ...fields } = procedure;
  return fields;
}

/** What main asks for each `api.user.*` call (packages/agent/src/codemode/host-ops.ts). */
function promptOf(op: string, a: Record<string, unknown>): Prompt {
  const title = String(a.title ?? '');
  const message = String(a.message ?? '');
  switch (op) {
    case 'user.confirm':
      return {
        kind: 'confirm',
        confirmKind: a.kind === 'submission' || a.kind === 'payment' ? a.kind : 'action',
        title,
        message,
        ...(Array.isArray(a.details)
          ? { details: a.details as { label: string; value: string }[] }
          : {}),
        ...(typeof a.confirmLabel === 'string' ? { confirmLabel: a.confirmLabel } : {}),
        ...(a.danger === true ? { danger: true } : {}),
      };
    case 'user.requestAction':
      return {
        kind: 'user_action',
        actionKind: a.kind as 'manual_step',
        title,
        message,
        showBrowser: a.showBrowser !== false,
      };
    case 'user.requestCredential':
      return { kind: 'credential', credential: a.credential as 'clave_permanente', title, message };
    default:
      return { kind: 'phone_call', ...(a as object) } as Prompt;
  }
}

/** The example pages `fetchUrl` reads: the DNI appointment's free slots. */
function examplePage(url: string) {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {}
  if (parsed?.hostname !== 'sede.example.gob.es')
    throw new HostOpError('not_found', `The playground has no page at ${url}`, 'not_started');
  const from = parsed.searchParams.get('desde') || '2026-12-01';
  const times =
    parsed.searchParams.get('franja') === 'afternoon'
      ? ['16:10', '16:45', '17:30', '18:20']
      : ['09:10', '09:40', '10:30', '12:20'];
  const start = new Date(`${from}T12:00:00Z`);
  const slots: string[] = [];
  for (let day = 1; day <= 8; day++) {
    const date = new Date(start.getTime() + day * 86_400_000).toISOString().slice(0, 10);
    for (const time of times.slice(0, 1 + (day % times.length))) slots.push(`${date}T${time}`);
  }
  return {
    url,
    title: 'Cita previa DNI',
    text: `# Huecos libres\n\n${slots.map((s) => `- ${s}`).join('\n')}\n`,
    truncated: false,
  };
}

/** A value in one short line, for the log. */
function short(value: unknown): string {
  const text = value === undefined ? 'undefined' : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
