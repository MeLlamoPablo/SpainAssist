import type { Appointment, ProcedureListItem, ProcedureStep } from '@sa/shared';
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  CalendarPlus,
  Check,
  ChevronDown,
  CircleAlert,
  Ellipsis,
  Landmark,
  MapPin,
  Minus,
  Pencil,
  Trash,
  X,
} from 'lucide-react';
import { type KeyboardEvent, memo, type ReactNode, useEffect, useRef, useState } from 'react';
import { Button, IconButton } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import { Spinner } from '../../components/ui/misc';
import { useLang, useT } from '../../i18n';
import { common } from '../../i18n/common';
import { activityLabel, normalizeTool } from '../../lib/activity';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useAppStore } from '../../store/app';
import { cardState, isOver } from '../../store/procedures';
import { toast } from '../../store/toast';
import { useVaultStore } from '../../store/vault';
import { PromptCard } from '../chat/ChatItems';
import { calendarUrl, formatAppointment, mapsUrl } from './appointment';
import { Elapsed } from './Elapsed';
import { procedureDict } from './i18n';
import { ProcedureDetails } from './ProcedureDetails';
import { StatePill } from './StatePill';

export const ProcedureCard = memo(function ProcedureCard({
  procedure: p,
}: {
  procedure: ProcedureListItem;
}) {
  const t = useT(procedureDict);
  // Questions of this procedure's agent are asked right here; answers go straight to it.
  const questions = p.runtime.prompts ?? [];
  const asking = questions.length > 0;
  const hasDocuments = useVaultStore(
    (s) => s.overview?.documents.some((d) => d.procedureId === p.id) ?? false,
  );
  const hasDetails = Boolean(
    p.requirements.length || p.sources.length || (p.summary && p.facts.length) || hasDocuments,
  );
  const focused = useAppStore((s) =>
    s.focusedProcedure?.id === p.id ? s.focusedProcedure.tick : 0,
  );
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const state = cardState(p);
  const over = isOver(p);

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
      data-state={state}
      className={cn(
        '@container group/card overflow-hidden rounded-2xl border bg-surface shadow-card transition-[box-shadow,border-color] duration-300',
        asking
          ? 'border-st-attention-line ring-4 ring-st-attention-bg'
          : flash
            ? 'border-accent-line ring-4 ring-accent-soft'
            : 'border-line',
        over && !asking && 'bg-surface/80',
      )}
    >
      <header className="flex items-start gap-3 px-6 pt-5">
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
        <div className="flex shrink-0 items-center gap-1">
          <StatePill procedure={p} />
          <CardMenu procedure={p} onRename={() => setEditing(true)} />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-x-6 gap-y-4 px-6 pt-4 pb-5 @min-[600px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Facts procedure={p} />
        <div className="@min-[600px]:border-l @min-[600px]:border-line @min-[600px]:pl-6">
          <Steps procedure={p} />
        </div>
      </div>

      {asking ? (
        <div
          className="flex flex-col gap-6 border-t border-st-attention-line/70 px-6 pt-5 pb-6"
          data-testid="card-questions"
        >
          {questions.map((item) => (
            <PromptCard key={item.id} item={item} embedded />
          ))}
        </div>
      ) : null}

      <StatusStrip
        procedure={p}
        aside={
          hasDetails ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="-mr-2 flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-fg-subtle hover:bg-surface-3/70 hover:text-fg"
              data-testid="card-details"
            >
              {t.details}
              <ChevronDown
                size={14}
                className={cn('transition-transform duration-150', expanded && 'rotate-180')}
                aria-hidden
              />
            </button>
          ) : null
        }
      />
      {hasDetails && expanded ? <ProcedureDetails procedure={p} /> : null}
    </article>
  );
});

// ---------------------------------------------------------------------------------------------
// Facts (left) and steps (right)
// ---------------------------------------------------------------------------------------------

function Facts({ procedure: p }: { procedure: ProcedureListItem }) {
  const t = useT(procedureDict);
  if (!p.facts.length) {
    if (p.summary)
      return <p className="selectable text-[14px] leading-relaxed text-fg">{p.summary}</p>;
    return (
      <div className="flex flex-col gap-2.5" aria-busy="true">
        <p className="text-[13px] text-fg-subtle">{t.researchingFacts}</p>
        {[85, 60, 72].map((w) => (
          <div key={w} className="skeleton h-2.5" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2.5" data-testid="card-facts">
      {p.facts.map((f) => (
        <li key={f.label} className="flex gap-3 text-[14px] leading-snug text-fg">
          <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
          <span className="selectable min-w-0">
            <span className="text-fg-muted">{f.label}: </span>
            {f.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

function StepMarker({ status }: { status: ProcedureStep['status'] }) {
  if (status === 'done')
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-st-done-dot text-(--sa-white)">
        <Check size={12} strokeWidth={3.2} aria-hidden />
      </span>
    );
  if (status === 'current')
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-accent bg-surface">
        <span className="size-2 rounded-full bg-accent" />
      </span>
    );
  if (status === 'failed')
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-st-blocked-dot text-(--sa-white)">
        <X size={12} strokeWidth={3} aria-hidden />
      </span>
    );
  if (status === 'skipped')
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-line-strong bg-surface text-fg-faint">
        <Minus size={11} strokeWidth={3} aria-hidden />
      </span>
    );
  return (
    <span className="block size-5 shrink-0 rounded-full border-2 border-line-strong bg-surface" />
  );
}

function Steps({ procedure: p }: { procedure: ProcedureListItem }) {
  const t = useT(procedureDict);
  if (!p.steps.length) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <span className="sr-only">{t.loadingSteps}</span>
        {[78, 62, 70].map((width) => (
          <div key={width} className="flex items-center gap-3" aria-hidden="true">
            <div className="skeleton size-5 shrink-0 rounded-full" />
            <div className="skeleton h-2.5" style={{ width: `${width}%` }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <ol className="relative" data-testid="card-steps">
      {p.steps.map((step, i) => {
        const last = i === p.steps.length - 1;
        return (
          <li key={step.id} className="relative flex gap-3 pb-3 last:pb-0">
            {!last ? (
              <span
                className={cn(
                  'absolute top-6 bottom-1 left-[9.5px] w-px',
                  step.status === 'done' ? 'bg-st-done-dot/40' : 'bg-line-strong/70',
                )}
                aria-hidden
              />
            ) : null}
            <span className="relative z-[1] flex">
              <StepMarker status={step.status} />
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'text-[14px] leading-5',
                  step.status === 'current' && 'font-semibold text-fg',
                  step.status === 'done' && 'font-medium text-fg',
                  step.status === 'pending' && 'text-fg-subtle',
                  step.status === 'skipped' && 'text-fg-subtle line-through',
                  step.status === 'failed' && 'font-medium text-st-blocked-fg',
                )}
              >
                <span className="sr-only">{t.stepStatus[step.status]}: </span>
                {step.title}
              </p>
              {step.detail && step.status === 'current' ? (
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{step.detail}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------
// What is happening now: the agent working, an error, or the next action
// ---------------------------------------------------------------------------------------------

function StatusStrip({
  procedure: p,
  aside,
}: {
  procedure: ProcedureListItem;
  /** The details toggle, at the end of the row. */
  aside: ReactNode;
}) {
  const t = useT(procedureDict);
  const tc = useT(common);
  const lang = useLang();
  const credentials = useVaultStore((s) => s.overview?.credentials);

  if (p.runtime.activity === 'working') {
    const now = p.runtime.now;
    const label = now
      ? activityLabel(now.tool, now.args, {
          lang,
          credentialKind: (id) => credentials?.find((c) => c.id === id)?.kind,
        }).text
      : tc.working;
    return (
      <div
        className="flex items-center gap-2.5 border-t border-line bg-surface-2/60 px-6 py-2 text-[13px] text-fg-muted"
        data-testid="card-working"
      >
        <Spinner size={14} className="shrink-0 text-fg-subtle" />
        <span className="flex min-w-0 flex-1 gap-1.5">
          <span className="truncate">
            {now && normalizeTool(now.tool) === 'web_research' ? t.researchingStatus : label}
          </span>
          {p.runtime.workingSince ? (
            <Elapsed
              since={p.runtime.workingSince}
              className="shrink-0 text-fg-subtle tabular-nums"
            />
          ) : null}
        </span>
        {aside}
      </div>
    );
  }
  if (p.runtime.error) {
    return (
      <div
        className="flex items-start gap-2.5 border-t border-st-blocked-line bg-st-blocked-bg px-6 py-2 text-[13px] text-st-blocked-fg"
        role="alert"
      >
        <CircleAlert size={15} className="mt-px shrink-0" aria-hidden />
        <span className="min-w-0">
          <span className="font-semibold">{t.error}: </span>
          {p.runtime.error}
        </span>
        {aside}
      </div>
    );
  }
  // While it asks, the question says what is next.
  if (p.nextAction && !isOver(p) && p.runtime.activity !== 'needs_user') {
    const mine = p.nextAction.owner === 'user';
    const { appointment } = p.nextAction;
    return (
      <div className="border-t border-line px-6 py-2 text-[13px]">
        <div className="flex items-center gap-2.5">
          <ArrowRight
            size={14}
            className={cn('shrink-0', mine ? 'text-st-attention-dot' : 'text-fg-subtle')}
            aria-hidden
          />
          <span className="min-w-0 flex-1 text-fg-muted">
            <span className="font-semibold text-fg">{t.next}: </span>
            {p.nextAction.text}
          </span>
          {aside}
        </div>
        {appointment ? (
          <AppointmentLinks appointment={appointment} title={p.title} details={p.nextAction.text} />
        ) : null}
      </div>
    );
  }
  return aside ? (
    <div className="flex items-center justify-end border-t border-line px-6 py-2">{aside}</div>
  ) : null;
}

/** Where and when, each with a button that opens it in Google Maps or Google Calendar. */
function AppointmentLinks({
  appointment,
  title,
  details,
}: {
  appointment: Appointment;
  title: string;
  details: string;
}) {
  const t = useT(procedureDict);
  const lang = useLang();
  const rows = [
    { icon: MapPin, text: appointment.address, action: t.openInMaps, url: mapsUrl(appointment) },
    {
      icon: CalendarPlus,
      text: formatAppointment(appointment, lang),
      action: t.addToCalendar,
      url: calendarUrl(appointment, title, details),
    },
  ];
  return (
    <ul className="mt-2 flex flex-col gap-2" data-testid="card-appointment">
      {rows.map(({ icon: Icon, text, action, url }) => (
        <li key={action} className="flex items-start gap-2.5">
          {/* In the arrow's column. */}
          <Icon size={14} className="mt-[3px] shrink-0 text-fg-faint" aria-hidden />
          <div className="flex min-w-0 flex-col items-start gap-0.5">
            <span className="text-fg">{text}</span>
            <Button
              variant="link"
              size="sm"
              onClick={() => void api.invoke('app.openExternal', url)}
            >
              {action}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Menu, rename
// ---------------------------------------------------------------------------------------------

function CardMenu({
  procedure: p,
  onRename,
}: {
  procedure: ProcedureListItem;
  onRename: () => void;
}) {
  const t = useT(procedureDict);
  const tc = useT(common);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const archive = async (archived: boolean) => {
    try {
      await api.invoke('procedures.archive', p.id, archived);
      toast.success(archived ? t.archived : t.unarchived);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async () => {
    try {
      await api.invoke('procedures.delete', p.id);
      toast.success(t.deleted);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <IconButton icon={Ellipsis} label={t.menu} size="sm" data-testid="card-menu" />
        </MenuTrigger>
        <MenuContent>
          <MenuItem icon={Pencil} onSelect={onRename}>
            {t.rename}
          </MenuItem>
          {p.archived ? (
            <MenuItem icon={ArchiveRestore} onSelect={() => void archive(false)}>
              {t.unarchive}
            </MenuItem>
          ) : (
            <MenuItem icon={Archive} onSelect={() => void archive(true)}>
              {t.archive}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={Trash} danger onSelect={() => setConfirmDelete(true)}>
            {t.delete}
          </MenuItem>
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t.deleteTitle(p.title)}
        description={t.deleteBody}
        confirmLabel={t.deleteConfirm}
        cancelLabel={tc.cancel}
        onConfirm={remove}
      />
    </>
  );
}

function TitleEditor({
  procedure: p,
  onDone,
}: {
  procedure: ProcedureListItem;
  onDone: () => void;
}) {
  const t = useT(procedureDict);
  const [value, setValue] = useState(p.title);
  const ref = useRef<HTMLInputElement>(null);
  const saved = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const save = async () => {
    if (saved.current) return;
    saved.current = true;
    const title = value.trim();
    onDone();
    if (!title || title === p.title) return;
    try {
      await api.invoke('procedures.rename', p.id, title);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      saved.current = true;
      onDone();
    }
  };

  return (
    <input
      ref={ref}
      value={value}
      maxLength={160}
      aria-label={t.renameLabel}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={onKeyDown}
      className="-ml-1.5 h-8 w-full rounded-md border border-accent bg-surface px-1.5 text-[16px] font-semibold text-fg ring-3 ring-ring/30 outline-none"
    />
  );
}
