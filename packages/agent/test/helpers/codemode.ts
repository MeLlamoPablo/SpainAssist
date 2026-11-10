import type { UiNode } from '@sa/shared';
import {
  type DurableStore,
  type HostOp,
  type RunOutcome,
  WorkflowRun,
  type WorkflowState,
} from '../../src/codemode/workflow-run';

/** An in-memory DurableStore that records what a run stored, like main's workflow records. */
export class MemoryStore implements DurableStore {
  state: WorkflowState = { memo: {}, ui: {} };
  trees = new Map<string, { tree: UiNode; rev: number }>();
  log: string[] = [];

  async setMemo(key: string, value: unknown): Promise<void> {
    this.log.push(`memo ${key}`);
    this.state.memo[key] = { value: structuredClone(value) };
  }
  async deleteMemo(key: string): Promise<void> {
    this.log.push(`delete ${key}`);
    delete this.state.memo[key];
  }
  async openUi(key: string, tree: UiNode, rev: number): Promise<void> {
    this.log.push(`open ${key}`);
    const prev = this.state.ui[key];
    this.state.ui[key] = { status: 'open', durable: prev?.durable ?? {}, rev };
    this.trees.set(key, { tree, rev });
  }
  renderUi(key: string, tree: UiNode, rev: number): void {
    const ui = this.state.ui[key];
    if (ui) ui.rev = rev;
    this.trees.set(key, { tree, rev });
  }
  setDurable(key: string, name: string, value: unknown): void {
    const ui = this.state.ui[key];
    if (ui) ui.durable = { ...ui.durable, [name]: value };
  }
  async closeUi(key: string, result: unknown): Promise<void> {
    this.log.push(`close ${key}`);
    this.state.ui[key] = { status: 'closed', result };
    this.trees.delete(key);
  }

  /** A copy of the stored state, as a restarted app would load it. */
  snapshot(): WorkflowState {
    return structuredClone(this.state);
  }
}

export interface StartedRun {
  run: WorkflowRun;
  store: MemoryStore;
  calls: { op: string; args: unknown }[];
  done: Promise<RunOutcome>;
}

export function startRun(
  source: string,
  options: {
    store?: MemoryStore;
    call?: HostOp;
    procedures?: string[];
    limits?: ConstructorParameters<typeof WorkflowRun>[0]['limits'];
  } = {},
): StartedRun {
  const store = options.store ?? new MemoryStore();
  const calls: { op: string; args: unknown }[] = [];
  const run = new WorkflowRun({
    workflowId: 'test',
    source,
    state: store.snapshot(),
    procedures: options.procedures ?? [],
    store,
    call: async (op, args, ctx) => {
      calls.push({ op, args });
      if (options.call) return options.call(op, args, ctx);
      return { echo: op, args };
    },
    ...(options.limits ? { limits: options.limits } : {}),
  });
  void run.start();
  return { run, store, calls, done: run.done };
}

/** Waits until `check` passes (interfaces render asynchronously). */
export async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('Timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Finds the first node of a tree with that type (and, optionally, that text child). */
export function findNode(
  tree: UiNode | undefined,
  type: string,
  text?: string,
): Exclude<UiNode, string> | undefined {
  if (!tree || typeof tree === 'string') return undefined;
  if (tree.type === type && (text === undefined || tree.children.includes(text))) return tree;
  for (const child of tree.children) {
    const found = findNode(child, type, text);
    if (found) return found;
  }
  return undefined;
}

/** The handler id of a node's prop. */
export function handlerOf(node: Exclude<UiNode, string> | undefined, prop: string): string {
  const value = node?.props[prop] as { $handler?: string } | undefined;
  if (!value?.$handler) throw new Error(`No handler ${prop}`);
  return value.$handler;
}
