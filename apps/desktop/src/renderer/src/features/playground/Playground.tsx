import type { ChatItem, PromptItem } from '@sa/shared';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/field';
import { useLang, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { putPlaygroundItem, setPlaygroundCodemode } from '../../mock/mock-api';
import { useChatStore } from '../../store/chat';
import { useCodemodeStore } from '../../store/codemode';
import { useProcedureStore } from '../../store/procedures';
import { ActivityFailure, AssistantMessage, NoticeRow, ProcedureEventRow } from '../chat/ChatItems';
import { buildResponse } from '../chat/prompts/formLogic';
import { AgentMeter } from '../codemode/AgentMeter';
import { ForYouItem } from '../codemode/ForYou';
import { ProcedureRow } from '../codemode/ProcedureRow';
import {
  appointmentExample,
  type ExampleGroup,
  type PlaygroundExample,
  playgroundExamples,
} from './examples';
import { playgroundDict } from './i18n';
import { WorkflowExample } from './WorkflowExample';

const GROUPS: ExampleGroup[] = [
  'interfaces',
  'approvals',
  'actions',
  'dnie',
  'procedures',
  'agents',
  'chat',
];
type State = 'current' | 'answered' | 'cancelled' | 'negative' | 'dismissed';

/** Synthetic states show the real component's summary, with secret values always masked. */
function previewPrompt(item: PromptItem, state: State): PromptItem {
  if (state === 'current') return item;
  if (state === 'cancelled') return { ...item, status: 'cancelled', response: undefined };
  const prompt = item.prompt;
  const negative = state === 'negative';
  if (prompt.kind === 'confirm')
    return { ...item, status: 'answered', response: { kind: 'confirm', approved: !negative } };
  if (prompt.kind === 'user_action')
    return {
      ...item,
      status: 'answered',
      response: { kind: 'user_action', done: !negative, note: negative ? 'Demo' : undefined },
    };
  if (prompt.kind === 'credential')
    return {
      ...item,
      status: 'answered',
      response: { kind: 'credential', credentialId: negative ? undefined : 'cred-demo' },
    };
  if (prompt.kind === 'phone_call')
    return {
      ...item,
      status: 'answered',
      response: negative
        ? { kind: 'phone_call', outcome: 'unreachable', notes: 'Demo' }
        : { kind: 'phone_call', outcome: 'done', transcript: 'Demo' },
    };
  if (prompt.kind === 'dnie_signature')
    return {
      ...item,
      status: 'answered',
      response: { kind: 'dnie_signature', outcome: negative ? 'failed' : 'signed' },
    };
  if (state === 'dismissed')
    return {
      ...item,
      status: 'answered',
      response: { kind: 'form', dismissed: true, savedToVault: [] },
    };
  // The one form codemode still raises: page.fillFromUser's secret.
  const fields = prompt.kind === 'form' ? prompt.fields : [];
  const values = Object.fromEntries(fields.map((f) => [f.key, '••••']));
  return { ...item, status: 'answered', response: buildResponse(fields, values) };
}

function redactedItem(item?: ChatItem) {
  if (item?.type !== 'prompt' || item.prompt.kind !== 'form' || item.response?.kind !== 'form')
    return item;
  const values = { ...item.response.values };
  for (const field of item.prompt.fields)
    if (field.type === 'secret' && values[field.key]) values[field.key] = '••••';
  return { ...item, response: { ...item.response, values } };
}

export function Playground() {
  const t = useT(playgroundDict);
  const mainRef = useRef<HTMLElement>(null);
  const lang = useLang();
  const examples = useMemo(() => playgroundExamples(lang), [lang]);
  const [selectedId, setSelectedId] = useState(
    () => new URLSearchParams(location.search).get('example') ?? examples[0]?.id ?? '',
  );
  const [search, setSearch] = useState('');
  const [version, setVersion] = useState(0);
  const selected = examples.find((e) => e.id === selectedId) ?? (examples[0] as PlaygroundExample);

  const choose = (id: string) => {
    mainRef.current?.scrollTo({ top: 0 });
    setSelectedId(id);
    const url = new URL(location.href);
    url.searchParams.set('example', id);
    history.replaceState(null, '', url);
  };
  const reload = (language = lang, example = selected.id) => {
    const url = new URL(location.href);
    url.searchParams.set('lang', language);
    url.searchParams.set('example', example);
    location.href = url.toString();
  };
  const reset = () => {
    // This page is only mounted against the in-memory API, whose conversation owns these items.
    if (selected.item?.type === 'prompt') putPlaygroundItem(selected.item);
    setVersion((n) => n + 1);
  };
  const filtered = examples.filter((e) =>
    `${e.label} ${e.code}`.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="flex h-dvh flex-col bg-surface text-fg" data-testid="agent-playground">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t.title}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            aria-label={t.language}
            value={lang}
            onChange={(e) => reload(e.target.value === 'en' ? 'en' : 'es')}
            className="w-28"
          >
            <option value="es">Español</option>
            <option value="en">English</option>
          </Select>
          <Button variant="ghost" icon={RotateCcw} onClick={() => reload(lang, examples[0]?.id)}>
            {t.resetAll}
          </Button>
          <Button
            variant="ghost"
            icon={ArrowLeft}
            onClick={() => {
              const url = new URL(location.href);
              url.searchParams.delete('playground');
              url.searchParams.delete('example');
              url.searchParams.set('freeze', '1');
              location.href = url.toString();
            }}
          >
            {t.back}
          </Button>
        </div>
      </header>
      <p className="border-b border-line bg-accent-soft px-6 py-2 text-xs text-accent-text">
        {t.mock}
      </p>
      <div className="grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)] max-sm:grid-cols-[160px_minmax(0,1fr)]">
        <nav
          aria-label={t.title}
          className="overflow-y-auto border-r border-line bg-surface-2/50 p-3"
        >
          <Input
            aria-label={t.search}
            placeholder={t.search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mb-4"
          />
          {GROUPS.map((group) => {
            const items = filtered.filter((e) => e.group === group);
            if (!items.length) return null;
            return (
              <div key={group} className="mb-5">
                <h2 className="mb-2 px-2 text-xs font-semibold text-fg-subtle">
                  {t.groups[group]}
                </h2>
                {items.map((example) => (
                  <button
                    key={example.id}
                    type="button"
                    aria-current={selected.id === example.id ? 'page' : undefined}
                    onClick={() => choose(example.id)}
                    className={cn(
                      'mb-0.5 flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-surface-3',
                      selected.id === example.id && 'bg-accent-soft text-accent-text',
                    )}
                  >
                    <span>{example.label}</span>
                    <code className="text-[10px] break-words text-fg-subtle">{example.code}</code>
                  </button>
                ))}
              </div>
            );
          })}
          {!filtered.length && <p className="text-sm text-fg-muted">{t.empty}</p>}
        </nav>
        <main ref={mainRef} className="@container overflow-y-auto p-6 sm:p-8">
          <div
            className={cn(
              'mx-auto space-y-6',
              selected.group === 'interfaces' ? 'max-w-[1280px]' : 'max-w-[900px]',
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{selected.label}</h2>
                <code className="text-xs text-fg-subtle">{selected.code}</code>
              </div>
              <Button size="sm" icon={RotateCcw} onClick={reset}>
                {t.reset}
              </Button>
            </div>
            <ExampleView key={`${selected.id}-${version}`} example={selected} />
          </div>
        </main>
      </div>
    </div>
  );
}

function ExampleView({ example }: { example: PlaygroundExample }) {
  if (example.source !== undefined) return <WorkflowExample example={example} />;
  if (example.item?.type === 'prompt') return <PromptExample item={example.item} />;
  if (example.procedureId) return <ProcedureExample example={example} />;
  if (example.agents) return <AgentsExample example={example} />;
  return <ChatExample example={example} />;
}

/** A host-owned question, in its "Para ti" box. */
function PromptExample({ item: original }: { item: PromptItem }) {
  const t = useT(playgroundDict);
  const [state, setState] = useState<State>('current');
  const conversation = useChatStore((s) => s.conversation.items);
  const live = conversation.find((i) => i.id === original.id);
  const item = previewPrompt(live?.type === 'prompt' ? live : original, state);
  return (
    <>
      <Controls>
        <label htmlFor="playground-state" className="space-y-1 text-xs text-fg-muted">
          <span>{t.state}</span>
          <Select
            id="playground-state"
            aria-label={t.state}
            value={state}
            onChange={(e) => setState(e.target.value as State)}
          >
            <option value="current">{t.current}</option>
            <option value="answered">{t.answered}</option>
            <option value="cancelled">{t.cancelled}</option>
            {item.prompt.kind === 'form' ? (
              <option value="dismissed">{t.dismissed}</option>
            ) : (
              <option value="negative">{t.negative}</option>
            )}
          </Select>
        </label>
      </Controls>
      <Preview>
        <ForYouItem entry={{ kind: 'prompt', id: item.id, at: item.createdAt, item }} />
      </Preview>
      {item.response && (
        <div>
          <h3 className="mb-2 text-xs font-semibold text-fg-muted">{t.response}</h3>
          <pre className="overflow-x-auto rounded-xl border border-line bg-surface-2 p-4 text-xs">
            {JSON.stringify((redactedItem(item) as PromptItem).response, null, 2)}
          </pre>
        </div>
      )}
      <Payload value={redactedItem(item)} />
    </>
  );
}

const PROCEDURE_STATES = [
  'current',
  'researching',
  'planned',
  'in_progress',
  'working',
  'appointment',
  'waiting_admin',
  'error',
  'done',
  'blocked',
  'cancelled',
];

/** A procedure's row in "Mis trámites", in each state. */
function ProcedureExample({ example }: { example: PlaygroundExample }) {
  const t = useT(playgroundDict);
  const lang = useLang();
  const [state, setState] = useState(example.procedureState ?? 'current');
  const procedure = useProcedureStore((s) =>
    example.procedureId ? s.byId[example.procedureId] : undefined,
  );
  if (!procedure) return null;
  const rendered =
    state === 'current'
      ? procedure
      : {
          ...procedure,
          status: ['working', 'error', 'appointment'].includes(state)
            ? ('in_progress' as const)
            : (state as typeof procedure.status),
          nextAction:
            state === 'appointment'
              ? appointmentExample((es, en) => (lang === 'es' ? es : en))
              : undefined,
          runtime: {
            ...procedure.runtime,
            activity: state === 'working' ? ('working' as const) : ('idle' as const),
            prompts: [],
            error: state === 'error' ? 'Demo' : undefined,
            unread: false,
          },
        };
  return (
    <>
      <Controls>
        <Select aria-label={t.state} value={state} onChange={(e) => setState(e.target.value)}>
          {PROCEDURE_STATES.map((s) => (
            <option key={s} value={s}>
              {s === 'current' ? t.current : s}
            </option>
          ))}
        </Select>
      </Controls>
      <Preview>
        <div className="rounded-2xl border border-line bg-surface px-6">
          <ProcedureRow procedure={rendered} />
        </div>
      </Preview>
      <Payload value={rendered} />
    </>
  );
}

/** The meter with example agents; stopping one sets it idle. */
function AgentsExample({ example }: { example: PlaygroundExample }) {
  useEffect(() => {
    const store = useCodemodeStore.getState();
    // Working for a few seconds, whenever the page opens.
    const since = new Date(Date.now() - 42_000).toISOString();
    const agents = (example.agents ?? []).map((a) => (a.since ? { ...a, since } : a));
    store.setAll({ agents, workflows: [] });
    setPlaygroundCodemode({
      uiEvent: () => false,
      uiFailed: () => false,
      stopAgent: (agentId) => {
        const agent = useCodemodeStore.getState().agents[agentId];
        if (agent) useCodemodeStore.getState().upsertAgent({ ...agent, activity: 'idle' });
      },
    });
    return () => {
      setPlaygroundCodemode(undefined);
      useCodemodeStore.getState().setAll({ agents: [], workflows: [] });
    };
  }, [example.agents]);
  return (
    <>
      <Preview>
        <div className="rounded-2xl bg-surface-2/60 px-8 pt-2">
          <AgentMeter />
        </div>
      </Preview>
      <Payload value={example.agents} />
    </>
  );
}

/** The assistant's chat: what the coordinator says and does. */
function ChatExample({ example }: { example: PlaygroundExample }) {
  const t = useT(playgroundDict);
  const [messageState, setMessageState] = useState<'complete' | 'streaming' | 'error' | 'aborted'>(
    'complete',
  );
  let item = example.item;
  if (item?.type === 'assistant') item = { ...item, status: messageState };
  return (
    <>
      {item?.type === 'assistant' ? (
        <Controls>
          <Select
            aria-label={t.state}
            value={messageState}
            onChange={(e) => setMessageState(e.target.value as typeof messageState)}
          >
            {['complete', 'streaming', 'error', 'aborted'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </Controls>
      ) : null}
      <Preview>
        {item?.type === 'assistant' && (
          <div className="rounded-2xl border border-line bg-surface p-6">
            <AssistantMessage item={item} />
          </div>
        )}
        {item?.type === 'notice' && <NoticeRow item={item} />}
        {item?.type === 'activity' && <ProcedureEventRow item={item} />}
        {example.id === 'failure' && <ActivityFailure />}
      </Preview>
      <Payload value={item ?? { type: example.code }} />
    </>
  );
}

function Controls({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-4 rounded-xl border border-line bg-surface p-3">
      {children}
    </div>
  );
}

function Preview({ children }: { children: ReactNode }) {
  const t = useT(playgroundDict);
  return (
    <section className="@container" aria-label={t.preview}>
      {children}
    </section>
  );
}

function Payload({ value }: { value: unknown }) {
  const t = useT(playgroundDict);
  return (
    <details className="rounded-xl border border-line bg-surface p-4">
      <summary className="cursor-pointer text-sm text-fg-muted">{t.payload}</summary>
      <pre className="mt-3 max-h-96 overflow-auto text-xs">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
