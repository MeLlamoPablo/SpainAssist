import type { BridgeResults, UiEvent, UiNode } from '@sa/shared';
import { BridgeError, type BridgeTransport } from '../bridge/client';
import { hostLog } from '../host/log';
import { createHostOps, type HostOpsDeps, type ImageStore } from './host-ops';
import { type DurableStore, type RunOutcome, WorkflowRun } from './workflow-run';

/**
 * Runs codemode workflows in the agent host: one WorkflowRun per workflow, its durable state in
 * the app (bridge `workflow.*`), the user's events long-polled from the app and dispatched into
 * the run. A run outlives the tool call that started it when it waits for the user (or runs
 * long): the tool returns, and the app hands its outcome to the agent as a message.
 */

export interface StartInput {
  workflowId: string;
  source: string;
  procedures?: string[];
  title?: string;
}

export interface EngineOutcome {
  workflowId: string;
  runId: string;
  resumed: boolean;
  memoReused: number;
  /** `detached`: still running (waiting for the user, or long); its outcome comes as a message. */
  status: RunOutcome['status'] | 'detached';
  outcome?: RunOutcome;
  openUi: string[];
}

export interface EngineDeps
  extends Omit<HostOpsDeps, 'runId' | 'procedures' | 'images' | 'bridge'> {
  bridge: BridgeTransport;
  images: ImageStore;
  /** Return after this long even without an interface (steering stays possible). */
  detachAfterMs: number;
}

interface LiveRun {
  run: WorkflowRun;
  runId: string;
  workflowId: string;
  deliver: boolean;
  /** Dispatches the events that wait for an interface to open (set by `pollEvents`). */
  flushWaiting?: () => void;
}

export class WorkflowEngine {
  private readonly live = new Map<string, LiveRun>();
  private resumer?: ReturnType<typeof setInterval>;
  private resuming = false;

  constructor(private readonly deps: EngineDeps) {}

  /** Workflows running in this process. */
  running(): string[] {
    return [...this.live.keys()];
  }

  /**
   * Starts (or resumes) a workflow. Resolves when it ends, or detaches as `deps` says.
   * `signal` (the tool call aborted) cancels a run that has not detached yet.
   */
  async start(
    input: StartInput,
    signal?: AbortSignal,
    options: { detach?: boolean } = {},
  ): Promise<EngineOutcome> {
    const { bridge } = this.deps;
    const begin = await bridge.call(
      'workflow.begin',
      {
        workflowId: input.workflowId,
        source: input.source,
        ...(input.title ? { title: input.title } : {}),
        ...(input.procedures?.length ? { procedures: input.procedures } : {}),
      },
      { signal },
    );
    const runId = begin.runId;
    const procedures = [...begin.procedures];
    const memoReused = Object.keys(begin.state.memo).length;
    const pendingRender = new Map<string, { tree: UiNode; rev: number }>();
    const pendingDurable = new Map<string, unknown>();
    let uiChain: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = uiChain.then(fn, fn);
      uiChain = next.catch(() => {});
      return next;
    };
    const store: DurableStore = {
      setMemo: (key, value) =>
        bridge.call('workflow.memo', { runId, key, value }).then(() => undefined),
      deleteMemo: (key) =>
        bridge.call('workflow.memo', { runId, key, delete: true }).then(() => undefined),
      openUi: (key, tree, rev) =>
        serial(() => bridge.call('workflow.ui', { runId, action: 'open', key, tree, rev })).then(
          () => undefined,
        ),
      renderUi: (key, tree, rev) => {
        const queued = pendingRender.has(key);
        pendingRender.set(key, { tree, rev });
        if (queued) return;
        void serial(async () => {
          const latest = pendingRender.get(key);
          pendingRender.delete(key);
          if (!latest) return;
          await bridge.call('workflow.ui', {
            runId,
            action: 'render',
            key,
            tree: latest.tree,
            rev: latest.rev,
          });
        }).catch((err) =>
          hostLog('warn', `render of ${input.workflowId}/${key} failed: ${String(err)}`),
        );
      },
      setDurable: (key, name, value) => {
        // Only the latest value of each waits to be sent: a loop of updates keeps one, not all.
        const id = `${key}\u0000${name}`;
        const queued = pendingDurable.has(id);
        pendingDurable.set(id, value);
        if (queued) return;
        void serial(() => {
          const latest = pendingDurable.get(id);
          pendingDurable.delete(id);
          return bridge.call('workflow.ui', { runId, action: 'durable', key, name, value: latest });
        }).catch((err) =>
          hostLog('warn', `durable value of ${input.workflowId}/${key} not saved: ${String(err)}`),
        );
      },
      closeUi: (key, result) =>
        serial(() => bridge.call('workflow.ui', { runId, action: 'close', key, result })).then(
          () => undefined,
        ),
    };

    const baseOps = createHostOps({
      ...this.deps,
      runId: () => runId,
      procedures: () => procedures,
    });
    let uiChanged: () => void = () => {};
    const run = new WorkflowRun({
      workflowId: input.workflowId,
      source: input.source,
      state: begin.state,
      procedures,
      store,
      call: async (op, args, ctx) => {
        const result = await baseOps(op, args, ctx);
        if (op === 'procedures.getOrCreate') {
          const id = (result as { id?: string }).id;
          if (id && !procedures.includes(id)) procedures.push(id);
        }
        return result;
      },
      onUiChange: () => {
        uiChanged();
        // Out of the state operation that opened it: dispatch runs workflow code.
        setTimeout(() => live.flushWaiting?.(), 0);
      },
    });
    const live: LiveRun = { run, runId, workflowId: input.workflowId, deliver: false };
    this.live.set(input.workflowId, live);
    void this.pollEvents(live).catch((err) =>
      hostLog('warn', `events of ${input.workflowId} stopped: ${String(err)}`),
    );
    run.done.then(
      (outcome) => this.finish(live, outcome),
      () => {},
    );
    // start() settles only when main does: the outcome comes through run.done.
    void run.start();

    const detach = options.detach ?? false;
    const base = { workflowId: input.workflowId, runId, resumed: begin.resumed, memoReused };
    if (detach) {
      live.deliver = true;
      return { ...base, status: 'detached', openUi: run.openUis() };
    }
    const onAbort = () => run.cancel('The agent stopped');
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const detached = new Promise<'detached'>((resolve) => {
        const timer = setTimeout(() => resolve('detached'), this.deps.detachAfterMs);
        timer.unref?.();
        const check = () => {
          if (run.openUis().length > 0) resolve('detached');
        };
        uiChanged = check;
        check();
        void run.done.finally(() => clearTimeout(timer));
      });
      const settled = await Promise.race([run.done, detached]);
      if (settled === 'detached') {
        live.deliver = true;
        return { ...base, status: 'detached', openUi: run.openUis() };
      }
      return { ...base, status: settled.status, outcome: settled, openUi: [] };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      uiChanged = () => {};
    }
  }

  private async finish(live: LiveRun, outcome: RunOutcome): Promise<void> {
    if (this.live.get(live.workflowId) === live) this.live.delete(live.workflowId);
    try {
      await this.deps.bridge.call('workflow.end', {
        runId: live.runId,
        outcome: {
          status: outcome.status,
          ...(outcome.status === 'succeeded' && outcome.value !== undefined
            ? { value: outcome.value.slice(0, 100_000) }
            : {}),
          ...(outcome.status === 'failed'
            ? {
                error: outcome.error.slice(0, 10_000),
                // Workflow code chooses it; the bridge takes 40 characters.
                ...(outcome.code ? { code: outcome.code.slice(0, 40) } : {}),
              }
            : {}),
          ...(outcome.status === 'cancelled' ? { error: outcome.reason.slice(0, 10_000) } : {}),
          ...(outcome.logs.length ? { logs: outcome.logs.join('\n').slice(-10_000) } : {}),
        },
        deliver: live.deliver,
      });
    } catch (err) {
      hostLog('warn', `workflow.end of ${live.workflowId} failed: ${String(err)}`);
    }
  }

  /** Long-polls the user's events and dispatches them; events for interfaces not open yet wait. */
  private async pollEvents(live: LiveRun): Promise<void> {
    const { bridge } = this.deps;
    let after = 0;
    const waiting: { key: string; event: UiEvent }[] = [];
    let ended = false;
    void live.run.done.finally(() => {
      ended = true;
    });
    const flushWaiting = () => {
      for (let i = 0; i < waiting.length; ) {
        const item = waiting[i];
        if (item && live.run.openUis().includes(item.key)) {
          live.run.dispatch(item.key, item.event);
          waiting.splice(i, 1);
        } else i++;
      }
    };
    live.flushWaiting = flushWaiting;
    while (!ended) {
      let response: BridgeResults['workflow.events'];
      try {
        response = await bridge.call('workflow.events', { runId: live.runId, after });
      } catch (err) {
        if (ended) return;
        // The app ended the run (it no longer knows it): stop it here too.
        if (err instanceof BridgeError && err.code === 'not_found') {
          live.run.cancel('The app ended this run');
          return;
        }
        hostLog('warn', `workflow.events of ${live.workflowId} failed: ${String(err)}`);
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      if (response.ended) {
        live.run.cancel('Cancelled from the app');
        return;
      }
      for (const item of response.events) {
        after = Math.max(after, item.seq);
        if (live.run.openUis().includes(item.key)) live.run.dispatch(item.key, item.event);
        else waiting.push({ key: item.key, event: item.event });
      }
      // Events for interfaces still opening (a resumed run replays first) go when they open.
      flushWaiting();
    }
  }

  /** Resumes this agent's workflows that wait for the user (after the process started). */
  async resumeAll(): Promise<void> {
    if (this.resuming) return;
    this.resuming = true;
    try {
      await this.resumeOnce();
    } finally {
      this.resuming = false;
    }
  }

  private async resumeOnce(): Promise<void> {
    let list: { workflowId: string; title?: string; source: string; procedures: string[] }[] = [];
    try {
      list = (await this.deps.bridge.call('workflow.resumable', {})).workflows;
    } catch (err) {
      hostLog('warn', `could not list workflows to resume: ${String(err)}`);
      return;
    }
    for (const w of list) {
      if (this.live.has(w.workflowId)) continue;
      await this.start(
        {
          workflowId: w.workflowId,
          source: w.source,
          procedures: w.procedures,
          ...(w.title ? { title: w.title } : {}),
        },
        undefined,
        { detach: true },
      ).catch((err) => hostLog('warn', `could not resume ${w.workflowId}: ${String(err)}`));
    }
  }

  /**
   * Looks for workflows to resume now and then while the process runs, not only at startup:
   * one whose run went stale in main, or that waits while this process stayed up, would
   * otherwise never continue (found by the protocol's model checker, docs/codemode.md).
   */
  startResuming(everyMs = 15_000): void {
    void this.resumeAll();
    this.resumer ??= setInterval(() => void this.resumeAll(), everyMs);
    this.resumer.unref?.();
  }

  /** Cancels every run (process shutdown is not this: runs then simply end with it). */
  cancelAll(reason: string): void {
    for (const live of this.live.values()) live.run.cancel(reason);
  }
}
