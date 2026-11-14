import type { ProcedureListItem } from '@sa/shared';
import { Archive } from 'lucide-react';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ErrorBoundary, Unshowable } from '../../components/ErrorBoundary';
import { Skeleton } from '../../components/ui/misc';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/app';
import { orderProcedures, useProcedureStore } from '../../store/procedures';
import { EmptyProcedures } from '../procedures/EmptyProcedures';
import { procedureDict } from '../procedures/i18n';
import { AgentMeter } from './AgentMeter';
import { ForYou } from './ForYou';
import { ProcedureRow } from './ProcedureRow';

/**
 * "Mis trámites" (docs/codemode.md, "UI redesign"): questions above a list of procedure rows, the
 * agent meter floating at the bottom.
 */
export function ProceduresView() {
  const t = useT(procedureDict);
  const loaded = useProcedureStore((s) => s.loaded);
  const procedures = useProcedureStore(useShallow((s) => Object.values(s.byId)));
  const { active, archived } = useMemo(() => orderProcedures(procedures), [procedures]);
  const showArchived = useAppStore((s) => s.showArchived);
  const setShowArchived = useAppStore((s) => s.setShowArchived);

  if (!loaded) {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-6 px-10 pt-8">
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    );
  }
  if (!active.length && !archived.length) {
    // A workflow can ask, and agents work, before any procedure exists.
    return (
      <>
        <div className="mx-auto w-full max-w-[1040px] px-10 empty:hidden">
          <ForYou />
        </div>
        <EmptyProcedures />
        <div className="mx-auto w-full max-w-[1040px] px-10 empty:hidden">
          <SafeAgentMeter />
        </div>
      </>
    );
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1040px] flex-col px-10 pt-2">
      <h1 className="sr-only">{t.title}</h1>
      <ForYou />
      <div className="flex flex-col divide-y divide-line">
        {active.map((p) => (
          <SafeProcedureRow key={p.id} procedure={p} />
        ))}
      </div>
      {archived.length ? (
        <div className="flex flex-col border-t border-line pt-4">
          <button
            type="button"
            onClick={() => setShowArchived(!showArchived)}
            aria-expanded={showArchived}
            className="-ml-2.5 flex h-8 items-center gap-2 self-start rounded-lg px-2.5 text-[12.5px] font-medium text-fg-subtle hover:bg-surface-2 hover:text-fg-muted"
          >
            <Archive size={14} aria-hidden />
            {showArchived ? t.hideArchived : t.showArchived(archived.length)}
          </button>
          {showArchived ? (
            <div className="flex flex-col divide-y divide-line">
              {archived.map((p) => (
                <SafeProcedureRow key={p.id} procedure={p} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {/* Pushes the meter to the bottom of the pane when the list is short. */}
      <div className="min-h-12 flex-1" />
      <SafeAgentMeter />
    </div>
  );
}

/** A row agents write: if it cannot be shown, the rest of the list still is. */
function SafeProcedureRow({ procedure }: { procedure: ProcedureListItem }) {
  return (
    <ErrorBoundary
      resetKeys={[procedure]}
      fallback={
        <div className="py-5">
          <Unshowable what="procedure" />
        </div>
      }
    >
      <ProcedureRow procedure={procedure} />
    </ErrorBoundary>
  );
}

/** What agents are doing is a hint: if it cannot be shown, it is left out. */
function SafeAgentMeter() {
  return (
    <ErrorBoundary fallback={null}>
      <AgentMeter />
    </ErrorBoundary>
  );
}
