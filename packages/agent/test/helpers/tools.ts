import { join } from 'node:path';
import { BridgeClient } from '../../src/bridge/client';
import type { ToolResult } from '../../src/tools/common';
import { type AnyToolDefinition, createTools, type ToolDeps } from '../../src/tools/index';
import type { FakeBridge } from './fake-bridge';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

export interface ToolHarness {
  tools: AnyToolDefinition[];
  run(name: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

export function toolHarness(bridge: FakeBridge, overrides: Partial<ToolDeps> = {}): ToolHarness {
  const tools = createTools({
    bridge: new BridgeClient({ url: bridge.url, token: bridge.token }),
    imagesSupported: true,
    feedback: { submit: true, vote: true },
    ...overrides,
  });
  return {
    tools,
    run(name, params, signal) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`No tool ${name}`);
      return tool.execute('call-1', params, signal, undefined, {} as never) as Promise<ToolResult>;
    },
  };
}

export function textOf(result: ToolResult): string {
  return result.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}
