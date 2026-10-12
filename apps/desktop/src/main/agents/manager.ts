import type { AgentEvent, AgentHostConfig, AgentLaunch, PromptImage } from '@sa/agent';
import type { Language } from '@sa/shared';
import type { TokenRegistry } from '../bridge/tokens';
import { type RunResult, TranscriptMapper } from '../chat/mapper';
import type { PromptManager } from '../chat/prompts';
import type { TranscriptSink } from '../chat/sink';
import { ensurePrivateDir } from '../core/fs';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { type Clock, errorMessage, KeyedQueue, withTimeout } from '../core/util';
import type { AgentClientPort, AgentLib } from '../ports';

export interface AgentManagerDeps {
  lib: AgentLib;
  prompts: PromptManager;
  tokens: TokenRegistry;
  bridgeUrl(): string;
  /** Host config of an agent. Throws NoProviderError when no provider is configured. */
  buildConfig(agentId: string): Promise<AgentHostConfig>;
  /** Where an agent's events go (the conversation or a procedure's activity log). */
  sink(agentId: string): TranscriptSink;
  /** The agent's working directory (empty, app-owned). */
  workDir(agentId: string): string;
  /** A run ended (or the process died during one). Not called for runs of stopped agents. */
  onRunEnd?(agentId: string, result: RunResult): void;
  /** Resolved agent host script (throws if it is not built). */
  hostScript(): string;
  /** process.execPath (Electron) */
  nodeBinary: string;
  electronRunAsNode: boolean;
  logger: Logger;
  clock: Clock;
  lang(): Language;
  mediaExists?(mediaId: string): boolean;
  /** Stop agents idle for this long (default 10 min). Never while a prompt is pending. */
  idleMs?: number;
  stopTimeoutMs?: number;
}

export interface SendOptions {
  /** Abort the old run and its pending prompts before starting with the coordinator's update. */
  restart?: boolean;
  /**
   * While the agent is running, queue the message until it finishes what it is doing instead of
   * steering it right away (reports to the assistant, news for a procedure's agent).
   */
  followUp?: boolean;
}

interface AgentRecord {
  agentId: string;
  client: AgentClientPort;
  mapper: TranscriptMapper;
  sink: TranscriptSink;
  token: string;
  unsubscribe(): void;
  ready: Promise<unknown>;
  /** A run is in progress (prompt accepted, run not ended). */
  busy: boolean;
  stopping?: Promise<void>;
  exited: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * One agent process per active agent: the assistant (orchestrator) and one per procedure being
 * worked on. Starts them on demand (fresh bridge token each time), prompts, steers or queues
 * follow-ups, aborts, stops idle ones, restarts transparently after an exit (the pi session file
 * keeps the context), maps their events into transcripts and reports finished runs.
 */
export class AgentManager {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly queue = new KeyedQueue();

  constructor(private readonly deps: AgentManagerDeps) {}

  isActive(agentId: string): boolean {
    const r = this.agents.get(agentId);
    return !!r && !r.exited && !r.stopping;
  }

  /** The agent is in the middle of a run. */
  isRunning(agentId: string): boolean {
    const r = this.agents.get(agentId);
    return !!r && !r.exited && !r.stopping && (r.busy || r.client.running);
  }

  activeCount(): number {
    return [...this.agents.values()].filter((r) => !r.exited && !r.stopping).length;
  }

  /**
   * Delivers a message: `prompt` when idle; while a run is in progress, `steer` (or `followUp`
   * with `opts.followUp`). The client's own state decides (pi answers "already processing" if a
   * run started meanwhile: then steer / follow up). Resolves with what happened.
   */
  send(
    agentId: string,
    text: string,
    images?: PromptImage[],
    opts: SendOptions = {},
  ): Promise<'started' | 'queued'> {
    return this.queue.run(agentId, async () => {
      if (opts.restart) await this.abort(agentId);
      const agent = await this.ensure(agentId);
      this.clearIdle(agent);
      const queue = () => (opts.followUp ? agent.client.followUp(text) : agent.client.steer(text));
      if (agent.client.running) {
        return (await queue()) === 'queued' ? 'queued' : 'started';
      }
      agent.busy = true;
      agent.sink.setRunning(true);
      try {
        return (await agent.client.prompt(text, images)) === 'queued' ? 'queued' : 'started';
      } catch (err) {
        if (/already processing|streamingBehavior/i.test(errorMessage(err))) {
          return (await queue()) === 'queued' ? 'queued' : 'started';
        }
        agent.busy = false;
        agent.sink.setRunning(false);
        this.scheduleIdle(agent);
        throw err;
      }
    });
  }

  private async ensure(agentId: string): Promise<AgentRecord> {
    const existing = this.agents.get(agentId);
    if (existing?.stopping) await existing.stopping.catch(() => {});
    else if (existing && !existing.exited) {
      await existing.ready;
      return existing;
    }

    const { deps } = this;
    const config = await deps.buildConfig(agentId);
    const sink = deps.sink(agentId);
    const workDir = deps.workDir(agentId);
    await ensurePrivateDir(workDir);
    // Fails early with a clear message when @sa/agent's dist/host.js is not built.
    const hostScript = deps.hostScript();

    const token = deps.tokens.issue(agentId);
    deps.logger.addSecret(token);
    let launch: AgentLaunch;
    try {
      launch = deps.lib.buildAgentLaunch({
        nodeBinary: deps.nodeBinary,
        electronRunAsNode: deps.electronRunAsNode,
        cwd: workDir,
        config,
        bridge: { url: deps.bridgeUrl(), token },
        hostPath: hostScript,
      });
    } catch (err) {
      deps.tokens.revokeToken(agentId, token);
      throw err;
    }

    const client = deps.lib.createClient(launch);
    const record: AgentRecord = {
      agentId,
      client,
      token,
      sink,
      mapper: new TranscriptMapper(agentId, {
        sink,
        clock: deps.clock,
        lang: deps.lang,
        logger: deps.logger,
        ...(deps.mediaExists ? { mediaExists: deps.mediaExists } : {}),
      }),
      unsubscribe: () => {},
      ready: Promise.resolve(),
      busy: false,
      exited: false,
    };
    record.unsubscribe = client.on((event) => this.onEvent(record, event));
    this.agents.set(agentId, record);
    record.ready = client.start();
    try {
      await record.ready;
    } catch (err) {
      record.exited = true;
      record.unsubscribe();
      if (this.agents.get(agentId) === record) this.agents.delete(agentId);
      deps.tokens.revokeToken(agentId, token);
      client.stop().catch(() => {});
      throw err;
    }
    deps.logger.info('agent started', { agentId, role: config.role, model: config.model.provider });
    this.scheduleIdle(record);
    return record;
  }

  private onEvent(record: AgentRecord, event: AgentEvent): void {
    if (this.agents.get(record.agentId) !== record) return;
    try {
      record.mapper.handle(event);
    } catch (err) {
      this.deps.logger.error('failed to map agent event', {
        type: event.type,
        error: errorMessage(err),
      });
    }
    switch (event.type) {
      case 'run_start':
        record.busy = true;
        this.clearIdle(record);
        break;
      case 'run_end':
        record.busy = false;
        this.scheduleIdle(record);
        if (record.mapper.lastRun && !record.stopping) this.runEnded(record, record.mapper.lastRun);
        break;
      case 'process_exit':
        this.onExit(record, event);
        break;
    }
  }

  private runEnded(record: AgentRecord, result: RunResult): void {
    try {
      this.deps.onRunEnd?.(record.agentId, result);
    } catch (err) {
      this.deps.logger.error('run end handler failed', { error: errorMessage(err) });
    }
  }

  private onExit(record: AgentRecord, event: Extract<AgentEvent, { type: 'process_exit' }>): void {
    const { deps } = this;
    const id = record.agentId;
    const wasBusy = record.busy;
    record.exited = true;
    record.busy = false;
    this.clearIdle(record);
    record.unsubscribe();
    deps.tokens.revokeToken(id, record.token);
    if (this.agents.get(id) === record) this.agents.delete(id);
    deps.prompts.cancelAll(id);
    record.mapper.finalize('aborted');
    if (record.stopping) return;
    deps.logger.warn('agent exited', {
      agentId: id,
      code: event.code,
      signal: event.signal,
      stderr: event.stderrTail.slice(-300),
    });
    if (event.code !== 0 || wasBusy) {
      const message = t(deps.lang(), 'agentCrashed');
      if (record.sink.exists()) {
        record.sink.addNotice('error', message);
        record.sink.setError(message);
        record.sink.setUnread();
      }
      if (wasBusy) this.runEnded(record, { aborted: false, error: message, text: '' });
    }
  }

  /** Stops the current run and cancels its prompts without approving or completing them. */
  async abort(agentId: string): Promise<void> {
    const record = this.agents.get(agentId);
    if (!record || record.exited || record.stopping) {
      this.deps.prompts.cancelAll(agentId);
      return;
    }
    // Send the abort before releasing a blocked tool, so it cannot continue the old plan.
    const abort = record.client.abort();
    this.deps.prompts.cancelAll(agentId);
    try {
      await withTimeout(abort, 5_000, 'abort timed out');
    } catch (err) {
      this.deps.logger.warn('abort failed', { agentId, error: errorMessage(err) });
      // A new instruction must never run alongside a run that failed to abort.
      await this.stop(agentId);
    }
  }

  stop(agentId: string): Promise<void> {
    const record = this.agents.get(agentId);
    if (!record) return Promise.resolve();
    if (record.stopping) return record.stopping;
    this.clearIdle(record);
    this.deps.prompts.cancelAll(agentId);
    record.stopping = (async () => {
      try {
        await withTimeout(record.client.stop(), this.deps.stopTimeoutMs ?? 5_000, 'stop timed out');
      } catch (err) {
        this.deps.logger.warn('agent stop failed', { agentId, error: errorMessage(err) });
      }
      record.exited = true;
      record.busy = false;
      record.unsubscribe();
      this.deps.tokens.revokeToken(agentId, record.token);
      if (this.agents.get(agentId) === record) this.agents.delete(agentId);
      if (record.sink.exists()) record.mapper.finalize('aborted');
      this.deps.logger.info('agent stopped', { agentId });
    })();
    return record.stopping;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.agents.keys()].map((id) => this.stop(id)));
  }

  private clearIdle(record: AgentRecord): void {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
  }

  private scheduleIdle(record: AgentRecord): void {
    this.clearIdle(record);
    record.idleTimer = setTimeout(() => this.onIdle(record), this.deps.idleMs ?? 10 * 60_000);
    record.idleTimer.unref?.();
  }

  private onIdle(record: AgentRecord): void {
    const id = record.agentId;
    if (this.agents.get(id) !== record || record.exited || record.stopping) return;
    if (record.busy || record.client.running || this.deps.prompts.pendingCount(id) > 0) {
      this.scheduleIdle(record);
      return;
    }
    this.deps.logger.info('stopping idle agent', { agentId: id });
    void this.stop(id);
  }
}
