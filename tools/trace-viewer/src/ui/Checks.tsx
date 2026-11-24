/**
 * An eval run's checks: a badge on each span that made one pass or fail, and on a folded span
 * that holds such spans; on hover, what the check asks, when it first held and what it does to
 * the run's score.
 */
import { CircleCheck, CircleX } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EvalCheck, EvalRun } from '../lib/checks';
import { type Span, walk } from '../lib/model';

const KIND_LABEL: Record<EvalCheck['kind'], string> = {
  required: 'Required',
  scored: 'Scored',
  precondition: 'Precondition',
};

/** The checks of a span and of everything under it. */
export function nestedChecks(span: Span): EvalCheck[] {
  const out: EvalCheck[] = [];
  for (const s of walk(span)) out.push(...(s.checks ?? []));
  return out;
}

/** One badge for the passed checks and one for the failed, each with its count over 1. */
export function CheckBadges({ checks, nested }: { checks: EvalCheck[]; nested?: boolean }) {
  if (!checks.length) return null;
  const passed = checks.filter((c) => c.passed);
  const failed = checks.filter((c) => !c.passed);
  return (
    <span className={`checks${nested ? ' nested' : ''}`}>
      {failed.length > 0 && <Badge checks={failed} passed={false} nested={nested} />}
      {passed.length > 0 && <Badge checks={passed} passed nested={nested} />}
    </span>
  );
}

function Badge({
  checks,
  passed,
  nested,
}: {
  checks: EvalCheck[];
  passed: boolean;
  nested?: boolean;
}) {
  const Icon = passed ? CircleCheck : CircleX;
  const label = `${checks.length} check${checks.length > 1 ? 's' : ''} ${passed ? 'passed' : 'failed'}${nested ? ' inside' : ''}`;
  return (
    <Hover tip={<CheckTips checks={checks} />}>
      <span className={`check-badge ${passed ? 'pass' : 'fail'}`} role="img" aria-label={label}>
        <Icon size={13} />
        {checks.length > 1 && <span className="num">{checks.length}</span>}
      </span>
    </Hover>
  );
}

/** Shows `tip` beside `children` while the pointer or the focus is on them. */
function Hover({ tip, right, children }: { tip: ReactNode; right?: boolean; children: ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number; below: boolean }>();
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const below = r.top < window.innerHeight / 2;
    // Beside it (the sidebar's list), else under or over it.
    const [top, bottom] = right ? [r.top - 10, r.bottom + 10] : [r.bottom + 6, r.top - 6];
    setAt({
      x: Math.min(right ? r.right + 8 : r.left, window.innerWidth - 380),
      y: below ? top : bottom,
      below,
    });
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only shows what the label says.
    <span
      className="hover"
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setAt(undefined)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setAt(undefined)}
    >
      {children}
      {at &&
        createPortal(
          <div
            className="check-tip"
            role="tooltip"
            style={{
              left: Math.max(8, at.x),
              ...(at.below ? { top: at.y } : { bottom: window.innerHeight - at.y }),
            }}
          >
            {tip}
          </div>,
          document.body,
        )}
    </span>
  );
}

function CheckTips({ checks }: { checks: EvalCheck[] }) {
  return (
    <ul className="check-tips">
      {checks.map((c) => (
        <li key={c.ruleId}>
          <CheckText check={c} />
        </li>
      ))}
    </ul>
  );
}

/** A check in full: its outcome, what it asks, what was seen, what it does to the run. */
export function CheckText({ check }: { check: EvalCheck }) {
  const Icon = check.passed ? CircleCheck : CircleX;
  return (
    <div className="check-text">
      <p className="check-head">
        <Icon size={13} className={check.passed ? 'pass' : 'fail'} aria-hidden />
        <strong>{check.ruleId}</strong>
        <span className="muted">
          {KIND_LABEL[check.kind]}
          {check.negate ? ' · must not happen' : ''} · {check.passed ? 'passed' : 'failed'}
        </span>
      </p>
      {check.description && <p>{check.description}</p>}
      {check.seen && (
        <p className="muted">
          First true at: <span className="mono">{check.seen}</span>
        </p>
      )}
      {check.detail && check.detail !== check.seen && (
        <p className="muted">
          Judged: <span className="mono">{check.detail}</span>
        </p>
      )}
      {check.consequence && <p className="check-effect">{check.consequence}</p>}
    </div>
  );
}

/** The run's outcome and all its checks, for the sidebar. A placed check opens its span. */
export function EvalSummary({ run, onOpen }: { run: EvalRun; onOpen(check: EvalCheck): void }) {
  const failed = run.checks.filter((c) => !c.passed).length;
  return (
    <section className="eval">
      <h4>
        Eval
        <span className={`eval-status ${run.score !== null && run.score > 0 ? 'pass' : 'fail'}`}>
          {run.status.replace('_', ' ')}
          {run.score !== null && ` · ${Math.round(run.score * 1000) / 10}%`}
        </span>
      </h4>
      <p className="muted small" title={run.runId}>
        {run.fixtureTitle ?? run.fixtureId}
        {run.harms?.length ? ` · harm: ${run.harms.join(', ')}` : ''}
        {` · ${run.checks.length - failed} passed, ${failed} failed`}
      </p>
      {!run.fixtureKnown && (
        <p className="muted small">
          The fixture is not in this checkout: no descriptions or weights.
        </p>
      )}
      <ul className="eval-checks">
        {run.checks.map((c) => {
          const Icon = c.passed ? CircleCheck : CircleX;
          return (
            <li key={c.ruleId}>
              <Hover tip={<CheckText check={c} />} right>
                <button type="button" disabled={!c.spanId} onClick={() => onOpen(c)}>
                  <Icon size={13} className={c.passed ? 'pass' : 'fail'} aria-hidden />
                  <span className="eval-rule">{c.ruleId}</span>
                </button>
              </Hover>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
