import type { ThinkingLevel } from '@sa/shared';
import { HOST_LOG_PREFIX } from '../host/log';
import type { AgentLaunch } from '../launch';
import { type AgentEvent, EventNormalizer } from './events';
import { JsonlSplitter, serializeJsonLine } from './jsonl';
import { type RpcTransport, type RpcTransportFactory, spawnTransport } from './transport';

/**
 * Our own client for pi's RPC protocol (pi's RpcClient spawns `node` from PATH and cannot answer
 * extension UI requests). One instance per agent host process.
 *
 *  - strict "\n" JSONL framing, command ids correlated with responses;
 *  - raw pi events normalized into AgentEvents (see events.ts);
 *  - pi extension dialogs are auto-cancelled (we never use them: our tools ask through the app);
 *  - the shell `bash` command is never sent;
 *  - abort = clear_queue + abort; stop = close stdin, then SIGTERM, then SIGKILL.
 */

export type PromptDisposition = 'started' | 'queued' | 'handled';

export interface PromptImage {
  mimeType: string;
  dataBase64: string;
}

export interface PromptOptions {
  /** How to deliver the message while the agent is running. Default "steer". */
  streamingBehavior?: 'steer' | 'followUp';
}

export interface AgentSessionInfo {
  sessionId: string;
  sessionFile?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  isStreaming: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface PiRpcClientOptions {
  /** Replace the stdio child-process transport (e.g. Electron utilityProcess). */
  transport?: RpcTransportFactory;
  /** Max wait for the host to answer its first command. Default 30 s. */
  startTimeoutMs?: number;
  /** Default timeout of regular commands. Default 60 s. */
  requestTimeoutMs?: number;
  /** Max wait for an abort to complete. Default 15 s. */
  abortTimeoutMs?: number;
  /** Grace period after closing stdin before SIGTERM. Default 3 s. */
  stopTimeoutMs?: number;
  /** Bytes of stderr kept for process_exit. Default 8 KiB. */
  stderrTailBytes?: number;
}

const FORBIDDEN_COMMANDS = new Set(['bash', 'abort_bash']);
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

interface Pending {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export class PiRpcClient {
  private transport?: RpcTransport;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly normalizer = new EventNormalizer();
  private readonly splitter = new JsonlSplitter((line) => this.handleLine(line));
  private stderrTail = '';
  private stderrLine = '';
  private exited?: { code: number | null; signal: string | null };
  private exitWaiters: (() => void)[] = [];
  private nextId = 0;
  private readonly idPrefix = `c${Date.now().toString(36)}`;

  constructor(
    private readonly launch: AgentLaunch,
    private readonly options: PiRpcClientOptions = {},
  ) {}

  /** True between run_start and run_end. */
  get running(): boolean {
    return this.normalizer.isRunning;
  }

  /** The process was started and has not exited. */
  get alive(): boolean {
    return this.transport !== undefined && this.exited === undefined;
  }

  get pid(): number | undefined {
    return this.transport?.pid;
  }

  on(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Spawns the host and waits until it answers (session restored, tools registered). */
  async start(): Promise<AgentSessionInfo> {
    if (this.transport) throw new Error('PiRpcClient.start() can only be called once');
    const transport = (this.options.transport ?? spawnTransport)(this.launch);
    this.transport = transport;
    transport.onStdout((chunk) => this.splitter.push(chunk));
    transport.onStderr((chunk) => this.handleStderr(chunk));
    transport.onExit((code, signal) => this.handleExit(code, signal));
    transport.onError((error) => {
      this.emit({ type: 'log', level: 'error', message: `Agent process error: ${error.message}` });
      if (transport.pid === undefined) {
        this.appendStderr(`${error.message}\n`);
        this.handleExit(null, null);
      }
    });
    try {
      const state = await this.request<Record<string, unknown>>(
        'get_state',
        {},
        this.options.startTimeoutMs ?? 30_000,
      );
      return toSessionInfo(state);
    } catch (error) {
      const tail = this.stderrTail.trim();
      await this.stop().catch(() => {});
      throw new Error(
        `The agent failed to start: ${(error as Error).message}${tail ? `\n${tail.slice(-2000)}` : ''}`,
      );
    }
  }

  /**
   * Sends a user message. Resolves when pi accepted it ("started", or "queued" when the agent was
   * already running); the run itself streams as events. Rejects when pi refuses it (e.g. no API
   * key for the model).
   */
  async prompt(
    text: string,
    images?: PromptImage[],
    options: PromptOptions = {},
  ): Promise<PromptDisposition> {
    const payload: Record<string, unknown> = { message: text };
    if (images?.length) {
      payload.images = images.map((image) => ({
        type: 'image',
        data: image.dataBase64,
        mimeType: image.mimeType,
      }));
    }
    const behavior = options.streamingBehavior ?? (this.running ? 'steer' : undefined);
    if (behavior) payload.streamingBehavior = behavior;
    try {
      const data = await this.request<{ disposition?: PromptDisposition }>('prompt', payload);
      return data?.disposition ?? 'started';
    } catch (error) {
      // An idle compaction is running (see idle-compaction.ts): the user is back before the
      // prompt cache expired, so it is no longer needed. `abort` cancels it and waits for idle.
      if (/while compaction is in progress/i.test((error as Error).message)) {
        await this.request('abort', {}, this.options.abortTimeoutMs ?? 15_000);
        const data = await this.request<{ disposition?: PromptDisposition }>('prompt', payload);
        return data?.disposition ?? 'started';
      }
      if (!behavior && /already processing/i.test((error as Error).message)) {
        const data = await this.request<{ disposition?: PromptDisposition }>('prompt', {
          ...payload,
          streamingBehavior: 'steer',
        });
        return data?.disposition ?? 'queued';
      }
      throw error;
    }
  }

  /** Queue a message for the running agent (delivered after the current tool calls). */
  async steer(text: string, images?: PromptImage[]): Promise<PromptDisposition> {
    if (!this.running) return this.prompt(text, images);
    return this.prompt(text, images, { streamingBehavior: 'steer' });
  }

  /** Queue a message to be handled after the current run finishes. */
  async followUp(text: string): Promise<PromptDisposition> {
    if (!this.running) return this.prompt(text);
    return this.prompt(text, undefined, { streamingBehavior: 'followUp' });
  }

  /**
   * Stops the current run: drops queued messages first (pi keeps them across an abort), then
   * aborts. Tools waiting on the app see their requests cancelled. Resolves when pi is idle.
   */
  async abort(): Promise<void> {
    if (!this.alive) return;
    this.normalizer.markAbortRequested();
    // Write both commands in order immediately. The host clears its queue synchronously;
    // waiting for that acknowledgement would leave a cancelled tool free to resume the run.
    await Promise.all([
      this.request('clear_queue', {}, 10_000).catch(() => {}),
      this.request('abort', {}, this.options.abortTimeoutMs ?? 15_000),
    ]);
  }

  async getState(): Promise<AgentSessionInfo> {
    return toSessionInfo(await this.request<Record<string, unknown>>('get_state', {}));
  }

  /** Token and cost totals of the session (`get_session_stats`). */
  async getSessionStats(): Promise<Record<string, unknown>> {
    return this.request('get_session_stats', {});
  }

  async getMessages(): Promise<unknown[]> {
    const data = await this.request<{ messages?: unknown[] }>('get_messages', {});
    return data?.messages ?? [];
  }

  async getLastAssistantText(): Promise<string | null> {
    const data = await this.request<{ text?: string | null }>('get_last_assistant_text', {});
    return data?.text ?? null;
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.request('set_thinking_level', { level });
  }

  async compact(customInstructions?: string): Promise<unknown> {
    return this.request('compact', customInstructions ? { customInstructions } : {}, 0);
  }

  /** Any other RPC command (except the shell ones, which are never allowed). */
  async send<T = unknown>(
    command: { type: string } & Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const { type, ...payload } = command;
    return this.request<T>(type, payload, timeoutMs);
  }

  /** Graceful shutdown: close stdin (pi disposes and exits), then SIGTERM, then SIGKILL. */
  async stop(): Promise<void> {
    const transport = this.transport;
    if (!transport || this.exited) return;
    // A run interrupted by a requested stop ends as aborted, not as a crash.
    this.normalizer.markAbortRequested();
    transport.closeInput();
    if (await this.waitForExit(this.options.stopTimeoutMs ?? 3_000)) return;
    transport.kill('SIGTERM');
    if (await this.waitForExit(2_000)) return;
    transport.kill('SIGKILL');
    await this.waitForExit(2_000);
  }

  // ---------------------------------------------------------------------------------------------

  private request<T = unknown>(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    if (FORBIDDEN_COMMANDS.has(type)) {
      return Promise.reject(new Error(`The "${type}" command is not allowed`));
    }
    const transport = this.transport;
    if (!transport || this.exited) {
      return Promise.reject(new Error('The agent process is not running'));
    }
    const id = `${this.idPrefix}-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        command: type,
        resolve: (data) => resolve(data as T),
        reject,
      };
      const limit = timeoutMs ?? this.options.requestTimeoutMs ?? 60_000;
      if (limit > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`The agent did not answer "${type}" in time`));
        }, limit);
      }
      this.pending.set(id, entry);
      transport.write(serializeJsonLine({ ...payload, id, type }));
    });
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit({
        type: 'log',
        level: 'warn',
        message: `Unparseable output from the agent: ${line.slice(0, 200)}`,
      });
      return;
    }
    if (message.type === 'response') {
      const id = typeof message.id === 'string' ? message.id : undefined;
      const entry = id ? this.pending.get(id) : undefined;
      if (entry && id) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        if (message.success === true) entry.resolve(message.data);
        else entry.reject(new Error(String(message.error ?? `${entry.command} failed`)));
      } else if (message.success === false) {
        this.emit({ type: 'log', level: 'warn', message: `Agent error: ${String(message.error)}` });
      }
      return;
    }
    if (message.type === 'extension_ui_request') {
      const method = String(message.method ?? '');
      if (DIALOG_METHODS.has(method) && typeof message.id === 'string') {
        this.transport?.write(
          serializeJsonLine({ type: 'extension_ui_response', id: message.id, cancelled: true }),
        );
        this.emit({ type: 'log', level: 'debug', message: `Cancelled a pi ${method} dialog` });
      } else if (method === 'notify' && typeof message.message === 'string') {
        this.emit({
          type: 'log',
          level:
            message.notifyType === 'error'
              ? 'error'
              : message.notifyType === 'warning'
                ? 'warn'
                : 'info',
          message: message.message,
        });
      }
      return;
    }
    for (const event of this.normalizer.push(message)) this.emit(event);
  }

  private appendStderr(text: string): void {
    const max = this.options.stderrTailBytes ?? 8_192;
    this.stderrTail = (this.stderrTail + text).slice(-max);
  }

  private handleStderr(chunk: string): void {
    this.appendStderr(chunk);
    this.stderrLine += chunk;
    let newline = this.stderrLine.indexOf('\n');
    while (newline >= 0) {
      const line = this.stderrLine.slice(0, newline).trimEnd();
      this.stderrLine = this.stderrLine.slice(newline + 1);
      if (line) this.emitStderrLine(line);
      newline = this.stderrLine.indexOf('\n');
    }
  }

  private emitStderrLine(line: string): void {
    if (line.startsWith(HOST_LOG_PREFIX)) {
      const rest = line.slice(HOST_LOG_PREFIX.length).trim();
      const space = rest.indexOf(' ');
      const level = space > 0 ? rest.slice(0, space) : '';
      if (LOG_LEVELS.has(level)) {
        this.emit({
          type: 'log',
          level: level as 'debug' | 'info' | 'warn' | 'error',
          message: rest.slice(space + 1),
        });
        return;
      }
    }
    this.emit({ type: 'log', level: 'debug', message: line });
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = { code, signal };
    this.splitter.end();
    if (this.stderrLine.trim()) this.emitStderrLine(this.stderrLine.trim());
    this.stderrLine = '';
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(`The agent process exited (code ${code}, signal ${signal})`));
      this.pending.delete(id);
    }
    const reason =
      code === 0 && !signal
        ? 'The agent stopped'
        : `The agent process exited unexpectedly (code ${code}, signal ${signal})`;
    for (const event of this.normalizer.terminate(reason)) this.emit(event);
    this.emit({ type: 'process_exit', code, signal, stderrTail: this.stderrTail });
    for (const waiter of this.exitWaiters.splice(0)) waiter();
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.exitWaiters = this.exitWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.exitWaiters.push(done);
    });
  }

  private emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A failing listener must not break the protocol loop.
      }
    }
  }
}

function toSessionInfo(state: Record<string, unknown> | undefined): AgentSessionInfo {
  const model = state?.model as { provider?: string; id?: string } | undefined;
  return {
    sessionId: String(state?.sessionId ?? ''),
    sessionFile: typeof state?.sessionFile === 'string' ? state.sessionFile : undefined,
    model: model?.provider && model.id ? { provider: model.provider, id: model.id } : undefined,
    thinkingLevel: typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : undefined,
    isStreaming: state?.isStreaming === true,
    messageCount: typeof state?.messageCount === 'number' ? state.messageCount : 0,
    pendingMessageCount:
      typeof state?.pendingMessageCount === 'number' ? state.pendingMessageCount : 0,
  };
}
