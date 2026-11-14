import type { ProcedureListItem, Requirement } from '@sa/shared';
import {
  ArrowRight,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Hourglass,
  Landmark,
  type LucideIcon,
} from 'lucide-react';
import { Popover } from 'radix-ui';
import { memo, type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useAppStore } from '../../store/app';
import { cardState, isOver } from '../../store/procedures';
import { useVaultStore } from '../../store/vault';
import { AppointmentLinks, CardMenu, TitleEditor } from '../procedures/CardParts';
import { procedureDict } from '../procedures/i18n';
import { codemodeDict } from './i18n';
import { OutcomePill } from './OutcomePill';
import { ProcedureDetails, REQUIREMENT_ICON } from './ProcedureDetails';

export const ProcedureRow = memo(function ProcedureRow({
  procedure: p,
}: {
  procedure: ProcedureListItem;
}) {
  const hasDocuments = useVaultStore(
    (s) => s.overview?.documents.some((d) => d.procedureId === p.id) ?? false,
  );
  const hasDetails = Boolean(
    p.steps.length ||
      p.sources.length ||
      hasDocuments ||
      (p.summary && p.facts.length) ||
      (p.requirements.length && !missingOf(p).length),
  );
  const focused = useAppStore((s) =>
    s.focusedProcedure?.id === p.id ? s.focusedProcedure.tick : 0,
  );
  const t = useT(procedureDict);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLElement>(null);

  // Opening the app on a card (or receiving news while it is visible) marks it as read.
  useEffect(() => {
    if (p.runtime.unread) void api.invoke('procedures.markRead', p.id).catch(() => {});
  }, [p.id, p.runtime.unread]);

  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 1600);
    return () => window.clearTimeout(timer);
  }, [focused]);

  return (
    <article
      ref={ref}
      aria-labelledby={`card-${p.id}`}
      data-testid={`procedure-card-${p.id}`}
      data-state={cardState(p)}
      className={cn(
        // All of its text can be copied: the title, a reference number, the next step…
        'selectable @container group/card relative scroll-my-6 pt-5',
        hasDetails ? 'pb-3' : 'pb-6',
      )}
    >
      {/* Brought here from the chat or the meter: a short glow behind the card. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute -inset-x-4 inset-y-2 rounded-2xl bg-accent-soft transition-opacity duration-500',
          flash ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div className="relative">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {editing ? (
              <TitleEditor procedure={p} onDone={() => setEditing(false)} />
            ) : (
              <h2
                id={`card-${p.id}`}
                className="text-[16.5px] font-semibold leading-snug tracking-[-0.01em] text-fg"
                onDoubleClick={() => setEditing(true)}
              >
                {p.title}
              </h2>
            )}
            {p.administration ? (
              <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[12.5px] text-fg-subtle">
                <Landmark size={12} className="shrink-0" aria-hidden />
                <span className="truncate">{p.administration.name}</span>
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <OutcomePill procedure={p} />
            <CardMenu procedure={p} onRename={() => setEditing(true)} />
          </div>
        </header>

        <div className="mt-5 grid grid-cols-1 gap-x-8 gap-y-5 @min-[560px]:grid-cols-2">
          <Overview procedure={p} />
          <ActionItems procedure={p} />
        </div>

        {hasDetails ? (
          <>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                data-testid="card-details"
                className="-mr-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-muted"
              >
                {t.details}
                <ChevronDown
                  size={14}
                  className={cn('transition-transform duration-150', open && 'rotate-180')}
                  aria-hidden
                />
              </button>
            </div>
            {open ? <ProcedureDetails procedure={p} /> : null}
          </>
        ) : null}
      </div>
    </article>
  );
});
/** Requirements the user still lacks; none once the procedure was cancelled. */
function missingOf(p: ProcedureListItem) {
  if (p.status === 'cancelled') return [];
  return p.requirements.filter((r) => r.status === 'missing');
}

// ---------------------------------------------------------------------------------------------
// The procedure at a glance: its key facts (its summary when it has none yet)
// ---------------------------------------------------------------------------------------------

function Overview({ procedure: p }: { procedure: ProcedureListItem }) {
  const t = useT(procedureDict);
  if (p.facts.length) {
    return (
      <ul className="flex flex-col gap-2 text-[14px] leading-snug" data-testid="card-facts">
        {p.facts.map((f) => (
          <li key={f.label} className="flex gap-2.5">
            <span className="mt-[0.5lh] size-[5px] shrink-0 -translate-y-1/2 rounded-full bg-fg" />
            <p className="min-w-0 text-fg">
              <span className="text-fg-subtle">{f.label}:</span> {f.value}
            </p>
          </li>
        ))}
      </ul>
    );
  }
  if (p.summary) {
    return <p className="text-[14px] leading-relaxed text-fg">{p.summary}</p>;
  }
  if (isOver(p)) return <div />;
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <p className="text-[13px] text-fg-subtle">{t.researchingFacts}</p>
      {[78, 52].map((w) => (
        <div key={w} className="skeleton h-2.5" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// What needs doing: problems, the next step, what is missing. Questions are not here: they wait
// above the cards, not tied to any card.
// ---------------------------------------------------------------------------------------------

/** Missing requirements listed on the card; the rest folds into "+ N requisitos". */
const MISSING_SHOWN = 4;

function ActionItems({ procedure: p }: { procedure: ProcedureListItem }) {
  const t = useT(procedureDict);
  const tr = useT(codemodeDict);
  const over = isOver(p);
  const missing = missingOf(p);
  const next = over ? undefined : p.nextAction;
  const current = p.steps.find((s) => s.status === 'current');
  const error = p.runtime.error && p.runtime.activity !== 'working' ? p.runtime.error : undefined;
  if (!error && !next && !missing.length) return null;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="card-actions">
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl bg-st-blocked-bg px-3.5 py-2.5 text-[13.5px] leading-snug text-st-blocked-fg"
        >
          <CircleAlert size={15} className="mt-[2px] shrink-0 text-st-blocked-dot" aria-hidden />
          <span className="min-w-0">
            <span className="font-semibold">{t.error}: </span>
            {error}
          </span>
        </div>
      ) : null}
      {next ? (
        <ActionLine
          icon={next.owner === 'user' ? ArrowRight : Hourglass}
          tone={next.owner === 'user' ? 'attention' : 'muted'}
          testId="card-next"
        >
          <div className="min-w-0 flex-1">
            <p>
              <span className="font-semibold text-fg">
                {next.owner === 'user'
                  ? `${t.next}:`
                  : `${tr.row.waitingOn(p.administration?.name)}:`}
              </span>{' '}
              <span className="text-fg-muted">{next.text}</span>
            </p>
            {current?.detail ? (
              <p className="mt-1 text-[12.5px] leading-relaxed text-fg-subtle">{current.detail}</p>
            ) : null}
            {next.appointment ? (
              <AppointmentLinks
                appointment={next.appointment}
                title={p.title}
                details={next.text}
              />
            ) : null}
          </div>
        </ActionLine>
      ) : null}
      {missing.length ? <Needs procedure={p} missing={missing} /> : null}
    </div>
  );
}

const LINE_TONE = {
  attention: 'text-st-attention-dot',
  muted: 'text-fg-subtle',
} as const;

function ActionLine({
  icon: Icon,
  tone,
  testId,
  children,
}: {
  icon: LucideIcon;
  tone: keyof typeof LINE_TONE;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex items-start gap-2.5 text-[13.5px] leading-snug">
      <Icon size={15} className={cn('mt-[2px] shrink-0', LINE_TONE[tone])} aria-hidden />
      {children}
    </div>
  );
}

/** "Necesitas": what is missing, one per row; what the user has folds into the last row. */
function Needs({
  procedure: p,
  missing,
}: {
  procedure: ProcedureListItem;
  missing: Requirement[];
}) {
  const tr = useT(codemodeDict);
  const shown = missing.slice(0, MISSING_SHOWN);
  const rest = [
    ...missing.slice(MISSING_SHOWN),
    ...p.requirements.filter((r) => r.status !== 'missing'),
  ];
  return (
    <section data-testid="card-missing" aria-labelledby={`needs-${p.id}`}>
      <h3 id={`needs-${p.id}`} className="mb-2 text-[13px] font-medium text-fg-subtle">
        {tr.row.needs}
      </h3>
      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
        {shown.map((r) => (
          <li key={r.id} className="flex items-start gap-2.5 px-3.5 py-2.5">
            <CircleAlert size={16} className="mt-px shrink-0 text-st-attention-dot" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium leading-snug text-fg">{r.label}</p>
              {r.detail ? (
                <p className="mt-0.5 text-[12.5px] leading-snug text-fg-muted">{r.detail}</p>
              ) : null}
            </div>
          </li>
        ))}
        {rest.length ? (
          <li>
            <MoreRequirements items={rest} />
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/** "+ 3 requisitos": the rest of the requirements, in a popover on hover or click. */
function MoreRequirements({ items }: { items: Requirement[] }) {
  const tr = useT(codemodeDict);
  const tc = useT(common);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const hover = (next: boolean, delay: number) => (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next), delay);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          onPointerEnter={hover(true, 120)}
          onPointerLeave={hover(false, 180)}
          data-testid="card-more-requirements"
          className="group/more flex w-full items-center gap-2.5 rounded-b-xl px-3.5 py-2.5 text-left text-[13.5px] font-medium text-fg transition-colors hover:bg-surface-2 data-[state=open]:bg-surface-2"
        >
          <StackedChecks />
          {tr.row.moreRequirements(items.length)}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="left"
          align="center"
          sideOffset={10}
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={hover(true, 0)}
          onPointerLeave={hover(false, 180)}
          className="z-50 w-64 animate-pop-in rounded-xl border border-line bg-surface p-1.5 shadow-pop"
        >
          <ul className="flex flex-col">
            {items.map((r) => {
              const { icon: Icon, className } = REQUIREMENT_ICON[r.status];
              return (
                <li key={r.id} className="flex items-start gap-2.5 rounded-lg px-2.5 py-2">
                  <Icon size={16} className={cn('mt-px shrink-0', className)} aria-hidden />
                  <div className="selectable min-w-0 flex-1">
                    <p
                      className={cn(
                        'text-[13.5px] leading-snug text-fg',
                        r.status === 'not_needed' && 'text-fg-subtle line-through',
                      )}
                    >
                      {r.label}
                    </p>
                    {r.detail ? (
                      <p className="mt-0.5 text-[12px] leading-snug text-fg-muted">{r.detail}</p>
                    ) : null}
                  </div>
                  <span className="sr-only">{tc.requirement[r.status]}</span>
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Two checks, one behind the other: "and these, which you have". */
function StackedChecks() {
  return (
    <span className="relative block size-4 shrink-0" aria-hidden>
      <CircleCheck size={13} className="absolute -top-[8px] left-[1.5px] text-st-done-dot/70" />
      <CircleCheck
        size={16}
        className="absolute inset-0 rounded-full bg-surface text-st-done-dot group-hover/more:bg-surface-2 group-data-[state=open]/more:bg-surface-2"
      />
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Menu, rename
// ---------------------------------------------------------------------------------------------
