import { Archive, ArrowUpRight, FileBadge, House, IdCard, type LucideIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Skeleton } from '../../components/ui/misc';
import { useT } from '../../i18n';
import { api, errorMessage } from '../../lib/api';
import { useAppStore } from '../../store/app';
import { orderProcedures, useProcedureStore } from '../../store/procedures';
import { toast } from '../../store/toast';
import { procedureDict } from './i18n';
import { ProcedureCard } from './ProcedureCard';

export function ProceduresView() {
  const t = useT(procedureDict);
  const loaded = useProcedureStore((s) => s.loaded);
  const procedures = useProcedureStore(useShallow((s) => Object.values(s.byId)));
  const { active, archived } = useMemo(() => orderProcedures(procedures), [procedures]);
  const showArchived = useAppStore((s) => s.showArchived);
  const setShowArchived = useAppStore((s) => s.setShowArchived);

  if (!loaded) {
    return (
      <div className="flex flex-col gap-4 px-8 pt-2">
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }
  if (!active.length && !archived.length) return <EmptyProcedures />;

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-4 px-8 pt-2 pb-12">
      <h1 className="sr-only">{t.title}</h1>
      {active.map((p) => (
        <ProcedureCard key={p.id} procedure={p} />
      ))}
      {archived.length ? (
        <div className="flex flex-col gap-4">
          <button
            type="button"
            onClick={() => setShowArchived(!showArchived)}
            aria-expanded={showArchived}
            className="flex h-8 items-center gap-2 self-start rounded-lg px-2.5 text-[12.5px] font-medium text-fg-subtle hover:bg-surface-3/70 hover:text-fg-muted"
          >
            <Archive size={14} aria-hidden />
            {showArchived ? t.hideArchived : t.showArchived(archived.length)}
          </button>
          {showArchived ? archived.map((p) => <ProcedureCard key={p.id} procedure={p} />) : null}
        </div>
      ) : null}
    </div>
  );
}

const SUGGESTION_ICONS: LucideIcon[] = [IdCard, House, FileBadge];

/** No procedures yet: a quiet preview and a few ways to start. */
function EmptyProcedures() {
  const t = useT(procedureDict);
  const configured = useAppStore((s) => Boolean(s.provider?.configured));
  const focusComposer = useAppStore((s) => s.focusComposer);

  const start = async (message: string) => {
    if (!configured) {
      focusComposer(message);
      return;
    }
    try {
      await api.invoke('chat.send', { text: message });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div
      className="flex min-h-full flex-col items-center justify-center px-8 pt-4 pb-30"
      data-testid="procedures-empty"
    >
      <GhostCards />
      <h1 className="sr-only">{t.title}</h1>
      <p className="mt-14 text-[12.5px] font-medium text-fg-subtle">{t.empty.try}</p>
      <div className="mt-2.5 flex max-w-[640px] flex-wrap justify-center gap-2">
        {t.empty.suggestions.map((s, i) => {
          const Icon = SUGGESTION_ICONS[i] ?? IdCard;
          return (
            <button
              key={s.label}
              type="button"
              onClick={() => void start(s.message)}
              className="group inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-[13.5px] font-medium text-fg-muted shadow-xs transition-colors duration-150 hover:border-accent-line hover:bg-accent-soft hover:text-accent-text"
            >
              <Icon size={15} aria-hidden className="text-fg-subtle group-hover:text-accent-text" />
              {s.label}
              <ArrowUpRight
                size={13}
                aria-hidden
                className="text-fg-faint group-hover:text-accent-text"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A stack of blank cards hinting at what will appear here. */
function GhostCards() {
  return (
    <div className="relative h-[150px] w-[340px]" aria-hidden>
      {[
        { top: 0, rotate: '-3deg', opacity: 'opacity-50', scale: 'scale-[0.92]' },
        { top: 18, rotate: '2deg', opacity: 'opacity-75', scale: 'scale-[0.96]' },
        { top: 36, rotate: '0deg', opacity: '', scale: '' },
      ].map((card, i) => (
        <div
          key={card.top}
          className={`absolute inset-x-0 rounded-2xl border border-line bg-surface px-5 py-4 shadow-card ${card.opacity} ${card.scale}`}
          style={{ top: card.top, transform: `rotate(${card.rotate})` }}
        >
          <div className="flex items-center justify-between">
            <div className="h-2.5 w-36 rounded-full bg-surface-3" />
            <div
              className={
                i === 2
                  ? 'h-4 w-16 rounded-full bg-st-attention-bg'
                  : 'h-4 w-14 rounded-full bg-st-done-bg'
              }
            />
          </div>
          <div className="mt-4 flex gap-6">
            <div className="flex flex-1 flex-col gap-2">
              {[80, 55, 68].map((w) => (
                <div key={w} className="flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-accent/60" />
                  <div className="h-2 rounded-full bg-surface-3" style={{ width: `${w}%` }} />
                </div>
              ))}
            </div>
            <div className="flex flex-1 flex-col gap-2 border-l border-line pl-5">
              {['bg-st-done-dot', 'border-2 border-accent', 'border-2 border-line-strong'].map(
                (m) => (
                  <div key={m} className="flex items-center gap-2">
                    <span className={`size-3 shrink-0 rounded-full ${m}`} />
                    <div className="h-2 w-full rounded-full bg-surface-3" />
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
