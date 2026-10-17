import { type ActivityItem, type ChatItem, type PromptItem, REPORT_TOOL } from '@sa/shared';

export type ChatRow =
  | { kind: 'item'; key: string; item: Exclude<ChatItem, ActivityItem> }
  | { kind: 'activity'; key: string; item: ActivityItem }
  | { kind: 'activities'; key: string; items: ActivityItem[] }
  /** The assistant started a procedure, or a procedure's agent reported back. */
  | { kind: 'event'; key: string; item: ActivityItem }
  /** A new day starts (conversation only). */
  | { kind: 'day'; key: string; date: string };

/** Activity rows about procedures that read as events in the conversation, never grouped. */
const EVENT_TOOLS: ReadonlySet<string> = new Set([
  REPORT_TOOL,
  'procedure_start',
  'procedure_cancel',
]);

export function isProcedureEvent(item: ActivityItem): boolean {
  return EVENT_TOOLS.has(item.tool);
}

function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Consecutive activities (2+) collapse into one expandable group. With `days`, a separator row
 * starts every new local day; with `skip`, items are left out (pending prompts are docked
 * under the conversation instead).
 */
export function buildRows(
  items: ChatItem[],
  opts: { days?: boolean; skip?: (item: ChatItem) => boolean } = {},
): ChatRow[] {
  const rows: ChatRow[] = [];
  let run: ActivityItem[] = [];
  let day = '';
  const flush = () => {
    if (run.length === 1) rows.push({ kind: 'activity', key: run[0]!.id, item: run[0]! });
    else if (run.length > 1) rows.push({ kind: 'activities', key: `g-${run[0]!.id}`, items: run });
    run = [];
  };
  for (const item of items) {
    if (opts.skip?.(item)) continue;
    if (opts.days) {
      const d = localDay(item.createdAt);
      if (d !== day) {
        flush();
        day = d;
        rows.push({ kind: 'day', key: `d-${item.id}`, date: item.createdAt });
      }
    }
    if (item.type === 'activity') {
      if (isProcedureEvent(item)) {
        flush();
        rows.push({ kind: 'event', key: item.id, item });
        continue;
      }
      run.push(item);
      continue;
    }
    flush();
    rows.push({ kind: 'item', key: item.id, item });
  }
  flush();
  return rows;
}

/** The assistant's own questions waiting for the user (procedures ask on their cards). */
export function pendingPrompts(items: ChatItem[]): PromptItem[] {
  return items.filter(
    (i): i is PromptItem => i.type === 'prompt' && i.status === 'pending' && !i.procedureId,
  );
}
