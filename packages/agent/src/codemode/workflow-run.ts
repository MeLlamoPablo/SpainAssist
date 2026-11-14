import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import { UI_COMPONENTS, type UiNode } from '@sa/shared';
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from 'quickjs-emscripten-core';
import { KERNEL } from './kernel';
import { transformError, transformModule } from './transform';

/**
 * Executes one run of a codemode workflow: the module's `main(api)` in a fresh QuickJS
 * (WebAssembly) instance, with durable state restored from `state`. A run stays alive while the
 * workflow waits for the user (an open interface keeps its component closures), and ends when
 * `main` settles or the run is cancelled.
 *
 * Resuming is re-running: memoized values (`api.state.memo`) and closed interfaces come from
 * `state`, open interfaces re-render with their durable state. See docs/codemode.md.
 */

interface UiState {
  status: 'open' | 'closed';
  result?: unknown;
  durable?: Record<string, unknown>;
  rev?: number;
}

export interface WorkflowState {
  memo: Record<string, { value?: unknown }>;
  ui: Record<string, UiState>;
}

/** Where durable state goes. Promises must resolve only once the change is stored. */
export interface DurableStore {
  setMemo(key: string, value: unknown): Promise<void>;
  deleteMemo(key: string): Promise<void>;
  openUi(key: string, tree: UiNode, rev: number): Promise<void>;
  /** A newer tree of an open interface (best effort; later trees supersede it). */
  renderUi(key: string, tree: UiNode, rev: number): void;
  /** A durable value of an open interface changed (best effort, in order). */
  setDurable(key: string, name: string, value: unknown): void;
  closeUi(key: string, result: unknown): Promise<void>;
}

/** A failure of a host operation, as the workflow sees it (`CodemodeError`). */
export class HostOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly effect: 'not_started' | 'applied' | 'unknown' = 'unknown',
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HostOpError';
  }
}

export type HostOp = (op: string, args: unknown, ctx: { signal: AbortSignal }) => Promise<unknown>;

export interface RunOptions {
  workflowId: string;
  source: string;
  state: WorkflowState;
  /** Procedures the workflow serves, primary first. */
  procedures: string[];
  /** Every operation except durable state and interfaces, which go to `store`. */
  call: HostOp;
  store: DurableStore;
  onLog?: (line: string) => void;
  /** Open interfaces changed (a run with open interfaces is waiting for the user). */
  onUiChange?: (open: string[]) => void;
  limits?: Partial<RunLimits>;
}

export interface RunLimits {
  /** QuickJS heap. Default 64 MB. */
  memoryBytes: number;
  /** Longest synchronous stretch of workflow code. Default 5 s. */
  sliceMs: number;
  /** Host operations in flight at once; the rest wait. Default 8. */
  concurrency: number;
  /** Logs kept. Default 20,000 characters. */
  logChars: number;
}

export type RunOutcome =
  | { status: 'succeeded'; value?: string; logs: string[]; images: string[] }
  | { status: 'failed'; error: string; code?: string; logs: string[]; images: string[] }
  | { status: 'cancelled'; reason: string; logs: string[]; images: string[] };

const DEFAULT_LIMITS: RunLimits = {
  memoryBytes: 64 * 1024 * 1024,
  sliceMs: 5_000,
  concurrency: 8,
  logChars: 20_000,
};

// Node's WebAssembly global, which neither the ES2023 lib nor @types/node types.
declare const WebAssembly: {
  Memory: new (descriptor: {
    initial: number;
    maximum: number;
  }) => { readonly buffer: ArrayBuffer };
};
const WASM_PAGE_BYTES = 64 * 1024;
const BASE_HEAP_BYTES = 16 * 1024 * 1024;
const MAX_WASM_PAGES = 32768;
const HEAP_SLACK_BYTES = 1024 * 1024;
/** Jobs run between two checks of the slice (see runJobs). */
const JOB_BATCH = 1000;

/** Ops the runtime answers itself (durable state and interfaces). */
const STATE_OPS = new Set(['state.set', 'state.delete', 'ui.open', 'ui.close']);

export class WorkflowRun {
  readonly done: Promise<RunOutcome>;
  private resolveDone!: (outcome: RunOutcome) => void;
  private readonly limits: RunLimits;
  private readonly logs: string[] = [];
  private logChars = 0;
  private readonly abort = new AbortController();
  private readonly unsettled = new Set<QuickJSDeferredPromise>();
  private readonly open = new Set<string>();
  private runtime?: QuickJSRuntime;
  private context?: QuickJSContext;
  private dispatchFn?: QuickJSHandle;
  private imagesFn?: QuickJSHandle;
  private memory?: { readonly buffer: ArrayBuffer };
  private maxHeapBytes = 0;
  private sliceStart = 0;
  private finished = false;
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly options: RunOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** Interfaces open right now. */
  openUis(): string[] {
    return [...this.open];
  }

  /** Starts the run; `done` settles with its outcome. */
  async start(): Promise<void> {
    let code: string;
    try {
      code = transformModule(this.options.source);
    } catch (error) {
      this.finish({ status: 'failed', error: transformError(error), code: 'syntax' });
      return;
    }
    try {
      await this.boot(code);
    } catch (error) {
      this.finish({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        code: 'internal',
      });
    }
  }

  /** The user acted on an open interface. Returns what happened, for logs and tests. */
  dispatch(
    key: string,
    event: { handler: string; rev: number; value?: unknown },
  ): 'ok' | 'stale' | 'closed' {
    const context = this.context;
    const fn = this.dispatchFn;
    if (this.finished || !context || !fn) return 'closed';
    const args: QuickJSHandle[] = [];
    let outcome: 'ok' | 'stale' | 'closed' = 'closed';
    try {
      args.push(
        context.newString(key),
        context.newString(event.handler),
        context.newNumber(event.rev),
        this.newString(context, event.value === undefined ? '' : JSON.stringify(event.value)),
      );
      const result = this.enter(() => context.callFunction(fn, context.undefined, ...args));
      if (result.error) {
        const message = takeErrorText(context, result.error);
        this.finish({ status: 'failed', error: message, code: 'handler' });
        return 'closed';
      }
      outcome = context.getString(result.value) as typeof outcome;
      result.value.dispose();
    } catch (error) {
      // Workflow code shares the kernel's realm and can break what it calls: this run fails,
      // never the process (the chat and the agent's other runs live there).
      this.finish({ status: 'failed', error: messageOf(error), code: 'handler' });
      return 'closed';
    } finally {
      for (const arg of args) if (arg.alive) arg.dispose();
    }
    this.runJobs();
    return outcome;
  }

  /** Stops the run: pending operations are aborted and open interfaces stay as they are. */
  cancel(reason = 'Cancelled'): void {
    if (this.finished) return;
    this.finish({ status: 'cancelled', reason });
  }

  private log(line: string): void {
    if (this.logChars >= this.limits.logChars) return;
    const text = line.slice(0, this.limits.logChars - this.logChars);
    this.logs.push(text);
    this.logChars += text.length;
    if (this.logChars >= this.limits.logChars) this.logs.push('… more log output dropped');
    this.options.onLog?.(text);
  }

  private enter<T>(fn: () => T): T {
    this.sliceStart = Date.now();
    return fn();
  }

  /**
   * Copies a string into the engine, as run_script does: when the heap can't grow enough, a
   * failed malloc returns 0 and the copy would overwrite the start of the heap.
   */
  private newString(context: QuickJSContext, text: string): QuickJSHandle {
    const size = this.memory?.buffer.byteLength ?? 0;
    const bytes = utf8Length(text) + text.length * 2;
    if (Math.max(size * 1.05, size + bytes) + HEAP_SLACK_BYTES > this.maxHeapBytes)
      throw new RangeError(
        `Out of memory (limit ${Math.round(this.limits.memoryBytes / (1024 * 1024))} MB)`,
      );
    return context.newString(text);
  }

  private runJobs(): void {
    const runtime = this.runtime;
    const context = this.context;
    if (this.finished || !runtime || !context) return;
    this.sliceStart = Date.now();
    try {
      // In batches, checking the slice between them: a job may queue another for ever (an async
      // loop that restarts itself when interrupted), and one call would then never return.
      for (;;) {
        const result = runtime.executePendingJobs(JOB_BATCH);
        if (result.error) {
          const message = takeErrorText(context, result.error);
          this.finish({ status: 'failed', error: interrupted(message, this.limits.sliceMs) });
          return;
        }
        if (this.finished || result.value < JOB_BATCH) return;
        if (Date.now() - this.sliceStart > this.limits.sliceMs) {
          this.finish({
            status: 'failed',
            error: interrupted('InternalError: interrupted', this.limits.sliceMs),
          });
          return;
        }
      }
    } catch (error) {
      this.finish({ status: 'failed', error: messageOf(error), code: 'internal' });
    }
  }

  private async boot(code: string): Promise<void> {
    const { memoryBytes } = this.limits;
    const maxPages = Math.min(
      MAX_WASM_PAGES,
      Math.ceil((BASE_HEAP_BYTES + 2 * memoryBytes) / WASM_PAGE_BYTES),
    );
    const memory = new WebAssembly.Memory({
      initial: BASE_HEAP_BYTES / WASM_PAGE_BYTES,
      maximum: maxPages,
    });
    this.memory = memory;
    this.maxHeapBytes = maxPages * WASM_PAGE_BYTES;
    const module = await newQuickJSWASMModuleFromVariant(
      newVariant(variant, { wasmMemory: memory as never }),
    );
    if (this.finished) return;
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(memoryBytes);
    runtime.setMaxStackSize(1024 * 1024);
    runtime.setInterruptHandler(() => Date.now() - this.sliceStart > this.limits.sliceMs);
    const context = runtime.newContext();
    this.runtime = runtime;
    this.context = context;

    const fns: Record<string, (...args: QuickJSHandle[]) => QuickJSHandle | undefined> = {
      __hostCall: (op, args) => this.hostCall(context.getString(op), context.getString(args)),
      __hostEmit: (kind, json) => {
        this.hostEmit(context.getString(kind), context.getString(json));
        return undefined;
      },
      __hostLog: (line) => {
        this.log(context.getString(line));
        return undefined;
      },
    };
    for (const [name, fn] of Object.entries(fns)) {
      const handle = context.newFunction(name, fn);
      context.setProp(context.global, name, handle);
      handle.dispose();
    }
    const bootJson = this.newString(
      context,
      JSON.stringify({
        workflowId: this.options.workflowId,
        procedures: [...this.options.procedures],
        state: this.options.state,
        components: UI_COMPONENTS,
      }),
    );
    context.setProp(context.global, '__boot', bootJson);
    bootJson.dispose();
    this.enter(() => context.unwrapResult(context.evalCode(KERNEL, 'kernel.js')).dispose());
    this.dispatchFn = context.getProp(context.global, '__sa_dispatch');
    this.imagesFn = context.getProp(context.global, '__sa_images');
    const mainFn = context.getProp(context.global, '__sa_main');
    for (const name of ['__sa_dispatch', '__sa_images', '__sa_main', '__sa_openUis']) {
      context.unwrapResult(context.evalCode(`delete globalThis.${name}`)).dispose();
    }

    // Same first line as the module, so error positions match the model's line numbers.
    const factory = this.enter(() =>
      context.evalCode(`(function (module, exports, require) {${code}\n})`, 'workflow.js'),
    );
    if (factory.error) {
      const message = takeErrorText(context, factory.error);
      mainFn.dispose();
      this.finish({ status: 'failed', error: message, code: 'syntax' });
      return;
    }
    const started = this.enter(() =>
      context.callFunction(mainFn, context.undefined, factory.value),
    );
    factory.value.dispose();
    mainFn.dispose();
    if (started.error) {
      const message = takeErrorText(context, started.error);
      this.finish({ status: 'failed', error: interrupted(message, this.limits.sliceMs) });
      return;
    }
    const promise = started.value;
    const settled = context.resolvePromise(promise);
    promise.dispose();
    this.runJobs();
    const result = await Promise.race([settled, this.done.then(() => null)]);
    if (!result) return;
    if (this.finished) {
      if (result.error) result.error.dispose();
      else result.value.dispose();
      return;
    }
    if (result.error) {
      const code = errorCode(context, result.error);
      const message = takeErrorText(context, result.error);
      this.finish({
        status: 'failed',
        error: interrupted(message, this.limits.sliceMs),
        ...(code ? { code } : {}),
      });
      return;
    }
    const value = context.getString(result.value);
    result.value.dispose();
    this.finish({ status: 'succeeded', ...(value ? { value } : {}) });
  }

  private images(): string[] {
    const context = this.context;
    const fn = this.imagesFn;
    if (!context || !fn) return [];
    try {
      const result = this.enter(() => context.callFunction(fn, context.undefined));
      if (result.error) {
        result.error.dispose();
        return [];
      }
      const ids = JSON.parse(context.getString(result.value)) as string[];
      result.value.dispose();
      return ids;
    } catch {
      return [];
    }
  }

  private finish(
    outcome:
      | { status: 'succeeded'; value?: string }
      | { status: 'failed'; error: string; code?: string }
      | { status: 'cancelled'; reason: string },
  ): void {
    if (this.finished) return;
    const images = this.images();
    this.finished = true;
    this.abort.abort(new Error(outcome.status === 'cancelled' ? outcome.reason : 'Run ended'));
    const logs = [...this.logs];
    this.resolveDone({ ...outcome, logs, images } as RunOutcome);
    // Release the engine once the current host callback (if any) has returned.
    queueMicrotask(() => this.dispose());
  }

  private dispose(): void {
    try {
      for (const deferred of this.unsettled) deferred.dispose();
      this.unsettled.clear();
      this.dispatchFn?.dispose();
      this.imagesFn?.dispose();
      this.context?.dispose();
      this.runtime?.dispose();
    } catch {
      // Handles still held by the unfinished program: the WebAssembly instance is dropped anyway.
    }
    this.dispatchFn = undefined;
    this.imagesFn = undefined;
    this.context = undefined;
    this.runtime = undefined;
  }

  private hostEmit(kind: string, json: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    const { store } = this.options;
    if (kind === 'ui.render') {
      if (!this.open.has(String(payload.key))) return;
      store.renderUi(String(payload.key), payload.tree as UiNode, Number(payload.rev));
    } else if (kind === 'ui.durable') {
      if (!this.open.has(String(payload.key))) return;
      store.setDurable(String(payload.key), String(payload.name), payload.value);
    }
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    while (this.inFlight >= this.limits.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.inFlight++;
    try {
      return await work();
    } finally {
      this.inFlight--;
      this.waiting.shift()?.();
    }
  }

  private async stateOp(op: string, args: Record<string, unknown>): Promise<unknown> {
    const { store } = this.options;
    const key = String(args.key);
    switch (op) {
      case 'state.set':
        await store.setMemo(key, args.value);
        return undefined;
      case 'state.delete':
        await store.deleteMemo(key);
        return undefined;
      case 'ui.open':
        await store.openUi(key, args.tree as UiNode, Number(args.rev));
        this.open.add(key);
        this.options.onUiChange?.(this.openUis());
        return undefined;
      case 'ui.close':
        await store.closeUi(key, args.result);
        this.open.delete(key);
        this.options.onUiChange?.(this.openUis());
        return undefined;
    }
    throw new HostOpError('internal', `Unknown state operation ${op}`);
  }

  /** Hands a host operation's outcome to the engine; a failure there fails this run only. */
  private settle(deliver: (context: QuickJSContext) => void): void {
    const context = this.context;
    if (this.finished || !context) return;
    try {
      // A fresh slice: the interrupt handler would stop the engine if the operation took longer.
      this.enter(() => deliver(context));
    } catch (error) {
      this.finish({ status: 'failed', error: messageOf(error), code: 'internal' });
    }
  }

  private hostCall(op: string, argsJson: string): QuickJSHandle {
    const context = this.context;
    if (!context) throw new Error('Run ended');
    const deferred = context.newPromise();
    this.unsettled.add(deferred);
    let args: unknown;
    try {
      args = JSON.parse(argsJson);
    } catch {
      args = {};
    }
    const work = STATE_OPS.has(op)
      ? this.stateOp(op, args as Record<string, unknown>)
      : this.limited(() => this.options.call(op, args, { signal: this.abort.signal }));
    work.then(
      (value) =>
        this.settle((context) => {
          const handle = this.newString(context, value === undefined ? '' : JSON.stringify(value));
          deferred.resolve(handle);
          handle.dispose();
        }),
      (error: unknown) =>
        this.settle((context) => {
          const handle = context.newError(JSON.stringify(errorInfo(error, op)));
          deferred.reject(handle);
          handle.dispose();
        }),
    );
    deferred.settled.then(() => {
      this.unsettled.delete(deferred);
      this.runJobs();
    });
    return deferred.handle;
  }
}

function errorInfo(error: unknown, op: string): Record<string, unknown> {
  if (error instanceof HostOpError) {
    return {
      code: error.code,
      message: error.message,
      op,
      effect: error.effect,
      retryable: error.retryable,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'internal', message, op, effect: 'unknown', retryable: false };
}

/** Buffer.byteLength(text, 'utf8') without Node: the agent playground runs it in a browser. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
      // A surrogate pair: 4 bytes for both halves.
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next < 0xe000) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The text of what the workflow threw, releasing its handle. Workflow code chooses what it
 * throws (even a Promise, whose dump releases handles itself): reading it never throws here.
 */
function takeErrorText(context: QuickJSContext, handle: QuickJSHandle): string {
  try {
    return errorText(context, handle);
  } catch (error) {
    return messageOf(error);
  } finally {
    if (handle.alive) handle.dispose();
  }
}

function errorCode(context: QuickJSContext, handle: QuickJSHandle): string | undefined {
  let dumped: unknown;
  try {
    dumped = context.dump(handle);
  } catch {
    return undefined;
  }
  if (dumped && typeof dumped === 'object' && 'code' in dumped) {
    const code = (dumped as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function errorText(context: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = context.dump(handle) as unknown;
  if (dumped && typeof dumped === 'object' && 'message' in dumped) {
    const { name, message, stack, code, op } = dumped as {
      name?: string;
      message?: string;
      stack?: string;
      code?: string;
      op?: string;
    };
    const head = `${name ?? 'Error'}${code ? ` [${code}${op ? ` in ${op}` : ''}]` : ''}: ${message ?? ''}`;
    const frames = (stack ?? '')
      .split('\n')
      .filter((line) => line.includes('workflow.js'))
      .map((line) => line.trim())
      .slice(0, 6);
    return frames.length ? `${head}\n${frames.join('\n')}` : head;
  }
  return typeof dumped === 'string' ? dumped : JSON.stringify(dumped);
}

function interrupted(message: string, sliceMs: number): string {
  return /InternalError: interrupted/.test(message)
    ? `Stopped: the workflow ran for more than ${Math.round(sliceMs / 1000)} s without waiting for anything (an endless loop?).`
    : message;
}
