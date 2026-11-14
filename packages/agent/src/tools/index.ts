import type { BridgeTransport } from '../bridge/client';
import type { AnyToolDefinition } from './common';
import { coordinatorTools } from './coordinator';
import { COORDINATOR_TOOL_NAMES } from './names';

export type { AnyToolDefinition } from './common';

/** The tools of the coordinator. */
export function createCoordinatorTools(deps: { bridge: BridgeTransport }): AnyToolDefinition[] {
  return finish(COORDINATOR_TOOL_NAMES, coordinatorTools(deps.bridge));
}

/** Checks the list against `names`, marks stateful tools sequential and sorts it like `names`. */
function finish(names: readonly string[], tools: AnyToolDefinition[]): AnyToolDefinition[] {
  const order = new Map<string, number>(names.map((name, i) => [name, i]));
  const missing = names.filter((name) => !tools.some((t) => t.name === name));
  const extra = tools.filter((t) => !order.has(t.name)).map((t) => t.name);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Tool list mismatch. Missing: ${missing.join(', ')}; extra: ${extra.join(', ')}`,
    );
  }
  for (const tool of tools) {
    // Tools that change state never run concurrently with other calls (pi runs a whole batch
    // sequentially when one of its calls is sequential).
    if (SEQUENTIAL_TOOLS.has(tool.name)) tool.executionMode = 'sequential';
  }
  return tools.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
}

const SEQUENTIAL_TOOLS: ReadonlySet<string> = new Set([
  'agent_start',
  'agent_message',
  'agent_stop',
]);
