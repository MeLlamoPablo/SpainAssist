import {
  AppWindow,
  Bot,
  Braces,
  ClipboardList,
  FileText,
  Globe,
  Hourglass,
  KeyRound,
  Link,
  type LucideIcon,
  MessageSquare,
  MousePointerClick,
  Search,
  Sparkles,
  UserRound,
  Users,
  Wrench,
  Zap,
} from 'lucide-react';
import type { Span, SpanKind } from '../lib/model';

/**
 * Three hues, validated together for color vision deficiency in both themes (the dataviz
 * check): model calls violet, tool work aqua, the browser orange. Structure (agent, turn,
 * trace) is neutral, and waiting for the user is hatched neutral: it is not work.
 */
export type Tone = 'llm' | 'tool' | 'browser' | 'neutral' | 'wait';

export const KIND: Record<SpanKind, { label: string; tone: Tone; icon: LucideIcon }> = {
  agent: { label: 'Agent', tone: 'neutral', icon: Bot },
  turn: { label: 'Turn', tone: 'neutral', icon: MessageSquare },
  llm: { label: 'Model call', tone: 'llm', icon: Sparkles },
  tool: { label: 'Tool call', tone: 'tool', icon: Wrench },
  run: { label: 'Codemode run', tone: 'tool', icon: Braces },
  op: { label: 'API call', tone: 'tool', icon: Zap },
  wait: { label: 'Waiting for the user', tone: 'wait', icon: Hourglass },
  browser: { label: 'Browser call', tone: 'browser', icon: MousePointerClick },
  page: { label: 'Playwright trace', tone: 'neutral', icon: AppWindow },
};

/** An `api.*` call's icon by its namespace. */
const OP_ICONS: [RegExp, LucideIcon][] = [
  [/^browser\./, Globe],
  [/^user\./, UserRound],
  [/^vault\.|^credentials\./, KeyRound],
  [/^procedures\./, ClipboardList],
  [/^documents\./, FileText],
  [/^search|^boe/, Search],
  [/^fetch/, Link],
  [/^agents\./, Users],
];

export function iconOf(span: Span): LucideIcon {
  if (span.kind === 'op') return OP_ICONS.find(([re]) => re.test(span.name))?.[1] ?? Zap;
  return KIND[span.kind].icon;
}

export const LEGEND: { tone: Tone; label: string }[] = [
  { tone: 'llm', label: 'Model' },
  { tone: 'tool', label: 'Tools & runs' },
  { tone: 'browser', label: 'Browser' },
  { tone: 'wait', label: 'Waiting for user' },
];

/** Kinds drawn as a thin structural bar rather than a filled one. */
export function isGroup(span: Span): boolean {
  return span.kind === 'agent' || span.kind === 'turn' || span.kind === 'page';
}
