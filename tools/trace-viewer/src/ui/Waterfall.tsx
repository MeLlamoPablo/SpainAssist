import { AlertCircle, ChevronRight, Maximize2 } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { formatCost, formatDuration, formatTick, tickStep, ticks } from '../lib/format';
import { type BrowserTrace, type Frame, type Span, totalCost, walk } from '../lib/model';
import { Filmstrip } from './Filmstrip';
import { iconOf, isGroup, KIND } from './kinds';

const ROW_H = 30;
const OVERSCAN = 12;
const MIN_TREE = 260;
/** Room after the latest span for its duration label, as a share of the window. */
const RIGHT_PAD = 0.07;

interface Row {
  span: Span;
  depth: number;
  parent?: Span;
  /** For each ancestor level below the root: whether its line goes on below this row. */
  guides: boolean[];
  last: boolean;
}

export interface WaterfallProps {
  root: Span;
  frames: Frame[];
  browser: BrowserTrace[];
  selectedId?: string;
  onSelect(span: Span | undefined): void;
}

interface View {
  from: number;
  to: number;
}

export function Waterfall({ root, frames, browser, selectedId, onSelect }: WaterfallProps) {
  const rootEnd = root.end ?? root.start;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => defaultCollapsed(root));
  const [zoom, setZoom] = useState<View>();
  /** The tree column's share of the waterfall's width (the timeline gets the rest). */
  const [treeShare, setTreeShare] = useState(0.42);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ height: 600, timeline: 600, width: 1200 });
  const [hoverX, setHoverX] = useState<number>();
  const [drag, setDrag] = useState<{ from: number; to: number }>();
  const [active, setActive] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // A new trace or turn: everything starts over.
  useEffect(() => {
    setCollapsed(defaultCollapsed(root));
    setZoom(undefined);
    setActive(0);
    scroller.current?.scrollTo({ top: 0 });
  }, [root]);

  const rows = useMemo(() => flatten(root, collapsed), [root, collapsed]);

  // The window: the zoom, else the whole root, with room on the right for labels.
  const span = Math.max(1, (zoom ? zoom.to - zoom.from : rootEnd - root.start) || 1);
  const from = zoom?.from ?? root.start;
  const to = (zoom?.to ?? rootEnd) + span * RIGHT_PAD;
  const width = Math.max(1, to - from);
  const x = useCallback((t: number) => ((t - from) / width) * 100, [from, width]);
  const step = tickStep(span, Math.max(2, Math.floor(viewport.timeline / 90)));
  const axis = useMemo(() => {
    const offset = from - root.start;
    return ticks(offset, offset + width, step).map((t) => ({ t, left: x(root.start + t) }));
  }, [from, width, step, root.start, x]);

  const slowest = useMemo(() => slowestIds(root), [root]);
  const pxPerMs = viewport.timeline / width;

  useLayoutEffect(() => {
    const el = scroller.current;
    const tl = timelineRef.current;
    if (!el || !tl) return;
    const measure = () =>
      setViewport({ height: el.clientHeight, timeline: tl.clientWidth, width: el.clientWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(tl);
    return () => ro.disconnect();
  }, []);

  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const lastRow = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewport.height) / ROW_H) + OVERSCAN,
  );

  const toggle = (id: string, open?: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      const shut = open === undefined ? !next.has(id) : !open;
      if (shut) next.add(id);
      else next.delete(id);
      return next;
    });

  const focusRow = (index: number) => {
    const i = Math.max(0, Math.min(rows.length - 1, index));
    setActive(i);
    const el = scroller.current;
    if (!el) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight - stickyHeight(frames))
      el.scrollTop = top + ROW_H - el.clientHeight + stickyHeight(frames);
  };

  // Keep the selected span's row in view and focused (e.g. picked from the filmstrip).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the selection changes.
  useEffect(() => {
    if (!selectedId) return;
    const i = rows.findIndex((r) => r.span.id === selectedId);
    if (i >= 0) focusRow(i);
  }, [selectedId]);

  const onKey = (e: KeyboardEvent) => {
    const row = rows[active];
    if (!row) return;
    const open = row.span.children.length > 0 && !collapsed.has(row.span.id);
    switch (e.key) {
      case 'ArrowDown':
        focusRow(active + 1);
        break;
      case 'ArrowUp':
        focusRow(active - 1);
        break;
      case 'Home':
        focusRow(0);
        break;
      case 'End':
        focusRow(rows.length - 1);
        break;
      case 'ArrowRight':
        if (row.span.children.length && !open) toggle(row.span.id, true);
        else if (open) focusRow(active + 1);
        break;
      case 'ArrowLeft':
        if (open) toggle(row.span.id, false);
        else if (row.parent) focusRow(rows.findIndex((r) => r.span === row.parent));
        break;
      case 'Enter':
      case ' ':
        onSelect(row.span.id === selectedId ? undefined : row.span);
        break;
      case 'Escape':
        if (selectedId) onSelect(undefined);
        else if (zoom) setZoom(undefined);
        break;
      case 'z':
        zoomTo(row.span);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const zoomTo = (s: Span) => {
    const end = s.end ?? rootEnd;
    const pad = Math.max(1, (end - s.start) * 0.04);
    setZoom({ from: Math.max(root.start, s.start - pad), to: end + pad });
  };

  // Time under the pointer, from an x in the timeline column.
  const timeAt = (clientX: number) => {
    const tl = timelineRef.current;
    if (!tl) return from;
    const rect = tl.getBoundingClientRect();
    return from + ((clientX - rect.left) / rect.width) * width;
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const tl = timelineRef.current;
    if (!tl) return;
    const rect = tl.getBoundingClientRect();
    const px = e.clientX - rect.left;
    setHoverX(px >= 0 && px <= rect.width ? px : undefined);
    if (drag) setDrag({ ...drag, to: timeAt(e.clientX) });
  };

  const onRulerDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const t = timeAt(e.clientX);
    setDrag({ from: t, to: t });
  };
  const onRulerUp = () => {
    if (drag && Math.abs(drag.to - drag.from) * pxPerMs > 6) {
      const a = Math.max(root.start, Math.min(drag.from, drag.to));
      const b = Math.min(rootEnd, Math.max(drag.from, drag.to));
      if (b > a) setZoom({ from: a, to: b });
    }
    setDrag(undefined);
  };

  const treeWidth = Math.round(
    Math.max(MIN_TREE, Math.min(viewport.width * 0.7, treeShare * viewport.width)),
  );
  const onResize = (e: ReactPointerEvent) => {
    const startX = e.clientX;
    const startW = treeWidth;
    const move = (ev: PointerEvent) => {
      const total = scroller.current?.clientWidth ?? 1200;
      setTreeShare(Math.max(0.15, Math.min(0.7, (startW + ev.clientX - startX) / total)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const hoverTime = hoverX !== undefined ? from + (hoverX / viewport.timeline) * width : undefined;
  const hasCost = useMemo(() => totalCost(root) > 0, [root]);
  const style = {
    '--tree-w': `${treeWidth}px`,
    '--cost-w': hasCost ? '64px' : '0px',
  } as CSSProperties;

  return (
    <div className={`wf${hasCost ? '' : ' no-cost'}`} style={style}>
      <div
        ref={scroller}
        className="wf-scroll"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverX(undefined)}
      >
        <div className="wf-sticky">
          {frames.length > 0 && (
            <div className="wf-band">
              <div className="wf-band-label">
                <span>Screenshots</span>
                <span className="muted">{frames.length}</span>
              </div>
              <div className="wf-band-track">
                <Filmstrip
                  frames={frames}
                  from={from}
                  to={to}
                  width={viewport.timeline}
                  hoverTime={hoverTime}
                  onPick={(at) => {
                    const near = nearestBrowserSpan(root, at);
                    if (near) onSelect(near);
                  }}
                />
              </div>
            </div>
          )}
          <div className="wf-ruler">
            <div className="wf-cols">
              <span>Span</span>
              <span className="num">Duration</span>
              <span className="num">Cost</span>
            </div>
            <div
              className="wf-axis"
              ref={timelineRef}
              onPointerDown={onRulerDown}
              onPointerUp={onRulerUp}
              title="Drag to zoom"
            >
              {axis.map(({ t, left }) => (
                <span key={t} className="wf-tick" style={{ left: `${left}%` }}>
                  {formatTick(t, step)}
                </span>
              ))}
              {hoverX !== undefined && hoverTime !== undefined && (
                <span className="wf-cursor-label" style={{ left: hoverX }}>
                  {formatDuration(hoverTime - root.start)}
                </span>
              )}
              {drag && (
                <span
                  className="wf-drag"
                  style={{
                    left: `${x(Math.min(drag.from, drag.to))}%`,
                    width: `${(Math.abs(drag.to - drag.from) / width) * 100}%`,
                  }}
                />
              )}
              {zoom && (
                <button type="button" className="wf-reset" onClick={() => setZoom(undefined)}>
                  <Maximize2 size={12} /> Whole trace
                </button>
              )}
            </div>
            <span className="wf-resize" onPointerDown={onResize} aria-hidden />
          </div>
        </div>

        <div
          className="wf-rows"
          style={{ height: rows.length * ROW_H }}
          role="tree"
          aria-label={`${root.name} spans`}
          aria-activedescendant={rows[active] ? rowId(rows[active].span) : undefined}
          tabIndex={0}
          onKeyDown={onKey}
        >
          <div className="wf-grid" aria-hidden>
            {axis.map(({ t, left }) => (
              <span key={t} style={{ left: `${left}%` }} />
            ))}
            {hoverX !== undefined && <span className="wf-cursor" style={{ left: hoverX }} />}
          </div>
          {rows.slice(firstRow, lastRow).map((row, i) => {
            const index = firstRow + i;
            return (
              <RowView
                key={row.span.id}
                row={row}
                top={index * ROW_H}
                x={x}
                timelineWidth={viewport.timeline}
                rootEnd={rootEnd}
                open={!collapsed.has(row.span.id)}
                active={index === active}
                selected={row.span.id === selectedId}
                slowest={slowest.has(row.span.id)}
                hasBrowser={browser.length > 0}
                onToggle={() => toggle(row.span.id)}
                onClick={() => {
                  setActive(index);
                  onSelect(row.span.id === selectedId ? undefined : row.span);
                }}
                onZoom={() => zoomTo(row.span)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  row: Row;
  top: number;
  x(t: number): number;
  timelineWidth: number;
  rootEnd: number;
  open: boolean;
  active: boolean;
  selected: boolean;
  slowest: boolean;
  hasBrowser: boolean;
  onToggle(): void;
  onClick(): void;
  onZoom(): void;
}

function RowView(props: RowProps) {
  const { row, x, timelineWidth, rootEnd, open, active, selected, slowest } = props;
  const { span } = row;
  const meta = KIND[span.kind];
  const Icon = iconOf(span);
  const end = span.end ?? rootEnd;
  const duration = end - span.start;
  const left = x(span.start);
  const right = x(end);
  const barWidth = Math.max(right - left, 0);
  const cost =
    span.kind === 'llm'
      ? span.cost
      : isGroup(span) || span.kind === 'tool'
        ? totalCost(span)
        : undefined;
  const unfinished = span.end === undefined;
  const label = formatDuration(duration);
  // The duration goes after the bar, or before it when the bar reaches the right edge.
  const labelPx = label.length * 6.5 + 10;
  const after =
    ((100 - right) / 100) * timelineWidth >= labelPx || (left / 100) * timelineWidth < labelPx;
  const tone = span.status === 'error' ? 'error' : meta.tone;

  return (
    // Keys go to the tree, which holds the focus (aria-activedescendant names this row).
    // biome-ignore lint/a11y/useKeyWithClickEvents: the tree handles the keyboard.
    <div
      id={rowId(span)}
      tabIndex={-1}
      className={`wf-row${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
      style={{ transform: `translateY(${props.top}px)` }}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={span.children.length ? open : undefined}
      aria-selected={selected}
      onClick={props.onClick}
      onDoubleClick={props.onZoom}
    >
      <div className="wf-tree">
        <span className="wf-guides" aria-hidden>
          {row.guides.map((on, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one guide per ancestor level.
            <span key={i} className={on ? 'on' : ''} />
          ))}
          {row.depth > 0 && <span className={`elbow${row.last ? ' last' : ''}`} />}
        </span>
        {span.children.length ? (
          <button
            type="button"
            className={`wf-chevron${open ? ' open' : ''}`}
            tabIndex={-1}
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggle();
            }}
          >
            <ChevronRight size={14} />
          </button>
        ) : (
          <span className="wf-chevron-spacer" />
        )}
        <span className={`wf-icon tone-${tone}`} aria-hidden>
          {span.status === 'error' ? <AlertCircle size={13} /> : <Icon size={13} />}
        </span>
        <span className="wf-name" title={span.name}>
          {span.name}
        </span>
        {span.detail && (
          <span className="wf-detail" title={span.detail}>
            {span.detail}
          </span>
        )}
        {slowest && <span className="wf-tag">Slowest</span>}
        {unfinished && <span className="wf-tag warn">Unfinished</span>}
        {span.children.length > 0 && !open && <span className="wf-count">{countAll(span)}</span>}
      </div>
      <div className="wf-dur num">{label}</div>
      <div className="wf-cost num">{formatCost(cost)}</div>
      <div className="wf-track">
        <div className="wf-track-in">
          <span
            className={`wf-bar tone-${tone}${isGroup(span) ? ' group' : ''}${unfinished ? ' unfinished' : ''}`}
            style={{ left: `${left}%`, width: `max(${barWidth}%, 2px)` }}
          />
          <span
            className="wf-bar-label num"
            style={
              after ? { left: `calc(${right}% + 6px)` } : { right: `calc(${100 - left}% + 6px)` }
            }
          >
            {label}
          </span>
        </div>
      </div>
    </div>
  );
}

function rowId(span: Span): string {
  return `span-${span.id.replace(/[^\w-]/g, '_')}`;
}

function stickyHeight(frames: Frame[]): number {
  return (frames.length ? 64 : 0) + 34;
}

function flatten(root: Span, collapsed: Set<string>): Row[] {
  const rows: Row[] = [];
  const visit = (
    span: Span,
    depth: number,
    guides: boolean[],
    parent: Span | undefined,
    last: boolean,
  ) => {
    rows.push({ span, depth, parent, guides, last });
    if (collapsed.has(span.id)) return;
    const kids = span.children;
    kids.forEach((child, i) => {
      const isLast = i === kids.length - 1;
      visit(child, depth + 1, depth === 0 ? [] : [...guides, !last], span, isLast);
    });
  };
  visit(root, 0, [], undefined, true);
  return rows;
}

/** Big families start folded: a run with hundreds of calls, nested Playwright steps. */
function defaultCollapsed(root: Span): Set<string> {
  const out = new Set<string>();
  for (const span of walk(root)) {
    if (span === root) continue;
    if (span.children.length > 60 || span.kind === 'browser') out.add(span.id);
  }
  return out;
}

function countAll(span: Span): number {
  let n = -1;
  for (const _ of walk(span)) n++;
  return n;
}

/** The slowest model call, and the slowest tool call or API call, when there are several. */
function slowestIds(root: Span): Set<string> {
  const pick = (kinds: Span['kind'][]) => {
    let best: Span | undefined;
    let count = 0;
    for (const s of walk(root)) {
      if (!kinds.includes(s.kind) || s.end === undefined) continue;
      count++;
      if (!best || s.end - s.start > (best.end ?? 0) - best.start) best = s;
    }
    return count > 1 ? best : undefined;
  };
  return new Set(
    [pick(['llm']), pick(['tool']), pick(['op'])].filter((s): s is Span => !!s).map((s) => s.id),
  );
}

function nearestBrowserSpan(root: Span, at: number): Span | undefined {
  let best: Span | undefined;
  for (const s of walk(root)) {
    if (s.kind !== 'browser' && !(s.kind === 'op' && s.name.startsWith('browser.'))) continue;
    if (s.start > at) continue;
    if (!best || s.start > best.start) best = s;
  }
  return best;
}
