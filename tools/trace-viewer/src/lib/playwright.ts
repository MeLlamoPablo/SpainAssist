/**
 * A Playwright trace.zip as spans and screenshots. Each `*.trace` file is JSON lines:
 * `context-options` (its `wallTime` and `monotonicTime` turn the other times into epoch ms),
 * `before`/`after` per call (`callId`, monotonic `startTime`/`endTime`), `log` lines of a call,
 * and `screencast-frame` (a JPEG: `file` in format 10, `resources/<sha1>` before).
 */
import type { BrowserTrace, Frame, Span } from './model';
import type { ZipFile } from './zip';

interface Event {
  type: string;
  callId?: string;
  parentId?: string;
  startTime?: number;
  endTime?: number;
  time?: number;
  class?: string;
  method?: string;
  title?: string;
  apiName?: string;
  params?: Record<string, unknown>;
  error?: { message?: string; error?: { message?: string } };
  message?: string;
  wallTime?: number;
  monotonicTime?: number;
  pageId?: string;
  file?: string;
  sha1?: string;
  width?: number;
  height?: number;
  timestamp?: number;
  frameSwapWallTime?: number;
}

export interface PlaywrightTraceMeta {
  id: string;
  path: string;
  title?: string;
  procedureId?: string;
  read(): Promise<Uint8Array>;
}

export function isPlaywrightTrace(zip: ZipFile): boolean {
  return zip.names.some((name) => name.endsWith('.trace'));
}

export async function parsePlaywrightTrace(
  zip: ZipFile,
  meta: PlaywrightTraceMeta,
): Promise<BrowserTrace> {
  const spans = new Map<string, Span>();
  const tops: Span[] = [];
  const frames: Frame[] = [];
  let title = meta.title;
  let pages = 0;
  const pageIds = new Set<string>();

  for (const name of zip.names.filter((n) => n.endsWith('.trace')).sort()) {
    let offset = 0;
    const logs = new Map<string, string[]>();
    for (const line of (await zip.text(name)).split('\n')) {
      if (!line.trim()) continue;
      let e: Event;
      try {
        e = JSON.parse(line) as Event;
      } catch {
        continue;
      }
      if (e.type === 'context-options') {
        if (typeof e.wallTime === 'number' && typeof e.monotonicTime === 'number')
          offset = e.wallTime - e.monotonicTime;
        title ??= e.title;
      } else if (e.type === 'before' && e.callId && typeof e.startTime === 'number') {
        const span: Span = {
          id: `${meta.id}:${e.callId}`,
          name: callName(e),
          kind: 'browser',
          status: 'running',
          start: e.startTime + offset,
          detail: callDetail(e.params),
          input:
            e.params && Object.keys(e.params).length
              ? JSON.stringify(e.params, null, 2)
              : undefined,
          browser: { traceId: meta.id, callId: e.callId },
          children: [],
        };
        spans.set(e.callId, span);
        const parent = e.parentId ? spans.get(e.parentId) : undefined;
        (parent?.children ?? tops).push(span);
      } else if (e.type === 'after' && e.callId) {
        const span = spans.get(e.callId);
        if (!span) continue;
        if (typeof e.endTime === 'number') span.end = e.endTime + offset;
        const error = e.error?.error?.message ?? e.error?.message;
        span.status = error ? 'error' : 'ok';
        if (error) span.error = error;
        const log = logs.get(e.callId);
        if (log?.length) span.output = log.join('\n');
      } else if (e.type === 'log' && e.callId && e.message) {
        const log = logs.get(e.callId) ?? [];
        log.push(e.message);
        logs.set(e.callId, log);
      } else if (e.type === 'screencast-frame') {
        const file = e.file ?? (e.sha1 ? `resources/${e.sha1}` : undefined);
        if (!file || !zip.has(file)) continue;
        const at = e.frameSwapWallTime ?? (e.timestamp ?? 0) + offset;
        const pageId = e.pageId ?? '';
        if (!pageIds.has(pageId)) {
          pageIds.add(pageId);
          pages++;
        }
        frames.push({
          at,
          width: e.width ?? 0,
          height: e.height ?? 0,
          pageId,
          read: () => zip.read(file),
        });
      }
    }
  }
  frames.sort((a, b) => a.at - b.at);
  tops.sort((a, b) => a.start - b.start);
  const starts = [...tops.map((s) => s.start), ...frames.map((f) => f.at)];
  const ends = [...tops.map((s) => s.end ?? s.start), ...frames.map((f) => f.at)];
  const errors = tops.filter((s) => s.status === 'error').length;
  const root: Span = {
    id: meta.id,
    name: title ? `Browser · ${title}` : 'Browser',
    kind: 'page',
    status: errors ? 'error' : 'ok',
    start: starts.length ? Math.min(...starts) : 0,
    end: ends.length ? Math.max(...ends) : 0,
    detail: meta.path,
    browser: { traceId: meta.id },
    attrs: [
      ['Calls', String(spans.size)],
      ['Screenshots', String(frames.length)],
      ['Pages', String(pages)],
      ...(errors ? [['Failed calls', String(errors)] as [string, string]] : []),
    ],
    children: tops,
  };
  return {
    id: meta.id,
    title: title ?? meta.path,
    procedureId: meta.procedureId,
    path: meta.path,
    root,
    frames,
    read: meta.read,
  };
}

function callName(e: Event): string {
  if (e.title) return e.title;
  if (e.apiName) return e.apiName;
  const owner = e.class ? e.class.charAt(0).toLowerCase() + e.class.slice(1) : '';
  // Page calls run on the main frame: "frame.goto" reads as the page's.
  return owner && owner !== 'frame' ? `${owner}.${e.method}` : (e.method ?? 'call');
}

function callDetail(params: Record<string, unknown> | undefined): string | undefined {
  if (!params) return undefined;
  for (const key of ['url', 'selector', 'key', 'text', 'expression', 'name']) {
    const value = params[key];
    if (typeof value === 'string' && value)
      return (key === 'selector' ? readableSelector(value) : value)
        .replace(/\s+/g, ' ')
        .slice(0, 160);
  }
  return undefined;
}

/**
 * Playwright's internal selectors as their locators read: `internal:role=button[name="Entrar"i]`
 * becomes `role=button "Entrar"`, `internal:label="DNI"i` becomes `label "DNI"`.
 */
export function readableSelector(selector: string): string {
  return selector
    .split(' >> ')
    .map((part) =>
      part
        .replace(/^internal:role=([\w-]+)\[name=(".*?")[is]?\](.*)$/, 'role=$1 $2$3')
        .replace(/^internal:(label|text|attr|testid)=(".*?")[is]?$/, '$1 $2')
        .replace(/^internal:has-text=(".*?")[is]?$/, 'has-text $1'),
    )
    .join(' › ');
}
