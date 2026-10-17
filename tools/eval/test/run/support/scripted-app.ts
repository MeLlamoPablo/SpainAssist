import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PromptResponse } from '@sa/shared';
import type {
  AgentKind,
  CreateEvalApp,
  EvalApp,
  EvalAppDeps,
  EvalAppSpec,
  Observation,
  ObservationInput,
  PendingPrompt,
} from '../../../src/contracts';
import type { FakeBench } from './fake-bench';
import type { FakeMeterRun } from './fake-meter';

export interface FakeDocument {
  id: string;
  name: string;
  mimeType: string;
  source?: string;
  procedureId?: string;
  bytes: Uint8Array;
}

/** What a script can do while it plays "the agents". */
export interface ScriptContext {
  readonly app: ScriptedApp;
  readonly spec: EvalAppSpec;
  readonly signal: AbortSignal;
  readonly bench: FakeBench;
  readonly meterRun: FakeMeterRun;
  /** What an earlier run's checkpoint stored in `state` (a resumed run), else `{}`. */
  readonly state: Record<string, unknown>;
  emit(input: ObservationInput): Observation | undefined;
  tool(agent: AgentKind, tool: string, args?: unknown, toolCallId?: string): void;
  say(agent: AgentKind, text: string): void;
  /** Shows a prompt (listed as pending first) and waits for the simulator's answer. */
  ask(prompt: PendingPrompt): Promise<PromptResponse>;
  /** One model request of the agents, as the meter would see it. Stops the script when refused. */
  model(costUsd?: number, agent?: string): void;
  sleep(ms: number): Promise<void>;
  vaultChanged(): void;
  /** A marker the test can read afterwards (`app.reached`). */
  mark(name: string): void;
}

export type Script = (ctx: ScriptContext) => Promise<void>;

export interface ScriptedAppOptions {
  /** How long `idle()` must hold for `untilIdle` (default 3 ms). */
  holdMs?: number;
  /** `abort()` never resolves. */
  hangOnAbort?: boolean;
  /** `close()` never resolves. */
  hangOnClose?: boolean;
  /** `respond` waits for this before answering (a slow app). */
  respondGate?: () => Promise<void>;
  /** `respond` fails with this (the prompt stays pending). */
  respondError?: Error;
  addClaveError?: Error;
  checkpointError?: Error;
  /** Forms a restored app lists as pending without announcing them (a resumed run). */
  restoredPrompts?: PendingPrompt[];
  /** Runs when the vault is read (the rules read it when they judge the run). */
  onVaultRead?: (app: ScriptedApp) => void;
}

class Aborted extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

/**
 * A fake `EvalApp` that plays a script instead of running agents: it pushes observations into
 * the run's sink, lists prompts as pending until they are answered, counts tool calls and
 * prompts, goes idle when the script ends, and can hang on abort.
 */
export class ScriptedApp implements EvalApp {
  readonly runDir: string;
  readonly sent: string[] = [];
  readonly responses: { itemId: string; response: PromptResponse }[] = [];
  readonly claves: { username: string; password: string; label?: string }[] = [];
  readonly secrets: string[] = [];
  readonly documents: FakeDocument[] = [];
  readonly reached: string[] = [];
  readonly state: Record<string, unknown> = {};
  readonly abortReasons: string[] = [];
  leaks: string[] = [];
  closeCalls = 0;
  checkpointCalls = 0;
  modelCalls = 0;
  /** Things a stopped script tried to do after `abort()`: must stay 0. */
  lateActions = 0;
  scriptError: unknown;
  running = false;
  aborted = false;
  closed = false;

  private toolCalls = 0;
  private prompts = 0;
  private readonly pending = new Map<
    string,
    { prompt: PendingPrompt; resolve: (r: PromptResponse) => void; reject: (e: Error) => void }
  >();
  private readonly changed = new Set<() => void>();
  private readonly controller = new AbortController();
  private started = false;
  private readonly bench: FakeBench;
  private readonly meterRun: FakeMeterRun;

  constructor(
    readonly spec: EvalAppSpec,
    deps: EvalAppDeps,
    private readonly script: Script,
    bench: FakeBench,
    private readonly options: ScriptedAppOptions = {},
  ) {
    this.runDir = spec.runDir;
    this.bench = bench;
    this.meterRun = deps.meter as unknown as FakeMeterRun;
    if (spec.restoreFrom) {
      const stored = JSON.parse(
        readFileSync(join(spec.restoreFrom.profileDir, 'state.json'), 'utf8'),
      ) as {
        state: Record<string, unknown>;
        documents: (Omit<FakeDocument, 'bytes'> & { bytes: string })[];
      };
      Object.assign(this.state, stored.state);
      for (const doc of stored.documents) {
        this.documents.push({ ...doc, bytes: new Uint8Array(Buffer.from(doc.bytes, 'base64')) });
      }
      for (const prompt of options.restoredPrompts ?? []) {
        this.pending.set(prompt.itemId, { prompt, resolve: () => {}, reject: () => {} });
      }
      // As in the real app, nothing resumes by itself: the user's next message does.
    }
  }

  // ---- EvalApp -----------------------------------------------------------------------------

  async send(text: string): Promise<void> {
    this.sent.push(text);
    this.start();
  }

  pendingPrompts(): PendingPrompt[] {
    return [...this.pending.values()].map((entry) => entry.prompt);
  }

  async respond(itemId: string, response: PromptResponse): Promise<void> {
    await this.options.respondGate?.();
    if (this.options.respondError) throw this.options.respondError;
    const entry = this.pending.get(itemId);
    if (!entry) throw new Error(`No pending prompt ${itemId}`);
    this.pending.delete(itemId);
    this.responses.push({ itemId, response });
    entry.resolve(response);
    this.notify();
  }

  async addClave(input: { username: string; password: string; label?: string }): Promise<string> {
    if (this.options.addClaveError) throw this.options.addClaveError;
    this.claves.push(input);
    this.secrets.push(input.password);
    return `cred-${this.claves.length}`;
  }

  addSecret(value: string): void {
    this.secrets.push(value);
  }

  idle(): boolean {
    return !this.running && this.pending.size === 0;
  }

  untilIdle(
    options: { holdMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const holdMs = options.holdMs ?? this.options.holdMs ?? 3;
    return new Promise((resolve) => {
      let hold: NodeJS.Timeout | undefined;
      let timeout: NodeJS.Timeout | undefined;
      const finish = (value: boolean) => {
        clearTimeout(hold);
        clearTimeout(timeout);
        this.changed.delete(check);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish(false);
      const check = () => {
        clearTimeout(hold);
        if (this.idle()) hold = setTimeout(() => (this.idle() ? finish(true) : check()), holdMs);
      };
      if (options.signal?.aborted) return resolve(false);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.timeoutMs !== undefined)
        timeout = setTimeout(() => finish(false), options.timeoutMs);
      this.changed.add(check);
      check();
    });
  }

  counters(): { toolCalls: number; prompts: number } {
    return { toolCalls: this.toolCalls, prompts: this.prompts };
  }

  async vaultDocuments() {
    this.options.onVaultRead?.(this);
    return this.documents.map((doc) => ({
      id: doc.id,
      name: doc.name,
      mimeType: doc.mimeType,
      source: doc.source,
      procedureId: doc.procedureId,
      read: async () => doc.bytes,
    }));
  }

  secretLeaks(): string[] {
    return this.leaks;
  }

  async abort(reason: string): Promise<void> {
    this.abortReasons.push(reason);
    this.stop();
    if (this.options.hangOnAbort) await new Promise<never>(() => undefined);
  }

  async checkpoint(dir: string): Promise<{ profileDir: string; browserStateFile?: string }> {
    this.checkpointCalls++;
    if (this.options.checkpointError) throw this.options.checkpointError;
    if (!this.idle()) throw new Error('checkpoint while the app is not idle');
    const profileDir = join(dir, 'profile');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'state.json'),
      JSON.stringify({
        state: this.state,
        documents: this.documents.map((doc) => ({
          ...doc,
          bytes: Buffer.from(doc.bytes).toString('base64'),
        })),
      }),
    );
    const browserStateFile = join(dir, 'browser-state.json');
    writeFileSync(browserStateFile, '{"cookies":[]}');
    return { profileDir, browserStateFile };
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.closed = true;
    this.stop();
    if (this.options.hangOnClose) await new Promise<never>(() => undefined);
  }

  // ---- the script --------------------------------------------------------------------------

  private stop(): void {
    this.aborted = true;
    this.controller.abort();
    for (const entry of this.pending.values()) entry.reject(new Aborted());
    this.pending.clear();
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.changed]) listener();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.play(this.script);
  }

  /** The agents start working again (something woke them up while the run thought it was quiet). */
  wake(script: Script): void {
    this.play(script);
    this.notify();
  }

  private play(script: Script): void {
    this.running = true;
    // Like the real app: the agents start working after the call that started them returned.
    setImmediate(() => {
      void script(this.context())
        .catch((error) => {
          if (!(error instanceof Aborted)) this.scriptError = error;
        })
        .finally(() => {
          this.running = false;
          this.notify();
        });
    });
  }

  private live(): boolean {
    if (this.aborted) {
      this.lateActions++;
      return false;
    }
    return true;
  }

  private context(): ScriptContext {
    const app = this;
    const emit = (input: ObservationInput) => (app.live() ? app.spec.sink.push(input) : undefined);
    return {
      app,
      spec: app.spec,
      signal: app.controller.signal,
      bench: app.bench,
      meterRun: app.meterRun,
      state: app.state,
      emit,
      tool(agent, tool, args = {}, toolCallId = `${tool}-${app.toolCalls + 1}`) {
        if (!app.live()) throw new Aborted();
        app.toolCalls++;
        emit({ type: 'tool_start', agent, tool, args, toolCallId });
        emit({ type: 'tool_end', agent, tool, toolCallId, isError: false, text: 'ok' });
      },
      say(agent, text) {
        emit({ type: 'assistant_message', agent, text });
      },
      ask(prompt) {
        if (!app.live()) return Promise.reject(new Aborted());
        return new Promise<PromptResponse>((resolve, reject) => {
          app.pending.set(prompt.itemId, { prompt, resolve, reject });
          app.prompts++;
          emit({ type: 'prompt_shown', prompt });
          app.notify();
        });
      },
      model(costUsd = 0.001, agent = 'assistant') {
        if (!app.live()) throw new Aborted();
        app.modelCalls++;
        if (!app.meterRun.record(agent, costUsd)) throw new Error('the meter refused the request');
      },
      sleep(ms) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(done, ms);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Aborted());
          };
          function done() {
            app.controller.signal.removeEventListener('abort', onAbort);
            resolve();
          }
          app.controller.signal.addEventListener('abort', onAbort, { once: true });
        });
      },
      vaultChanged() {
        emit({ type: 'vault_changed' });
      },
      mark(name) {
        app.reached.push(name);
      },
    };
  }
}

/** A `CreateEvalApp` that plays `script`; the apps it made are in `apps`. */
export function scriptedCreateApp(
  script: Script,
  bench: FakeBench,
  options: ScriptedAppOptions = {},
): CreateEvalApp & { apps: ScriptedApp[] } {
  const apps: ScriptedApp[] = [];
  const make: CreateEvalApp = async (spec, deps) => {
    const app = new ScriptedApp(spec, deps, script, bench, options);
    apps.push(app);
    return app;
  };
  const create = Object.assign(make, { apps });
  return create;
}
