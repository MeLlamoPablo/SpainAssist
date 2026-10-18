import type { ChatItem, FormValue, PromptItem } from '@sa/shared';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/controls';
import { Input, Select } from '../../components/ui/field';
import { useLang, useT } from '../../i18n';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useChatStore } from '../../store/chat';
import { useProcedureStore } from '../../store/procedures';
import { toast } from '../../store/toast';
import { useDocuments, useVaultStore } from '../../store/vault';
import {
  ActivityFailure,
  AssistantMessage,
  NoticeRow,
  ProcedureEventRow,
  PromptCard,
} from '../chat/ChatItems';
import { buildResponse } from '../chat/prompts/formLogic';
import { ADDRESS_KEYS, homeAddress } from '../chat/prompts/mapLogic';
import { ProcedureCard } from '../procedures/ProcedureCard';
import { appointmentExample, type ExampleGroup, playgroundExamples } from './examples';
import { playgroundDict } from './i18n';

const GROUPS: ExampleGroup[] = ['inputs', 'confirmations', 'actions', 'output'];
type State = 'current' | 'answered' | 'cancelled' | 'negative' | 'dismissed';

/** Synthetic states show the real component's summary, with secret values always masked. */
function previewPrompt(item: PromptItem, state: State, documentId: string): PromptItem {
  if (state === 'current') return item;
  if (state === 'cancelled') return { ...item, status: 'cancelled', response: undefined };
  const prompt = item.prompt;
  if (prompt.kind === 'confirm')
    return {
      ...item,
      status: 'answered',
      response: { kind: 'confirm', approved: state !== 'negative' },
    };
  if (prompt.kind === 'user_action')
    return {
      ...item,
      status: 'answered',
      response: {
        kind: 'user_action',
        done: state !== 'negative',
        note: state === 'negative' ? 'Demo' : undefined,
      },
    };
  if (prompt.kind === 'credential')
    return {
      ...item,
      status: 'answered',
      response: {
        kind: 'credential',
        credentialId: state !== 'negative' ? 'cred-demo' : undefined,
      },
    };
  if (prompt.kind === 'phone_call')
    return {
      ...item,
      status: 'answered',
      response:
        state === 'negative'
          ? { kind: 'phone_call', outcome: 'unreachable', notes: 'Demo' }
          : { kind: 'phone_call', outcome: 'done', transcript: 'Demo' },
    };
  if (prompt.kind === 'dnie_signature')
    return {
      ...item,
      status: 'answered',
      response: { kind: 'dnie_signature', outcome: state === 'negative' ? 'failed' : 'signed' },
    };
  if (state === 'dismissed')
    return {
      ...item,
      status: 'answered',
      response: { kind: 'form', dismissed: true, savedToVault: [] },
    };
  const values: Record<string, FormValue> = {};
  for (const field of prompt.fields)
    values[field.key] =
      field.defaultValue ??
      (field.type === 'boolean'
        ? true
        : field.type === 'multiselect'
          ? (field.options ?? []).slice(0, 2).map((o) => o.value)
          : field.type === 'province'
            ? 'Sevilla'
            : field.type === 'date'
              ? '2026-11-30'
              : field.type === 'number'
                ? '12.50'
                : field.type === 'phone'
                  ? '+34 600 000 000'
                  : field.type === 'email'
                    ? 'demo@example.com'
                    : field.type === 'secret'
                      ? '••••'
                      : field.type === 'document'
                        ? documentId
                        : field.type === 'appointment'
                          ? (field.slots?.[0] ?? 'Demo')
                          : (field.options?.[0]?.value ?? 'Demo'));
  return { ...item, status: 'answered', response: buildResponse(prompt.fields, values) };
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
    () => new URLSearchParams(location.search).get('example') ?? 'text',
  );
  const initialProcedureState = (id: string) =>
    examples.find((e) => e.id === id)?.procedureState ?? 'current';
  const [search, setSearch] = useState('');
  const [state, setState] = useState<State>('current');
  const [messageState, setMessageState] = useState<'complete' | 'streaming' | 'error' | 'aborted'>(
    'complete',
  );
  const [procedureState, setProcedureState] = useState(() => initialProcedureState(selectedId));
  const [embedded, setEmbedded] = useState(false);
  const [version, setVersion] = useState(0);
  const [homeBusy, setHomeBusy] = useState(false);
  const selected = examples.find((e) => e.id === selectedId) ?? examples[0];
  const conversation = useChatStore((s) => s.conversation.items);
  const documents = useDocuments();
  const personal = useVaultStore((s) => s.overview?.personal);
  const procedure = useProcedureStore((s) =>
    selected.procedureId ? s.byId[selected.procedureId] : undefined,
  );
  let item = selected.item;
  if (item?.type === 'prompt') {
    const live = conversation.find((i) => i.id === item?.id);
    item = previewPrompt(
      live?.type === 'prompt' ? live : item,
      state,
      documents[0]?.id ?? 'demo-document',
    );
  }
  if (item?.type === 'assistant') item = { ...item, status: messageState };
  const mapExample =
    item?.type === 'prompt' &&
    item.prompt.kind === 'form' &&
    item.prompt.fields.some((f) => f.type === 'map-options');
  const savedAddress = homeAddress(personal ?? []);
  const choose = (id: string) => {
    mainRef.current?.scrollTo({ top: 0 });
    setSelectedId(id);
    setState('current');
    setMessageState('complete');
    setProcedureState(initialProcedureState(id));
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
    if (selected.item?.type === 'prompt') {
      // This page is only mounted against the in-memory API, whose conversation owns these items.
      useChatStore.getState().applyItem(selected.item);
      import('../../mock/mock-api').then(({ resetPlaygroundPrompt }) =>
        resetPlaygroundPrompt(selected.item!.id),
      );
    }
    setState('current');
    setMessageState('complete');
    setProcedureState(initialProcedureState(selected.id));
    setVersion((n) => n + 1);
  };
  const setAddress = async (enabled: boolean) => {
    setHomeBusy(true);
    try {
      const overview = enabled
        ? await api.invoke('vault.setPersonal', [
            { key: 'addressStreet', value: 'Calle de ejemplo 10' },
            { key: 'addressMunicipality', value: 'Sevilla' },
            { key: 'addressCountry', value: 'España' },
          ])
        : await api.invoke('vault.deletePersonal', [...ADDRESS_KEYS]);
      useVaultStore.getState().set(overview);
      setVersion((n) => n + 1);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setHomeBusy(false);
    }
  };
  const filtered = examples.filter((e) =>
    `${e.label} ${e.code}`.toLowerCase().includes(search.toLowerCase()),
  );
  const renderedProcedure =
    procedure && procedureState !== 'current'
      ? {
          ...procedure,
          status: ['working', 'needs_user', 'error', 'appointment'].includes(procedureState)
            ? ('in_progress' as const)
            : (procedureState as typeof procedure.status),
          nextAction:
            procedureState === 'appointment'
              ? appointmentExample((es, en) => (lang === 'es' ? es : en))
              : undefined,
          runtime: {
            ...procedure.runtime,
            activity:
              procedureState === 'working'
                ? ('working' as const)
                : procedureState === 'needs_user'
                  ? ('needs_user' as const)
                  : ('idle' as const),
            prompts: procedureState === 'needs_user' ? procedure.runtime.prompts : [],
            error: procedureState === 'error' ? 'Demo' : undefined,
            now:
              procedureState === 'working'
                ? { tool: 'web_research', args: { mode: 'balanced' } }
                : undefined,
            unread: false,
          },
        }
      : procedure;

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
          <Button variant="ghost" icon={RotateCcw} onClick={() => reload(lang, 'text')}>
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
      <div className="grid min-h-0 flex-1 grid-cols-[230px_minmax(0,1fr)] max-sm:grid-cols-[160px_minmax(0,1fr)]">
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
          {GROUPS.map((group) => (
            <div key={group} className="mb-5">
              <h2 className="mb-2 px-2 text-xs font-semibold text-fg-subtle">{t.groups[group]}</h2>
              {filtered
                .filter((e) => e.group === group)
                .map((example) => (
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
                    <code className="text-[10px] text-fg-subtle">{example.code}</code>
                  </button>
                ))}
            </div>
          ))}
          {!filtered.length && <p className="text-sm text-fg-muted">{t.empty}</p>}
        </nav>
        <main ref={mainRef} className="overflow-y-auto p-6 sm:p-8">
          <div className="mx-auto max-w-[900px] space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">{selected.label}</h2>
              <Button size="sm" icon={RotateCcw} onClick={reset}>
                {t.reset}
              </Button>
            </div>
            <div className="flex flex-wrap items-end gap-4 rounded-xl border border-line bg-surface p-3">
              {item?.type === 'prompt' && (
                <>
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
                  <label
                    htmlFor="playground-presentation"
                    className="space-y-1 text-xs text-fg-muted"
                  >
                    <span>{t.presentation}</span>
                    <Select
                      id="playground-presentation"
                      aria-label={t.presentation}
                      value={embedded ? 'embedded' : 'card'}
                      onChange={(e) => setEmbedded(e.target.value === 'embedded')}
                    >
                      <option value="card">{t.card}</option>
                      <option value="embedded">{t.embedded}</option>
                    </Select>
                  </label>
                </>
              )}
              {item?.type === 'assistant' && (
                <Select
                  aria-label={t.state}
                  value={messageState}
                  onChange={(e) => setMessageState(e.target.value as typeof messageState)}
                >
                  {['complete', 'streaming', 'error', 'aborted'].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </Select>
              )}
              {procedure && (
                <Select
                  aria-label={t.state}
                  value={procedureState}
                  onChange={(e) => setProcedureState(e.target.value)}
                >
                  {[
                    'current',
                    'researching',
                    'planned',
                    'in_progress',
                    'waiting_admin',
                    'done',
                    'blocked',
                    'cancelled',
                    'working',
                    'needs_user',
                    'error',
                    'appointment',
                  ].map((s) => (
                    <option key={s} value={s}>
                      {s === 'current' ? t.current : s}
                    </option>
                  ))}
                </Select>
              )}
              {mapExample && (
                <Checkbox
                  label={t.home}
                  checked={Boolean(savedAddress)}
                  disabled={homeBusy}
                  onCheckedChange={(v) => void setAddress(v)}
                />
              )}
              {!item || item.type === 'notice' || item.type === 'activity' ? (
                <span className="text-xs text-fg-subtle">{selected.code}</span>
              ) : null}
            </div>
            <section
              className="@container"
              aria-label={t.preview}
              key={`${selected.id}-${version}`}
            >
              {item?.type === 'prompt' && (
                <div className={cn(embedded && 'rounded-2xl border border-line bg-surface p-6')}>
                  <PromptCard
                    item={
                      item.prompt.kind === 'user_action' ? { ...item, procedureId: 'p-dni' } : item
                    }
                    embedded={embedded}
                  />
                </div>
              )}
              {item?.type === 'assistant' && (
                <div className="rounded-2xl border border-line bg-surface p-6">
                  <AssistantMessage item={item} />
                </div>
              )}
              {item?.type === 'notice' && <NoticeRow item={item} />}
              {item?.type === 'activity' && <ProcedureEventRow item={item} />}
              {selected.id === 'failure' && <ActivityFailure />}
              {renderedProcedure && <ProcedureCard procedure={renderedProcedure} />}
            </section>
            {item?.type === 'prompt' && item.response && (
              <div>
                <h3 className="mb-2 text-xs font-semibold text-fg-muted">{t.response}</h3>
                <pre className="overflow-x-auto rounded-xl border border-line bg-surface-2 p-4 text-xs">
                  {JSON.stringify((redactedItem(item) as PromptItem).response, null, 2)}
                </pre>
              </div>
            )}
            <details className="rounded-xl border border-line bg-surface p-4">
              <summary className="cursor-pointer text-sm text-fg-muted">{t.payload}</summary>
              <pre className="mt-3 max-h-96 overflow-auto text-xs">
                {JSON.stringify(
                  redactedItem(item) ?? renderedProcedure ?? { type: selected.code },
                  null,
                  2,
                )}
              </pre>
            </details>
          </div>
        </main>
      </div>
    </div>
  );
}
