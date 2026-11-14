import type { WorkflowState } from '@sa/agent/workflow-run';
import type { CodemodeAgentInfo, PromptItem, WorkflowInfo } from '@sa/shared';
import { Play, RotateCcw, Square, StepForward } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '../../components/ui/button';
import { Pill, type Tone } from '../../components/ui/misc';
import { useLang, useT } from '../../i18n';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { putPlaygroundItem, setPlaygroundCodemode } from '../../mock/mock-api';
import { useChatStore } from '../../store/chat';
import { useCodemodeStore } from '../../store/codemode';
import { useVaultStore } from '../../store/vault';
import { AgentMeter } from '../codemode/AgentMeter';
import { type ForYouEntry, ForYouItem } from '../codemode/ForYou';
import { ProcedureRow } from '../codemode/ProcedureRow';
import type { PlaygroundExample } from './examples';
import { playgroundDict } from './i18n';
import {
  PlaygroundRun,
  type RunLine,
  type RunnerHost,
  type RunStatus,
  type RunView,
} from './runner';

const EMPTY: WorkflowState = { memo: {}, ui: {} };
/** The meter's row for the running workflow. */
const AGENT_ID = 'a-playground';

const STATUS_TONE: Record<RunStatus, Tone> = {
  running: 'research',
  waiting_user: 'attention',
  succeeded: 'done',
  failed: 'blocked',
  cancelled: 'neutral',
};

const LINE_CLASS: Record<RunLine['kind'], string> = {
  call: 'text-fg',
  event: 'text-accent-text',
  state: 'text-fg-subtle',
  log: 'text-fg-muted',
  error: 'text-danger',
};

/** A question of the workflow's (`api.user.*`) in the conversation, answered on its card. */
const ask: RunnerHost['ask'] = (item, onAnswer) => {
  let done = false;
  const unsubscribe = useChatStore.subscribe((s) => {
    const live = s.conversation.items.find((i) => i.id === item.id);
    if (done || live?.type !== 'prompt' || live.status === 'pending') return;
    done = true;
    unsubscribe();
    onAnswer(live);
  });
  putPlaygroundItem(item);
  return () => {
    if (done) return;
    done = true;
    unsubscribe();
    putPlaygroundItem({ ...item, status: 'cancelled' });
  };
};

/**
 * One workflow, run by the real kernel: what the user sees ("Para ti" and the agent meter) beside
 * its source, which can be edited and run again, from scratch or resumed from its durable state.
 */
export function WorkflowExample({ example }: { example: PlaygroundExample }) {
  const t = useT(playgroundDict);
  const lang = useLang();
  const original = example.source ?? '';
  const [source, setSource] = useState(original);
  const [view, setView] = useState<RunView | null>(null);
  const run = useRef<PlaygroundRun | null>(null);
  const count = useRef(0);

  const launch = useCallback(
    (code: string, state: WorkflowState, resumed?: RunView) => {
      run.current?.stop('Replaced by a new run');
      const next = new PlaygroundRun(`${example.id}-${++count.current}`, code, state, {
        lang,
        ask,
        saveAnswers: async (answers) =>
          useVaultStore.getState().set(await api.invoke('vault.setPersonal', answers)),
        ...(resumed ? { history: resumed.lines, procedures: resumed.procedures } : {}),
        onChange: (v) => {
          if (run.current === next) setView(v);
        },
      });
      run.current = next;
      setView(null);
      next.start();
    },
    [example.id, lang],
  );

  useEffect(() => {
    launch(original, EMPTY);
    return () => {
      run.current?.stop();
      run.current = null;
    };
  }, [launch, original]);

  // The interfaces' events reach this run (UiRenderer → mock API → here).
  useEffect(() => {
    setPlaygroundCodemode({
      uiEvent: (workflowId, key, event) =>
        run.current?.workflowId === workflowId ? run.current.uiEvent(key, event) : false,
      uiFailed: (workflowId, key, rev, detail) =>
        run.current?.workflowId === workflowId ? run.current.uiFailed(key, rev, detail) : false,
      stopAgent: () => run.current?.stop('Stopped from the meter'),
    });
    return () => setPlaygroundCodemode(undefined);
  }, []);

  // The meter shows the run as the app shows its agent.
  useEffect(() => {
    const now = new Date().toISOString();
    const agent: CodemodeAgentInfo = {
      id: AGENT_ID,
      kind: 'agent',
      status: view?.agentStatus ?? example.label,
      activity:
        view?.status === 'running' || !view
          ? 'working'
          : view.status === 'waiting_user'
            ? 'waiting_user'
            : 'idle',
      ...(view?.since ? { since: view.since } : {}),
      procedures: [],
      createdAt: now,
      updatedAt: now,
    };
    useCodemodeStore.getState().setAll({ agents: [agent], workflows: [] });
  }, [view, example.label]);
  useEffect(() => () => useCodemodeStore.getState().setAll({ agents: [], workflows: [] }), []);

  const edited = source !== original;
  const runAgain = () => launch(source, EMPTY);
  const resume = () => view && launch(source, view.state, view);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runAgain();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: start, selectionEnd: end } = el;
      setSource(`${source.slice(0, start)}  ${source.slice(end)}`);
      requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
    }
  };

  return (
    <div className="grid grid-cols-1 items-start gap-6 @min-[920px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section aria-label={t.user} className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold text-fg-muted">{t.user}</h3>
        <UserView view={view} />
      </section>
      <section aria-label={t.source} className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto flex items-center gap-2 text-xs font-semibold text-fg-muted">
            {t.source}
            {edited ? <span className="font-normal text-fg-subtle">· {t.edited}</span> : null}
          </h3>
          {view ? (
            <Pill tone={STATUS_TONE[view.status]} dot size="sm" className="ring-transparent">
              {t.status[view.status]}
            </Pill>
          ) : null}
        </div>
        <textarea
          aria-label={t.source}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          rows={22}
          className="selectable w-full resize-y rounded-xl border border-line bg-surface-2 p-3 font-mono text-[12px] leading-5 text-fg outline-none focus:border-accent"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" icon={Play} onClick={runAgain} title={t.runHint}>
            {t.run}
          </Button>
          <Button
            size="sm"
            icon={StepForward}
            onClick={resume}
            disabled={!view}
            title={t.resumeHint}
          >
            {t.resume}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={Square}
            onClick={() => run.current?.stop()}
            disabled={!view || ['succeeded', 'failed', 'cancelled'].includes(view.status)}
          >
            {t.stop}
          </Button>
          {edited ? (
            <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setSource(original)}>
              {t.restore}
            </Button>
          ) : null}
        </div>
        <p className="-mt-2 text-[12px] text-fg-subtle">{t.resumeHint}</p>
        {view?.result !== undefined && view.status === 'succeeded' ? (
          <Outcome label={t.result} text={pretty(view.result)} />
        ) : null}
        {view?.error && view.status !== 'succeeded' ? (
          <Outcome label={t.error} text={view.error} error />
        ) : null}
        <RunLog lines={view?.lines ?? []} title={t.log} />
        <details className="rounded-xl border border-line bg-surface p-3">
          <summary className="cursor-pointer text-xs font-semibold text-fg-muted">
            {t.durable}
          </summary>
          <pre className="selectable mt-3 max-h-80 overflow-auto text-[11.5px]">
            {JSON.stringify(view?.state ?? EMPTY, null, 2)}
          </pre>
        </details>
        <details className="rounded-xl border border-line bg-surface p-3">
          <summary className="cursor-pointer text-xs font-semibold text-fg-muted">{t.tree}</summary>
          <pre className="selectable mt-3 max-h-96 overflow-auto text-[11.5px]">
            {JSON.stringify(
              Object.fromEntries(
                (view?.ui ?? []).map((u) => [u.key, { rev: u.rev, tree: u.tree }]),
              ),
              null,
              2,
            )}
          </pre>
        </details>
      </section>
    </div>
  );
}

/** "Para ti" and the meter, as in "Mis trámites". */
function UserView({ view }: { view: RunView | null }) {
  const t = useT(playgroundDict);
  const promptIds = useMemo(() => (view?.prompts ?? []).map((p) => p.id), [view?.prompts]);
  // The questions as the conversation has them: answering one updates it there.
  const prompts = useChatStore(
    useShallow((s) =>
      s.conversation.items.filter(
        (i): i is PromptItem => i.type === 'prompt' && promptIds.includes(i.id),
      ),
    ),
  );
  const entries = useMemo<ForYouEntry[]>(() => {
    if (!view) return [];
    const workflow: WorkflowInfo = {
      id: view.workflowId,
      status: view.status,
      agentId: AGENT_ID,
      ui: view.ui,
      attached: true,
      createdAt: '',
      updatedAt: '',
    };
    const list: ForYouEntry[] = [
      ...view.ui.map(
        (ui): ForYouEntry => ({
          kind: 'ui',
          id: ui.key,
          at: ui.openedAt,
          workflow,
          ui,
        }),
      ),
      ...prompts
        .filter((item) => item.status === 'pending')
        .map((item): ForYouEntry => ({ kind: 'prompt', id: item.id, at: item.createdAt, item })),
    ];
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }, [view, prompts]);

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-surface-2/60 p-4">
      {entries.map((entry) => (
        <ForYouItem key={entry.id} entry={entry} />
      ))}
      {!entries.length ? (
        <p className="py-8 text-center text-[13px] text-fg-subtle">{t.nothingOpen}</p>
      ) : null}
      {/* What it did to the user's procedures (api.procedures), as "Mis trámites" lists them. */}
      {view?.procedures.length ? (
        <div className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface px-6">
          {view.procedures.map((p) => (
            <ProcedureRow key={p.id} procedure={p} />
          ))}
        </div>
      ) : null}
      <AgentMeter />
    </div>
  );
}

function Outcome({ label, text, error }: { label: string; text: string; error?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-xl border p-3',
        error ? 'border-st-blocked-line bg-st-blocked-bg' : 'border-st-done-line bg-st-done-bg',
      )}
    >
      <h4 className="text-xs font-semibold text-fg-muted">{label}</h4>
      <pre
        className={cn(
          'selectable mt-2 overflow-x-auto text-[11.5px] whitespace-pre-wrap',
          error && 'text-st-blocked-fg',
        )}
      >
        {text}
      </pre>
    </div>
  );
}

function RunLog({ lines, title }: { lines: RunLine[]; title: string }) {
  const ref = useRef<HTMLOListElement>(null);
  // Follows the newest line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new line
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines]);
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <h4 className="text-xs font-semibold text-fg-muted">{title}</h4>
      <ol
        ref={ref}
        className="selectable mt-2 max-h-64 overflow-auto font-mono text-[11.5px] leading-5"
      >
        {lines.map((line) => (
          <li key={line.id} className={cn('break-words', LINE_CLASS[line.kind])}>
            {line.text}
          </li>
        ))}
      </ol>
    </div>
  );
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
