/**
 * Turns a set of files into traces. The layout is the app's userData folder, which the transcripts
 * export zip keeps (`apps/desktop/src/main/export/transcripts.ts`):
 *
 *   assistant/session-v2.jsonl                  the coordinator (session.jsonl: the classic v1)
 *   agents/<id>/session.jsonl, agent.json       background agents
 *   procedures/<id>/session.jsonl               agents of older versions, one per procedure
 *   procedures/<id>/capture/<run>/trace.zip     browser captures (SA_BROWSER_CAPTURE=1)
 *
 * An eval run's folder (`tools/eval`) has that layout under `profile/`, and its captures in
 * `browser/<procedure id>/<run>/trace.zip`. The server adds its checks (`eval.json`), which go on
 * the spans that made them pass or fail (`placeChecks`).
 *
 * Any other `*.jsonl` is read as a pi session and any other `*.zip` as a Playwright trace, so a
 * single file opens too. Browser calls are also placed under the `browser.*` call of the run
 * that made them, by time, among the agents that served the capture's procedure.
 */
import { consequence, EVAL_FILE, type EvalRun, placeChecks } from './checks';
import { type BrowserTrace, type Span, type Trace, walk } from './model';
import { parseSession } from './pi';
import { isPlaywrightTrace, parsePlaywrightTrace } from './playwright';
import { isZip, readZip } from './zip';

export interface Source {
  /** What was opened (a path or a file name), for the title. */
  name: string;
  /** Relative paths, `/`-separated. */
  files: string[];
  read(path: string): Promise<Uint8Array>;
  /** A URL the Playwright trace viewer can fetch the file from, when the server has one. */
  url?(path: string): string;
}

export interface Loaded {
  traces: Trace[];
  /** Files that could not be read, and why. */
  problems: string[];
  /** An eval run's checks, placed on the spans that made them pass or fail. */
  eval?: EvalRun;
}

/** A source of one opened or dropped file: an export zip, a trace.zip or a session. */
export function sourceFromBytes(name: string, bytes: Uint8Array): Source {
  if (isZip(bytes)) {
    const zip = readZip(bytes);
    if (isPlaywrightTrace(zip)) return { name, files: [baseName(name)], read: async () => bytes };
    return { name, files: zip.names, read: (path) => zip.read(path) };
  }
  return { name, files: [baseName(name)], read: async () => bytes };
}

const SESSION = /(?:^|\/)[^/]+\.jsonl$/;
/** A browser capture: the app's (`procedures/<id>/capture/<run>/`), or an eval run's (`browser/<id>/<run>/`). */
const CAPTURE = /(?:^|\/)(?:procedures\/([^/]+)\/capture|browser\/([^/]+))\/([^/]+)\//;

export async function loadSource(source: Source): Promise<Loaded> {
  const problems: string[] = [];
  const has = new Set(source.files);
  const text = async (path: string) => new TextDecoder().decode(await source.read(path));
  const json = async (path: string): Promise<Record<string, unknown> | undefined> => {
    if (!has.has(path)) return undefined;
    try {
      return JSON.parse(await text(path)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };

  const traces: Trace[] = [];
  for (const path of source.files.filter((p) => SESSION.test(p)).sort()) {
    // Captures' actions.jsonl and other logs are not sessions.
    if (/(?:^|\/)(?:actions|capture)\b[^/]*\.jsonl$/.test(path) || path.includes('/capture/'))
      continue;
    try {
      const meta = await describeSession(path, json);
      const root = parseSession(await text(path), {
        id: path,
        title: meta.title,
        detail: meta.subtitle,
      });
      if (!root.children.length) continue;
      traces.push({ ...meta, id: path, path, root, browser: [] });
    } catch (err) {
      problems.push(`${path}: ${errorMessage(err)}`);
    }
  }

  const browser: BrowserTrace[] = [];
  for (const path of source.files.filter((p) => p.endsWith('.zip')).sort()) {
    try {
      const zip = readZip(await source.read(path));
      if (!isPlaywrightTrace(zip)) continue;
      const capture = CAPTURE.exec(path);
      const procedureId = capture?.[1] ?? capture?.[2];
      const procedureJson = `procedures/${procedureId}/procedure.json`;
      const procedure = procedureId
        ? await json(
            source.files.find((f) => f === procedureJson || f.endsWith(`/${procedureJson}`)) ??
              procedureJson,
          )
        : undefined;
      const run = capture?.[3];
      const title = [str(procedure?.title), run ? runTime(run) : undefined]
        .filter(Boolean)
        .join(' · ');
      browser.push(
        await parsePlaywrightTrace(zip, {
          id: path,
          path,
          title: title || undefined,
          procedureId,
          read: () => source.read(path),
        }),
      );
    } catch (err) {
      problems.push(`${path}: ${errorMessage(err)}`);
    }
  }

  for (const b of browser) placeBrowserCalls(b, traces);
  traces.sort((a, b) => order(a) - order(b) || a.root.start - b.root.start);
  for (const b of browser)
    traces.push({
      id: b.id,
      group: 'browser',
      title: b.title,
      subtitle: b.path,
      path: b.path,
      root: b.root,
      procedures: b.procedureId ? [b.procedureId] : [],
      browser: [b],
    });
  const evalRun = (await json(EVAL_FILE)) as EvalRun | undefined;
  if (evalRun) {
    placeChecks(evalRun, traces);
    for (const check of evalRun.checks) check.consequence = consequence(check, evalRun);
  }
  return { traces, problems, ...(evalRun ? { eval: evalRun } : {}) };
}

function order(t: Trace): number {
  return t.group === 'coordinator' ? 0 : t.group === 'agent' ? 1 : 2;
}

async function describeSession(
  path: string,
  json: (path: string) => Promise<Record<string, unknown> | undefined>,
): Promise<Pick<Trace, 'group' | 'title' | 'subtitle' | 'procedures'>> {
  if (/^(?:.*\/)?assistant\/session-v\d+\.jsonl$/.test(path))
    return { group: 'coordinator', title: 'Coordinator', subtitle: path, procedures: [] };
  if (/^(?:.*\/)?assistant\/session\.jsonl$/.test(path))
    return { group: 'coordinator', title: 'Assistant (v1)', subtitle: path, procedures: [] };
  const agent = /^(.*\/)?agents\/([^/]+)\/session\.jsonl$/.exec(path);
  if (agent) {
    const record = await json(`${agent[1] ?? ''}agents/${agent[2]}/agent.json`);
    const status = str(record?.status);
    const brief = str(record?.brief);
    return {
      group: 'agent',
      title: status || brief || agent[2]!,
      subtitle: [agent[2], str(record?.kind)].filter(Boolean).join(' · '),
      procedures: Array.isArray(record?.procedures) ? (record.procedures as string[]) : [],
    };
  }
  const procedure = /^(.*\/)?procedures\/([^/]+)\/session\.jsonl$/.exec(path);
  if (procedure) {
    const record = await json(`${procedure[1] ?? ''}procedures/${procedure[2]}/procedure.json`);
    return {
      group: 'agent',
      title: str(record?.title) || procedure[2]!,
      subtitle: `${procedure[2]} · procedure agent`,
      procedures: [procedure[2]!],
    };
  }
  if (path.startsWith('scanner/'))
    return { group: 'agent', title: 'Document scan', subtitle: path, procedures: [] };
  return { group: 'agent', title: baseName(path), subtitle: path, procedures: [] };
}

/** Slack around a run's call: its clock and Playwright's are read at different points. */
const SLACK_MS = 5;

/**
 * Copies each top-level call of a Playwright trace under the innermost `browser.*` call (else
 * the run) that was in flight when it started, in an agent that served its procedure.
 */
function placeBrowserCalls(browser: BrowserTrace, traces: Trace[]): void {
  const candidates = traces.filter(
    (t) => !browser.procedureId || t.procedures.includes(browser.procedureId),
  );
  const pool = candidates.length ? candidates : traces;
  const hosts: { span: Span; trace: Trace }[] = [];
  for (const trace of pool)
    for (const span of walk(trace.root))
      if ((span.kind === 'op' && span.name.startsWith('browser.')) || span.kind === 'run')
        hosts.push({ span, trace });

  const placed = new Set<Trace>();
  for (const call of browser.root.children) {
    let best: { host: (typeof hosts)[number]; rank: number[] } | undefined;
    for (const host of hosts) {
      const { span } = host;
      const end = span.end ?? Number.POSITIVE_INFINITY;
      const outside = Math.max(0, span.start - call.start, call.start - end);
      if (outside > SLACK_MS) continue;
      // Inside before nearby; an op before its run; then the shortest.
      const rank = [outside, span.kind === 'op' ? 0 : 1, duration(span)];
      if (!best || compare(rank, best.rank) < 0) best = { host, rank };
    }
    if (!best) continue;
    const { span, trace } = best.host;
    span.children.push(copy(call, `${trace.id}>`));
    span.children.sort((a, b) => a.start - b.start);
    placed.add(trace);
  }
  for (const trace of placed) trace.browser.push(browser);
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

function duration(span: Span): number {
  return (span.end ?? Number.POSITIVE_INFINITY) - span.start;
}

function copy(span: Span, prefix: string): Span {
  return { ...span, id: prefix + span.id, children: span.children.map((c) => copy(c, prefix)) };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** A capture run's folder name (`2026-11-22T10-11-58-123Z`) as a readable time. */
function runTime(run: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(run);
  return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : run;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
