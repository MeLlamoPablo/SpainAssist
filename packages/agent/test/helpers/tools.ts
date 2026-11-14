import type { ToolResult } from '../../src/tools/common';

export function textOf(result: ToolResult): string {
  return result.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}
