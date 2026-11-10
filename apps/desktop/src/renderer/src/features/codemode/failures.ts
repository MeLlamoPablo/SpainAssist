import type { UiElement, UiHandler } from '@sa/shared';
import { api } from '../../lib/api';

/**
 * Interfaces the app could not draw (UiRenderer): main takes them off the screen and their
 * workflow hears it at the line that presented them, as if the interface had been refused.
 */

const reported = new Set<string>();

/** Tells main, once per tree, that an interface could not be drawn. */
export function reportUiFailure(workflowId: string, key: string, rev: number, detail: string) {
  const id = `${workflowId}/${key}/${rev}`;
  if (reported.has(id)) return;
  reported.add(id);
  void api.invoke('codemode.uiFailed', workflowId, key, rev, detail.slice(0, 2000)).catch(() => {});
}

/**
 * What the workflow's author needs to find what failed: the component, its label (or its text,
 * for a Button), their own components that rendered it (named in its handlers' ids,
 * "r.0:CitaForm/2#onChange"), and what it threw. "it" when the node is unknown.
 */
export function describeFailure(node: UiElement | undefined, error: unknown): string {
  const thrown = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (!node) return `it (${thrown})`;
  const props: Record<string, unknown> = node.props ?? {};
  const text = (node.children ?? []).filter((c) => typeof c === 'string').join('');
  const label = props.label ?? props.title ?? (text ? text.slice(0, 80) : undefined);
  const handler = Object.values(props).find(
    (v): v is UiHandler => typeof v === 'object' && v !== null && '$handler' in v,
  );
  const authors = [...(handler?.$handler.matchAll(/:([^/.:#]+)/g) ?? [])].map((m) => m[1]);
  return `<${node.type}${typeof label === 'string' ? ` label="${label}"` : ''}>${authors.length ? ` in ${authors.join(' > ')}` : ''} (${thrown})`;
}
