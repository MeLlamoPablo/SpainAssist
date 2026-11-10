import type { CodemodeAgentInfo, CredentialKind, ProcedureListItem } from '@sa/shared';
import { ChevronDown, CircleAlert, Hand, LoaderCircle, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Tooltip } from '../../components/ui/tooltip';
import { useLang, useT } from '../../i18n';
import { activityLabel, normalizeTool } from '../../lib/activity';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useCodemodeStore } from '../../store/codemode';
import { useProcedureStore } from '../../store/procedures';
import { toast } from '../../store/toast';
import { useVaultStore } from '../../store/vault';
import { Elapsed } from '../procedures/Elapsed';
import { codemodeDict } from './i18n';

/** One row of the meter: what is being done. */
interface Work {
  id: string;
  /** Codemode: the agent's status ("Analizando la página de Correos…"), the row's only text; classic: the card's title. */
  title: string;
  /** Classic: the current tool call. */
  now?: string;
  /** When the current stretch of work started (ISO), for the timer. */
  since?: string | undefined;
  /** It waits for the user (a question or an interface): no spinner, no timer. */
  waiting?: boolean;
  error?: string | undefined;
  stop?: () => Promise<void>;
}

/** Rows the meter shows before "Ver N más". */
const ROWS = 3;

/**
 * What the agents are doing, apart from the procedure cards: a small panel floating at the bottom
 * of "Mis trámites", one row per piece of work ("Renovar el DNI · Leyendo sede.policia.gob.es"),
 * each with a stop button: codemode's agents, then any procedure whose
 * classic agent still works (one started before the flag was on). Codemode only: the classic
 * design shows work on each card. Hidden when nothing works.
 */
export function AgentMeter() {
  const t = useT(codemodeDict);
  const lang = useLang();
  const agents = useCodemodeStore((s) => s.agents);
  const working = useProcedureStore(
    useShallow((s) =>
      Object.values(s.byId).filter((p) => p.runtime.activity === 'working' || p.runtime.error),
    ),
  );
  const credentials = useVaultStore((s) => s.overview?.credentials);
  const [all, setAll] = useState(false);

  const work = useMemo<Work[]>(
    () => [
      ...codemodeWork(Object.values(agents)),
      ...working.map((p) =>
        classicWork(
          p,
          lang,
          (id) => credentials?.find((c) => c.id === id)?.kind,
          t.meter.researching,
        ),
      ),
    ],
    [agents, working, lang, credentials, t.meter.researching],
  );

  if (!work.length) return null;
  const shown = all || work.length <= ROWS + 1 ? work : work.slice(0, ROWS);
  return (
    <div className="sticky bottom-6 z-20 -mx-4 mt-6 mb-6" data-testid="agent-meter">
      <section
        aria-label={t.meter.label}
        className="animate-slide-up rounded-2xl border border-line bg-surface px-1.5 py-1.5 shadow-raised"
      >
        <ul className="flex flex-col" data-testid="agent-meter-list">
          {shown.map((w) => (
            <WorkRow key={w.id} work={w} />
          ))}
        </ul>
        {work.length > shown.length || all ? (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            aria-expanded={all}
            className="ml-[42px] flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-fg-subtle hover:bg-surface-2 hover:text-fg-muted"
          >
            {all ? t.meter.less : t.meter.more(work.length - shown.length)}
            <ChevronDown
              size={13}
              className={cn('transition-transform duration-150', all && 'rotate-180')}
              aria-hidden
            />
          </button>
        ) : null}
      </section>
    </div>
  );
}

function WorkRow({ work: w }: { work: Work }) {
  const t = useT(codemodeDict);
  return (
    <li
      className={cn(
        'flex min-h-10 gap-3 rounded-xl pr-1 pl-3',
        w.error ? 'items-start' : 'items-center',
      )}
    >
      {w.error ? (
        <CircleAlert size={16} className="mt-2.5 shrink-0 text-st-blocked-dot" aria-hidden />
      ) : w.waiting ? (
        <Hand size={16} className="shrink-0 text-st-attention-dot" aria-label={t.meter.waiting} />
      ) : (
        <LoaderCircle size={16} className="shrink-0 animate-spin text-fg-subtle" aria-hidden />
      )}
      {/* An error is read in full: the title over the message, both wrapping. */}
      {w.error ? (
        <div className="min-w-0 flex-1 py-2 text-[13.5px] break-words">
          <p className="font-semibold text-fg">{w.title}</p>
          <p className="mt-0.5 text-st-blocked-fg">{w.error}</p>
        </div>
      ) : (
        <p className="min-w-0 flex-1 truncate py-2 text-[13.5px]">
          <span className="font-semibold text-fg">{w.title}</span>
          {w.now ? <span className="ml-2 text-fg-subtle">{w.now}</span> : null}
          {!w.waiting && w.since ? (
            <Elapsed since={w.since} className="ml-2 text-fg-faint tabular-nums" />
          ) : null}
        </p>
      )}
      {w.stop ? (
        <Tooltip content={t.meter.stop} side="left">
          <button
            type="button"
            aria-label={t.meter.stop}
            onClick={() => {
              void w.stop?.().catch((err) => toast.error(errorMessage(err)));
            }}
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-muted transition-colors hover:bg-line hover:text-fg"
          >
            <Square size={11} strokeWidth={2.4} aria-hidden />
          </button>
        </Tooltip>
      ) : null}
    </li>
  );
}

function codemodeWork(agents: CodemodeAgentInfo[]): Work[] {
  return agents.filter((a) => a.activity !== 'idle' || a.error).map(agentWork);
}

function agentWork(a: CodemodeAgentInfo): Work {
  return {
    id: a.id,
    title: a.status,
    since: a.activity === 'working' ? a.since : undefined,
    waiting: a.activity === 'waiting_user',
    error: a.activity === 'working' ? undefined : a.error,
    ...(a.kind === 'agent' && a.activity === 'working'
      ? { stop: () => api.invoke('codemode.stopAgent', a.id) }
      : {}),
  };
}

function classicWork(
  p: ProcedureListItem,
  lang: 'es' | 'en',
  credentialKind: (id: string) => CredentialKind | undefined,
  researching: string,
): Work {
  const now = p.runtime.now;
  const label = now
    ? normalizeTool(now.tool) === 'web_research'
      ? researching
      : activityLabel(now.tool, now.args, { lang, credentialKind }).text
    : '…';
  return {
    id: p.id,
    title: p.title,
    now: label,
    since: p.runtime.activity === 'working' ? p.runtime.workingSince : undefined,
    error: p.runtime.activity === 'working' ? undefined : p.runtime.error,
    ...(p.runtime.activity === 'working'
      ? { stop: () => api.invoke('procedures.stop', p.id) }
      : {}),
  };
}
