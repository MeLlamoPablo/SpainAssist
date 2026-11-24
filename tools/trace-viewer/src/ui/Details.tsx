import { AlertCircle, Bot, Check, Copy, ExternalLink, Focus, Maximize2, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ThemedToken } from 'shiki/core';
import { formatClock, formatCost, formatDuration, formatTokens } from '../lib/format';
import { type BrowserTrace, type Frame, type Span, totalCost, totalTokens } from '../lib/model';
import { frameAt } from './data';
import { Thumb } from './Filmstrip';
import { highlight, type Lang } from './highlight';
import { iconOf, KIND } from './kinds';

interface Props {
  span: Span;
  root: Span;
  frames: Frame[];
  browser: BrowserTrace[];
  onClose(): void;
  onFocus?(): void;
  onOpenPlaywright(trace: BrowserTrace): void;
  /** Another loaded trace this span names (the agent a coordinator's call started). */
  related?: { title: string; open(): void };
}

export function Details({
  span,
  root,
  frames,
  browser,
  onClose,
  onFocus,
  onOpenPlaywright,
  related,
}: Props) {
  const meta = KIND[span.kind];
  const Icon = iconOf(span);
  const end = span.end ?? root.end ?? span.start;
  const tone = span.status === 'error' ? 'error' : meta.tone;
  const cost = span.kind === 'llm' ? (span.cost ?? 0) : totalCost(span);
  const tokens =
    span.kind === 'llm'
      ? { input: span.tokensIn ?? 0, output: span.tokensOut ?? 0 }
      : totalTokens(span);
  const browserTrace = span.browser
    ? browser.find((b) => b.id === span.browser?.traceId)
    : undefined;
  const isBrowserish =
    span.kind === 'browser' || (span.kind === 'op' && span.name.startsWith('browser.'));
  const before = isBrowserish ? frameAt(frames, span.start) : undefined;
  const after = isBrowserish ? frameAt(frames, end + 150) : undefined;
  const linked = browserTrace ?? (isBrowserish ? browser[0] : undefined);

  return (
    <aside className="details" aria-label={`${span.name} details`}>
      <header className="details-head">
        <span className={`wf-icon lg tone-${tone}`} aria-hidden>
          {span.status === 'error' ? <AlertCircle size={15} /> : <Icon size={15} />}
        </span>
        <div className="details-title">
          <span className="eyebrow">{meta.label}</span>
          <h2 title={span.name}>{span.name}</h2>
          {span.detail && <p className="muted mono">{span.detail}</p>}
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details">
          <X size={16} />
        </button>
      </header>

      <div className="details-body">
        <dl className="facts">
          <Fact label="Duration" value={formatDuration(end - span.start)} />
          <Fact label="Starts at" value={`+${formatDuration(span.start - root.start)}`} />
          <Fact label="Clock" value={formatClock(span.start)} wide />
          {tokens.input + tokens.output > 0 && (
            <>
              <Fact label="Tokens in" value={formatTokens(tokens.input)} />
              <Fact label="Tokens out" value={formatTokens(tokens.output)} />
            </>
          )}
          {span.cacheRead ? <Fact label="Cached" value={formatTokens(span.cacheRead)} /> : null}
          {cost > 0 && <Fact label="Cost" value={formatCost(cost)} />}
          {span.children.length > 0 && (
            <Fact label="Children" value={String(span.children.length)} />
          )}
          {(span.attrs ?? [])
            .filter(([k]) => k !== 'Thinking')
            .map(([k, v]) => (
              <Fact key={k} label={k} value={v} copy={k === 'Run'} />
            ))}
        </dl>

        {(onFocus || linked || related) && (
          <div className="details-actions">
            {onFocus && span.children.length > 0 && (
              <button type="button" className="btn" onClick={onFocus}>
                <Focus size={14} /> Focus this span
              </button>
            )}
            {related && (
              <button type="button" className="btn" onClick={related.open}>
                <Bot size={14} /> Open {related.title}
              </button>
            )}
            {linked && (
              <button
                type="button"
                className="btn primary"
                onClick={() => onOpenPlaywright(linked)}
              >
                <ExternalLink size={14} /> Open in Playwright Trace Viewer
              </button>
            )}
          </div>
        )}

        {span.error && (
          <section className="block error">
            <h3>
              <AlertCircle size={13} /> Error
            </h3>
            <pre>{span.error}</pre>
          </section>
        )}

        {(before || after) && (
          <section className="block">
            <h3>Page</h3>
            <div className="shots">
              {before && (
                <Shot
                  frame={before}
                  alt="The page before"
                  caption={`Before · +${formatDuration(before.at - root.start)}`}
                />
              )}
              {after && after !== before && (
                <Shot
                  frame={after}
                  alt="The page after"
                  caption={`After · +${formatDuration(after.at - root.start)}`}
                />
              )}
            </div>
          </section>
        )}

        {span.input && (
          <Code
            title={span.kind === 'tool' && span.name === 'codemode' ? 'Module' : 'Input'}
            text={span.input}
            js={span.kind === 'tool' && span.name === 'codemode'}
            json={span.kind === 'tool' && span.name !== 'codemode'}
          />
        )}
        {span.attrs?.find(([k]) => k === 'Thinking') && (
          <Code title="Thinking" text={span.attrs.find(([k]) => k === 'Thinking')![1]} prose />
        )}
        {span.output && (
          <Code
            title={span.kind === 'browser' ? 'Log' : 'Output'}
            text={span.output}
            prose={span.kind === 'llm' || span.kind === 'turn'}
          />
        )}
      </div>
    </aside>
  );
}

function Fact({
  label,
  value,
  wide,
  copy,
}: {
  label: string;
  value: string;
  wide?: boolean;
  /** A click copies the value (a run's id, cut short here). */
  copy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={wide ? 'wide' : undefined}>
      <dt>{label}</dt>
      <dd className="num" title={value}>
        {copy ? (
          <button
            type="button"
            className="fact-copy"
            title={`Copy ${value}`}
            onClick={() => {
              void navigator.clipboard?.writeText(value).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? 'Copied' : value}
          </button>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

/** A screenshot that opens full screen on a click. */
function Shot({ frame, alt, caption }: { frame: Frame; alt: string; caption: string }) {
  const [full, setFull] = useState(false);
  return (
    <figure>
      <button
        type="button"
        className="shot-btn"
        aria-label={`Show ${alt.toLowerCase()} full screen`}
        onClick={() => setFull(true)}
      >
        <Thumb frame={frame} alt={alt} />
      </button>
      <figcaption>{caption}</figcaption>
      {full &&
        createPortal(
          <FullScreen title={caption} onClose={() => setFull(false)}>
            <h3>
              {caption}
              <button
                type="button"
                className="icon-btn sm"
                aria-label="Close full screen"
                onClick={() => setFull(false)}
                // biome-ignore lint/a11y/noAutofocus: the dialog's way out takes the focus when it opens
                autoFocus
              >
                <X size={12} />
              </button>
            </h3>
            <div className="full-shot">
              <Thumb frame={frame} alt={alt} />
            </div>
          </FullScreen>,
          document.body,
        )}
    </figure>
  );
}

function Code({
  title,
  text,
  prose,
  js,
  json,
}: {
  title: string;
  text: string;
  prose?: boolean;
  js?: boolean;
  /** Colored as JSON when the text is JSON (a tool's arguments). */
  json?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [full, setFull] = useState(false);
  const shown = useLaidOut(text, js ? 'js' : prose ? 'prose' : 'json');
  const lang: Lang | undefined = js ? 'javascript' : json && isJson(shown) ? 'json' : undefined;
  const lines = useHighlighted(shown, lang);
  const body = lines ? (
    <pre className={js ? 'code' : undefined}>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity but their place
        <span key={i}>
          {line.map((token, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: neither do tokens
            <span key={j} className="tok" style={token.htmlStyle as CSSProperties}>
              {token.content}
            </span>
          ))}
          {'\n'}
        </span>
      ))}
    </pre>
  ) : (
    <pre className={prose ? 'prose' : js ? 'code' : undefined}>{shown}</pre>
  );
  const actions = (
    <span className="block-actions">
      <button
        type="button"
        className="icon-btn sm"
        aria-label={`Copy ${title.toLowerCase()}`}
        onClick={() => {
          void navigator.clipboard?.writeText(shown).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {full ? (
        <button
          type="button"
          className="icon-btn sm"
          aria-label="Close full screen"
          onClick={() => setFull(false)}
          // biome-ignore lint/a11y/noAutofocus: the dialog's way out takes the focus when it opens
          autoFocus
        >
          <X size={12} />
        </button>
      ) : (
        <button
          type="button"
          className="icon-btn sm"
          aria-label={`Show ${title.toLowerCase()} full screen`}
          onClick={() => setFull(true)}
        >
          <Maximize2 size={12} />
        </button>
      )}
    </span>
  );
  return (
    <section className="block">
      <h3>
        {title}
        {!full && actions}
      </h3>
      {body}
      {full &&
        createPortal(
          <FullScreen title={title} onClose={() => setFull(false)}>
            <h3>
              {title}
              {actions}
            </h3>
            {body}
          </FullScreen>,
          document.body,
        )}
    </section>
  );
}

function FullScreen({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The waterfall's Escape would also close the details.
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click on the backdrop closes, as Escape does
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the window
    <div className="full-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="full-panel block" role="dialog" aria-modal="true" aria-label={title}>
        {children}
      </div>
    </div>
  );
}

/** The text laid out to read: a codemode module by Biome (on the server), JSON indented. */
function useLaidOut(text: string, kind: 'js' | 'json' | 'prose'): string {
  const [module, setModule] = useState<{ from: string; to: string }>();
  useEffect(() => {
    if (kind !== 'js') return;
    let live = true;
    fetch('/api/format', { method: 'POST', body: text })
      .then((res) => (res.ok ? res.text() : undefined))
      .then((to) => {
        if (live && to) setModule({ from: text, to });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [text, kind]);
  if (kind === 'js') return module?.from === text ? module.to : text;
  if (kind === 'json') return indentJson(text) ?? text;
  return text;
}

/** The text's lines as colored tokens, once Shiki has them; undefined until then or if it fails. */
function useHighlighted(text: string, lang: Lang | undefined): ThemedToken[][] | undefined {
  const [highlighted, setHighlighted] = useState<{ text: string; lines: ThemedToken[][] }>();
  useEffect(() => {
    if (!lang) return;
    let live = true;
    highlight(text, lang)
      .then((lines) => {
        if (live) setHighlighted({ text, lines });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [text, lang]);
  return lang && highlighted?.text === text ? highlighted.lines : undefined;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** JSON indented, also after a first line such as a run's `Result:`. */
function indentJson(text: string): string | undefined {
  const start = /(?:^|\n)\s*[[{]/.exec(text);
  if (!start) return undefined;
  const at = start.index + start[0].length - 1;
  try {
    return text.slice(0, at) + JSON.stringify(JSON.parse(text.slice(at)), null, 2);
  } catch {
    return undefined;
  }
}
