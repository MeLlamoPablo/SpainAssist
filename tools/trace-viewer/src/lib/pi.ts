/**
 * An agent's pi session file (`session.jsonl`, docs/research/pi.md "Session format") as spans:
 *
 *   agent
 *   └─ turn        a user message (or a run's report), until the next one
 *      ├─ llm      an assistant message: from its `message.timestamp` (the request) to its entry
 *      └─ tool     a tool call: from the assistant entry to its toolResult entry
 *         └─ run   a codemode run (`spainassist.run_trace`), with its `api.*` calls
 *
 * Only the active branch counts (from the last entry back to the root), as pi reads it.
 */
import type { Span } from './model';

/** Custom entry of a codemode run's timeline (`packages/agent/src/host/session.ts`). */
export const RUN_TRACE = 'spainassist.run_trace';

interface Entry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: Message;
  customType?: string;
  data?: unknown;
  summary?: string;
}

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface Message {
  role: string;
  content?: string | Block[];
  timestamp?: number;
  model?: string;
  provider?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: { runId?: string; status?: string };
}

interface RunTraceData {
  runId: string;
  title?: string;
  startedAt: number;
  endedAt: number;
  status: 'succeeded' | 'failed' | 'cancelled';
  calls: {
    op: string;
    label?: string;
    start: number;
    ms: number;
    error?: string;
    result?: string;
  }[];
  droppedCalls?: number;
}

export interface SessionMeta {
  /** Span id prefix, unique among the loaded traces. */
  id: string;
  title: string;
  detail?: string;
}

const TEXT_PREVIEW = 20_000;

export function parseSession(text: string, meta: SessionMeta): Span {
  const entries = activeBranch(parseLines(text));
  const time = (e: Entry) => (e.timestamp ? Date.parse(e.timestamp) : Number.NaN);
  const first = entries.find((e) => !Number.isNaN(time(e)));
  const root: Span = {
    id: meta.id,
    name: meta.title,
    kind: 'agent',
    status: 'ok',
    start: first ? time(first) : 0,
    detail: meta.detail,
    children: [],
  };
  const tools = new Map<string, Span>();
  const runsByTool = new Map<string, Span>();
  const runs: { span: Span; runId: string }[] = [];
  let turn: Span | undefined;
  let previous = root.start;
  let last = root.start;
  let n = 0;
  const id = () => `${meta.id}:${++n}`;

  for (const entry of entries) {
    const at = time(entry);
    if (Number.isNaN(at)) continue;
    last = Math.max(last, at);
    const message = entry.message;
    if (entry.type === 'message' && message) {
      if (message.role === 'user') {
        if (turn) turn.end = Math.max(turn.end ?? turn.start, previous);
        const said = textOf(message.content);
        turn = {
          id: id(),
          name: oneLine(said) || 'Turn',
          kind: 'turn',
          status: 'ok',
          start: at,
          end: at,
          input: said.slice(0, TEXT_PREVIEW),
          children: [],
        };
        root.children.push(turn);
      } else if (message.role === 'assistant') {
        const parent = turn ?? root;
        const start = Math.min(message.timestamp ?? previous, at);
        const calls = blocks(message.content).filter((b) => b.type === 'toolCall');
        const said = textOf(message.content);
        const usage = message.usage;
        const failed = message.stopReason === 'error' || message.stopReason === 'aborted';
        parent.children.push({
          id: id(),
          name: message.model ?? 'Model',
          kind: 'llm',
          status: failed ? 'error' : 'ok',
          start,
          end: at,
          detail: calls.length
            ? `→ ${calls.map((c) => toolLabel(c)).join(', ')}`
            : oneLine(said) || undefined,
          model: message.model,
          tokensIn: (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
          tokensOut: usage?.output ?? 0,
          cacheRead: usage?.cacheRead,
          cost: usage?.cost?.total,
          output: said.slice(0, TEXT_PREVIEW) || undefined,
          error: message.errorMessage ?? (failed ? `Stopped: ${message.stopReason}` : undefined),
          attrs: [
            ...(message.provider ? [['Provider', message.provider] as [string, string]] : []),
            ...(message.stopReason
              ? [['Stop reason', message.stopReason] as [string, string]]
              : []),
            ...thinking(message.content),
          ],
          children: [],
        });
        for (const call of calls) {
          const span: Span = {
            id: id(),
            name: call.name ?? 'tool',
            kind: 'tool',
            status: 'running',
            start: at,
            detail: toolDetail(call),
            input: toolInput(call),
            children: [],
          };
          parent.children.push(span);
          if (call.id) tools.set(call.id, span);
        }
        if (turn) turn.end = at;
      } else if (message.role === 'toolResult') {
        const span = message.toolCallId ? tools.get(message.toolCallId) : undefined;
        if (span) {
          span.end = at;
          span.status = message.isError ? 'error' : 'ok';
          const result = textOf(message.content);
          if (message.isError) span.error = result.slice(0, TEXT_PREVIEW);
          else span.output = result.slice(0, TEXT_PREVIEW);
          const runId = message.details?.runId;
          if (runId) {
            runsByTool.set(runId, span);
            span.attrs = [
              ['Run', runId],
              ...(message.details?.status
                ? [['Status', message.details.status] as [string, string]]
                : []),
            ];
          }
        }
        if (turn) turn.end = at;
      }
    } else if (entry.type === 'custom' && entry.customType === RUN_TRACE) {
      const data = entry.data as RunTraceData | undefined;
      if (data && typeof data.startedAt === 'number')
        runs.push({ span: runSpan(data, id), runId: data.runId });
    } else if (entry.type === 'compaction') {
      (turn ?? root).children.push({
        id: id(),
        name: 'Compaction',
        kind: 'llm',
        status: 'ok',
        start: previous,
        end: at,
        output: entry.summary?.slice(0, TEXT_PREVIEW),
        children: [],
      });
    }
    previous = at;
  }
  if (turn) turn.end = Math.max(turn.end ?? turn.start, previous);

  // A run goes under the codemode call that started it; a resumed run (its call was in an
  // earlier process) under the turn it ran in.
  for (const { span, runId } of runs) {
    const tool = runsByTool.get(runId);
    const caller = tool && span.start >= tool.start - 1_000 ? tool : undefined;
    const parent = caller ?? turnAt(root, span.start) ?? root;
    parent.children.push(span);
    parent.children.sort((a, b) => a.start - b.start);
  }
  // A tool call without a result: it was still running when the session was read, or its
  // process ended. Turns stretch to cover runs that outlived their call.
  for (const t of root.children) {
    for (const s of t.children) if (s.kind === 'run' && s.end) t.end = Math.max(t.end ?? 0, s.end);
    last = Math.max(last, t.end ?? 0);
  }
  root.end = last;
  return root;
}

function runSpan(data: RunTraceData, id: () => string): Span {
  const children: Span[] = data.calls.map((call) => {
    if (call.op === 'ui')
      return {
        id: id(),
        name: 'Waiting for the user',
        kind: 'wait',
        status: 'ok',
        start: call.start,
        end: call.start + call.ms,
        detail: call.label,
        children: [],
      };
    return {
      id: id(),
      name: call.op,
      kind: 'op',
      status: call.error ? 'error' : 'ok',
      start: call.start,
      end: call.start + call.ms,
      detail: call.label,
      error: call.error,
      output: call.result,
      children: [],
    };
  });
  return {
    id: id(),
    name: data.title ?? 'Run',
    kind: 'run',
    status: data.status === 'failed' ? 'error' : 'ok',
    start: data.startedAt,
    end: data.endedAt,
    detail: data.runId,
    attrs: [
      ['Run', data.runId],
      ['Outcome', data.status],
      ['Calls', String(data.calls.length + (data.droppedCalls ?? 0))],
      ...(data.droppedCalls
        ? [['Calls not kept', String(data.droppedCalls)] as [string, string]]
        : []),
    ],
    children,
  };
}

function turnAt(root: Span, at: number): Span | undefined {
  let found: Span | undefined;
  for (const turn of root.children) if (turn.kind === 'turn' && turn.start <= at) found = turn;
  return found;
}

function parseLines(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Entry;
      if (entry && typeof entry.type === 'string') out.push(entry);
    } catch {
      // A line cut by a crash: skip it.
    }
  }
  return out;
}

/** The entries from the last one back to the root, in order (the header and id-less ones too). */
function activeBranch(entries: Entry[]): Entry[] {
  const byId = new Map<string, Entry>();
  for (const e of entries) if (e.id) byId.set(e.id, e);
  const leaf = entries.findLast((e) => e.id);
  if (!leaf) return entries;
  const keep = new Set<Entry>();
  for (
    let e: Entry | undefined = leaf;
    e && !keep.has(e);
    e = e.parentId ? byId.get(e.parentId) : undefined
  )
    keep.add(e);
  return entries.filter((e) => !e.id || keep.has(e));
}

function blocks(content: Message['content']): Block[] {
  return Array.isArray(content) ? content : [];
}

function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return blocks(content)
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n');
}

function thinking(content: Message['content']): [string, string][] {
  const text = blocks(content)
    .filter((b) => b.type === 'thinking' && b.thinking)
    .map((b) => b.thinking)
    .join('\n');
  return text ? [['Thinking', text.slice(0, TEXT_PREVIEW)]] : [];
}

function oneLine(text: string, max = 120): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toolLabel(call: Block): string {
  const title = call.arguments?.title;
  return typeof title === 'string' ? `${call.name} “${oneLine(title, 40)}”` : (call.name ?? 'tool');
}

function toolDetail(call: Block): string | undefined {
  const a = call.arguments ?? {};
  for (const key of ['title', 'brief', 'message', 'procedureId', 'agentId']) {
    if (typeof a[key] === 'string') return oneLine(a[key] as string, 80);
  }
  return undefined;
}

function toolInput(call: Block): string | undefined {
  const a = call.arguments;
  if (!a) return undefined;
  // A codemode call's module reads best as code.
  if (typeof a.source === 'string') return a.source.slice(0, TEXT_PREVIEW);
  return JSON.stringify(a, null, 2).slice(0, TEXT_PREVIEW);
}
