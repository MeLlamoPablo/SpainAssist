import { AlertCircle, Bot, Check, Copy, ExternalLink, Focus, X } from 'lucide-react';
import { useState } from 'react';
import { formatClock, formatCost, formatDuration, formatTokens } from '../lib/format';
import { type BrowserTrace, type Frame, type Span, totalCost, totalTokens } from '../lib/model';
import { frameAt } from './data';
import { Thumb } from './Filmstrip';
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
              <Fact key={k} label={k} value={v} />
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
                <figure>
                  <Thumb frame={before} alt="The page before" />
                  <figcaption>Before · +{formatDuration(before.at - root.start)}</figcaption>
                </figure>
              )}
              {after && after !== before && (
                <figure>
                  <Thumb frame={after} alt="The page after" />
                  <figcaption>After · +{formatDuration(after.at - root.start)}</figcaption>
                </figure>
              )}
            </div>
          </section>
        )}

        {span.input && (
          <Code
            title={span.kind === 'tool' && span.name === 'codemode' ? 'Module' : 'Input'}
            text={span.input}
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

function Fact({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'wide' : undefined}>
      <dt>{label}</dt>
      <dd className="num" title={value}>
        {value}
      </dd>
    </div>
  );
}

function Code({ title, text, prose }: { title: string; text: string; prose?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="block">
      <h3>
        {title}
        <button
          type="button"
          className="icon-btn sm"
          aria-label={`Copy ${title.toLowerCase()}`}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </h3>
      <pre className={prose ? 'prose' : undefined}>{text}</pre>
    </section>
  );
}
