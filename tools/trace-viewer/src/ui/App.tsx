import {
  AlertCircle,
  AppWindow,
  Bot,
  FolderOpen,
  Moon,
  Search,
  Sparkles,
  Sun,
  Upload,
  Waypoints,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatClock, formatCost, formatDuration, formatTokens } from '../lib/format';
import {
  type BrowserTrace,
  failures,
  type Span,
  type Trace,
  totalCost,
  totalTokens,
  walk,
} from '../lib/model';
import { EvalSummary } from './Checks';
import { Details } from './Details';
import { type Opened, openFile, openInPlaywright, openServerSource } from './data';
import { LEGEND } from './kinds';
import { Waterfall } from './Waterfall';

type Theme = 'light' | 'dark' | undefined;

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('sa-traces-theme');
    return t === 'light' || t === 'dark' ? t : undefined;
  } catch {
    return undefined;
  }
}

export function App() {
  const [opened, setOpened] = useState<Opened>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [traceId, setTraceId] = useState<string>();
  const [focusId, setFocusId] = useState<string>();
  const [selected, setSelected] = useState<Span>();
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      if (theme) localStorage.setItem('sa-traces-theme', theme);
    } catch {}
  }, [theme]);

  const show = (o: Opened | undefined) => {
    setOpened(o);
    setTraceId(o?.traces[0]?.id);
    setFocusId(undefined);
    setSelected(undefined);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, at start.
  useEffect(() => {
    openServerSource()
      .then(show)
      .catch((err) => setError(String(err instanceof Error ? err.message : err)))
      .finally(() => setLoading(false));
  }, []);

  const open = async (file: File | undefined) => {
    if (!file) return;
    setLoading(true);
    setError(undefined);
    try {
      show(await openFile(file));
    } catch (err) {
      setError(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  // Files dropped anywhere on the page.
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void openRef.current(e.dataTransfer?.files[0]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const trace = opened?.traces.find((t) => t.id === traceId);
  const focus = useMemo(() => {
    if (!trace) return undefined;
    if (!focusId) return trace.root;
    for (const s of walk(trace.root)) if (s.id === focusId) return s;
    return trace.root;
  }, [trace, focusId]);
  const frames = useMemo(
    () => (trace ? trace.browser.flatMap((b) => b.frames).sort((a, b) => a.at - b.at) : []),
    [trace],
  );

  const openPlaywright = (b: BrowserTrace) => {
    if (opened) void openInPlaywright(b, opened.source).catch((err) => setError(String(err)));
  };

  const prefersDark =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme ? theme === 'dark' : prefersDark;

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <Waypoints size={15} />
          </span>
          <div>
            <strong>Traces</strong>
            <span className="muted">SpainAssist</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setTheme(dark ? 'light' : 'dark')}
            aria-label={dark ? 'Light theme' : 'Dark theme'}
          >
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>

        <button type="button" className="source" onClick={() => fileInput.current?.click()}>
          <FolderOpen size={14} />
          <span title={opened?.name}>{opened ? shortPath(opened.name) : 'Open a file…'}</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,.jsonl"
          hidden
          onChange={(e) => void open(e.target.files?.[0])}
        />

        {opened && opened.traces.length > 0 && (
          <label className="search">
            <Search size={13} />
            <input
              placeholder="Filter traces"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        )}

        {opened?.eval && (
          <EvalSummary
            run={opened.eval}
            onOpen={(check) => {
              const target = opened.traces.find((t) => t.id === check.traceId);
              const span = target && [...walk(target.root)].find((s) => s.id === check.spanId);
              if (!target || !span) return;
              setTraceId(target.id);
              setFocusId(undefined);
              setSelected(span);
            }}
          />
        )}

        <nav className="list" aria-label="Traces">
          {opened &&
            (['coordinator', 'agent', 'browser'] as const).map((group) => {
              const items = opened.traces.filter((t) => t.group === group && matches(t, query));
              if (!items.length) return null;
              return (
                <section key={group}>
                  <h4>
                    {group === 'coordinator'
                      ? 'Coordinator'
                      : group === 'agent'
                        ? 'Agents'
                        : 'Browser captures'}
                    <span className="list-count">{items.length}</span>
                  </h4>
                  {items.map((t) => (
                    <TraceItem
                      key={t.id}
                      trace={t}
                      selected={t.id === traceId}
                      focusId={t.id === traceId ? focusId : undefined}
                      onSelect={(focus) => {
                        setTraceId(t.id);
                        setFocusId(focus);
                        setSelected(undefined);
                      }}
                    />
                  ))}
                </section>
              );
            })}
        </nav>
        <ul className="keys">
          <li>
            Zoom <span className="keys-v">drag the axis · double-click a span</span>
          </li>
          <li>
            Move{' '}
            <span className="keys-v">
              <kbd>↑</kbd>
              <kbd>↓</kbd>
              <kbd>←</kbd>
              <kbd>→</kbd>
            </span>
          </li>
          <li>
            Details{' '}
            <span className="keys-v">
              <kbd>Enter</kbd>
            </span>
          </li>
          <li>
            Back{' '}
            <span className="keys-v">
              <kbd>Esc</kbd>
            </span>
          </li>
        </ul>
        {opened?.problems.length ? (
          <details className="problems">
            <summary>
              <AlertCircle size={13} /> {opened.problems.length} file(s) could not be read
            </summary>
            <ul>
              {opened.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </aside>

      <main className="main">
        {error && (
          <div className="banner" role="alert">
            <AlertCircle size={14} /> {error}
            <button
              type="button"
              className="icon-btn sm"
              onClick={() => setError(undefined)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {trace && focus ? (
          <>
            <Crumbs
              trace={trace}
              focus={focus}
              onUnfocus={focus !== trace.root ? () => setFocusId(undefined) : undefined}
            />
            <div className="stage">
              <section className="card trace-card">
                <Header trace={trace} focus={focus} />
                <Waterfall
                  root={focus}
                  frames={frames}
                  selectedId={selected?.id}
                  onSelect={setSelected}
                />
              </section>
              {selected && (
                <Details
                  span={selected}
                  root={focus}
                  frames={frames}
                  browser={trace.browser}
                  onClose={() => setSelected(undefined)}
                  onFocus={
                    selected !== focus
                      ? () => {
                          setFocusId(selected.id);
                          setSelected(undefined);
                        }
                      : undefined
                  }
                  onOpenPlaywright={openPlaywright}
                  related={relatedTrace(selected, opened?.traces ?? [], trace, (t) => {
                    setTraceId(t.id);
                    setFocusId(undefined);
                    setSelected(undefined);
                  })}
                />
              )}
            </div>
          </>
        ) : (
          <Empty loading={loading} opened={opened} onPick={() => fileInput.current?.click()} />
        )}
      </main>
      {dragging && (
        <div className="drop" aria-hidden>
          <div>
            <Upload size={22} />
            <strong className="drop-title">Drop to open</strong>
            <span>A transcripts export, a browser capture’s trace.zip, or a session.jsonl</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The agent's trace that a coordinator's call names (`agent_start`, `agent_message`…). */
function relatedTrace(
  span: Span,
  traces: Trace[],
  current: Trace,
  open: (t: Trace) => void,
): { title: string; open(): void } | undefined {
  if (span.kind !== 'tool' || !span.name.startsWith('agent_')) return undefined;
  const ids = `${span.input ?? ''}\n${span.output ?? ''}`.match(/\ba_[A-Za-z0-9]+/g) ?? [];
  const target = traces.find(
    (t) => t !== current && ids.some((id) => t.path.includes(`agents/${id}/`)),
  );
  return target ? { title: target.title, open: () => open(target) } : undefined;
}

function matches(t: Trace, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return [t.title, t.subtitle, t.path].some((v) => v?.toLowerCase().includes(s));
}

function TraceItem({
  trace,
  selected,
  focusId,
  onSelect,
}: {
  trace: Trace;
  selected: boolean;
  focusId?: string;
  onSelect(focusId?: string): void;
}) {
  const { root } = trace;
  const errors = useMemo(() => failures(root).length, [root]);
  const cost = useMemo(() => totalCost(root), [root]);
  const turns = root.children.filter((c) => c.kind === 'turn');
  const Icon = trace.group === 'browser' ? AppWindow : Bot;
  return (
    <div className={`item${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className={`item-main${selected && !focusId ? ' is-current' : ''}`}
        onClick={() => onSelect(undefined)}
      >
        <span className="item-icon" aria-hidden>
          <Icon size={14} />
        </span>
        <span className="item-text">
          <span className="item-title" title={`${trace.title}\n${formatClock(root.start)}`}>
            {trace.title}
          </span>
          <span className="item-sub">
            {formatDuration((root.end ?? root.start) - root.start)}
            {cost > 0 && ` · ${formatCost(cost)}`}
          </span>
        </span>
        {errors > 0 && (
          <span className="item-errors" title={`${errors} failed`}>
            <AlertCircle size={12} />
            {errors}
          </span>
        )}
      </button>
      {selected && turns.length > 0 && (
        <ol className="turns">
          {turns.map((turn, i) => (
            <li key={turn.id}>
              <button
                type="button"
                className={turn.id === focusId ? 'is-current' : undefined}
                onClick={() => onSelect(turn.id)}
              >
                <span className="turn-n">{i + 1}</span>
                <span className="turn-name" title={turn.name}>
                  {turn.name}
                </span>
                <span className="turn-dur">
                  {formatDuration((turn.end ?? turn.start) - turn.start)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Crumbs({
  trace,
  focus,
  onUnfocus,
}: {
  trace: Trace;
  focus: Span;
  onUnfocus?: () => void;
}) {
  const group =
    trace.group === 'coordinator' ? 'Coordinator' : trace.group === 'agent' ? 'Agents' : 'Browser';
  const turn = trace.root.children.indexOf(focus) + 1;
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <span>{group}</span>
      <Chevron />
      {onUnfocus ? (
        <>
          <button type="button" onClick={onUnfocus}>
            {trace.title}
          </button>
          <Chevron />
          <span className="here">
            {focus.kind === 'turn' && turn ? `Turn ${turn}` : focus.name}
          </span>
        </>
      ) : (
        <span className="here">{trace.title}</span>
      )}
    </nav>
  );
}

function Chevron() {
  return <span className="crumb-sep" aria-hidden />;
}

function Header({ trace, focus }: { trace: Trace; focus: Span }) {
  const stats = useMemo(() => {
    let llm = 0;
    let tools = 0;
    let browser = 0;
    for (const s of walk(focus)) {
      if (s.kind === 'llm') llm++;
      if (s.kind === 'tool' || s.kind === 'op') tools++;
      if (s.kind === 'browser') browser++;
    }
    const tokens = totalTokens(focus);
    return {
      llm,
      tools,
      browser,
      errors: failures(focus).length,
      cost: totalCost(focus),
      tokens: tokens.input + tokens.output,
    };
  }, [focus]);
  const duration = (focus.end ?? focus.start) - focus.start;
  const kind =
    focus === trace.root
      ? trace.group === 'browser'
        ? 'Browser'
        : trace.group === 'coordinator'
          ? 'Coordinator'
          : 'Agent'
      : focus.kind === 'turn'
        ? 'Turn'
        : 'Span';
  return (
    <header className="card-head">
      <div className="card-title">
        <Sparkles size={15} className="spark" aria-hidden />
        <strong>{kind}</strong>
        <span className="card-sub" title={focus.name}>
          {focus === trace.root && trace.group !== 'browser' ? trace.title : focus.name}
        </span>
        <span className="card-when num">{formatClock(focus.start)}</span>
        <ul className="legend" aria-label="Legend">
          {LEGEND.map((l) => (
            <li key={l.tone}>
              <span className={`swatch tone-${l.tone}`} />
              {l.label}
            </li>
          ))}
          <li>
            <span className="swatch tone-error" />
            Failed
          </li>
        </ul>
      </div>
      <div className="stats">
        <Stat label="Duration" value={formatDuration(duration)} />
        {stats.cost > 0 && <Stat label="Cost" value={formatCost(stats.cost)} />}
        {stats.tokens > 0 && <Stat label="Tokens" value={formatTokens(stats.tokens)} />}
        {stats.llm > 0 && <Stat label="LLM calls" value={String(stats.llm)} />}
        {stats.tools > 0 && <Stat label="Tool calls" value={String(stats.tools)} />}
        {stats.browser > 0 && <Stat label="Browser" value={String(stats.browser)} />}
        <Stat
          label="Errors"
          value={String(stats.errors)}
          tone={stats.errors ? 'error' : undefined}
        />
      </div>
    </header>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'error' }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <span>{label}</span>
      <strong className="num">{value}</strong>
    </div>
  );
}

function Empty({ loading, opened, onPick }: { loading: boolean; opened?: Opened; onPick(): void }) {
  if (loading)
    return (
      <div className="empty">
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  return (
    <div className="empty">
      <div className="empty-card">
        <span className="empty-art" aria-hidden>
          <span className="tone-llm" style={{ width: '58%' }} />
          <span className="tone-tool" style={{ width: '70%', marginLeft: '18%' }} />
          <span className="tone-browser" style={{ width: '38%', marginLeft: '40%' }} />
        </span>
        <h2>{opened ? 'No traces in this file' : 'Open a trace'}</h2>
        <p>
          Drop a transcripts export (<em>Ajustes → Exportar historial</em>), a browser capture’s{' '}
          <code>trace.zip</code> or a <code>session.jsonl</code> here.
        </p>
        <button type="button" className="btn primary" onClick={onPick}>
          <FolderOpen size={14} /> Choose a file
        </button>
        <p className="muted small">
          Or run <code>corepack pnpm traces &lt;path&gt;</code> on a profile folder.
        </p>
      </div>
    </div>
  );
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}
