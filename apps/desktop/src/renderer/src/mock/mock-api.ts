import {
  type ActivityItem,
  type AssistantItem,
  type ChatItem,
  COMPANION_PROTOCOL,
  type CompanionStatus,
  type ConversationState,
  type CredentialSummary,
  type DataImportStatus,
  DEFAULT_SETTINGS,
  type DocumentMeta,
  maskValue,
  normalizeVoucherCode,
  type PersonalDataItem,
  type ProcedureListItem,
  type PromptItem,
  type PromptResponse,
  type ProviderStatus,
  personalFieldDef,
  REPORT_TOOL,
  type SaApi,
  type SaArgs,
  type SaEvent,
  type SaMethod,
  type SaResult,
  type Settings,
  type UpdateStatus,
  type VaultOverview,
} from '@sa/shared';
import { examplePromptItems, phoneCallExample } from '../features/playground/examples';
import { toast } from '../store/toast';
import {
  BYOK_PROVIDERS,
  createDemoState,
  DEMO_CALL_TRANSCRIPT,
  DEMO_IDS,
  type Lang,
  type MockState,
} from './demo';
import { fakeDocumentPage, fakePage } from './images';
import {
  type AStep,
  DEMO_TOPICS,
  detectTopic,
  dniAfterForm,
  existingReply,
  genericReply,
  LAST_DOCUMENT,
  newProcedurePlan,
  type PStep,
  padronLiveScript,
  soundsLikeNeed,
} from './scripts';

/**
 * In-memory implementation of every SaApi method, with realistic Spanish demo data and small
 * script runners that simulate the assistant (one perpetual conversation: streaming replies,
 * `procedure_start`, reports) and each procedure's own agent (tool activity in its log, card
 * updates, forms asked directly in the conversation).
 *
 * Query params: ?onboarding=1|voucher|data · ?lang=en · ?provider=none|chatgpt|voucher|byok · ?empty=1 ·
 * ?freeze=1 (no live simulation at all: static screens) · ?speed=N (time multiplier) ·
 * ?latency=ms (per-call delay) · ?chatgpt=ineligible (ChatGPT login fails: free account) ·
 * ?phone=1 (the DNI card asks for a phone call) · ?dnie=1 (feature flag: DNIe with the phone on;
 * ?companion, ?dnieSaved and the playground imply it) · ?companion=waiting|away|connected (phone
 * pairing for DNIe signatures; the playground starts connected; =phone_unpaired|expired|
 * relay_refused: no pairing, the last one ended for that reason; =outdated|outdated_desktop:
 * the paired phone's app, or this one, needs an update; =stalled: the relay can't be reached,
 * "Reintentar" pairs anew) · ?dnieSaved=1|pin (a saved
 * DNIe in Mis datos; =pin with its PIN saved).
 */

type Handlers = { [M in SaMethod]: (...args: SaArgs<M>) => SaResult<M> | Promise<SaResult<M>> };

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

interface Token {
  cancelled: boolean;
}

/** A procedure's question waiting on its card, and what its agent does next. */
interface PendingAsk {
  procedureId: string;
  /** The "ask_user" / "confirm_action" activity in the procedure's log. */
  logItemId?: string;
  onAnswer?: (r: PromptResponse) => PStep[];
}

let resetPrompt: ((id: string) => void) | undefined;
/** Preview-only reset; never exists on the real IPC API. */
export function resetPlaygroundPrompt(id: string): void {
  resetPrompt?.(id);
}

export function createMockApi(params: URLSearchParams = new URLSearchParams()): SaApi {
  const speed = Math.max(0.1, Number(params.get('speed') ?? 1) || 1);
  const latency = Number(params.get('latency') ?? 60);
  const freeze = params.has('freeze') || params.has('playground');
  const initialLang: Lang = params.get('lang') === 'en' ? 'en' : 'es';
  // The Microsoft Store build's move from the GitHub install (on Windows): `?dataImport=uninstall`
  // (it is still installed; "uninstalled" 3 s after the button) or `=import` (copying its data).
  const dataImportParam = params.get('dataImport');
  let dataImport: DataImportStatus = {
    state:
      dataImportParam === 'uninstall' || dataImportParam === 'import' ? dataImportParam : 'none',
  };
  let uninstalledAt: number | undefined;
  const onboarding =
    (params.has('onboarding') && params.get('onboarding') !== '0') || dataImport.state !== 'none';
  const chatgptIneligible = params.get('chatgpt') === 'ineligible';
  const dnieSaved = params.has('dnieSaved');
  const dniePhone =
    params.get('dnie') === '1' || params.has('companion') || params.has('playground') || dnieSaved;

  let state: MockState = createDemoState(Date.now(), {
    provider: params.get('provider'),
    empty: params.has('empty'),
    onboarding,
    lang: initialLang,
  });
  if (params.has('map')) {
    const item = state.procedures
      .get(DEMO_IDS.dni)
      ?.runtime.prompts?.find((p) => p.id === DEMO_IDS.dniPrompt);
    if (item?.prompt.kind === 'form') {
      item.prompt.title = initialLang === 'es' ? 'Elige el centro' : 'Choose a centre';
      item.prompt.message =
        initialLang === 'es'
          ? 'Compara estos lugares de demostración y elige el que prefieras.'
          : 'Compare these demo places and choose one.';
      item.prompt.submitLabel = initialLang === 'es' ? 'Continuar' : 'Continue';
      item.prompt.fields = [
        {
          key: 'oficina',
          label: initialLang === 'es' ? 'Centro preferido' : 'Preferred centre',
          type: 'map-options',
          required: true,
          options: [
            {
              value: 'north',
              label: 'Centro Norte (demo)',
              address: 'Calle de ejemplo 20, Sevilla',
            },
            {
              value: 'south',
              label: 'Centro Sur (demo)',
              address: 'Avenida de ejemplo 1, Sevilla',
            },
            {
              value: 'east',
              label: 'Centro Este (demo)',
              address: 'Plaza de ejemplo 3, Sevilla',
            },
          ],
        },
      ];
    }
    if (params.has('address')) {
      const entries = {
        addressStreet: 'Calle de ejemplo 10',
        addressMunicipality: 'Sevilla',
        addressCountry: 'España',
      };
      state.personal = state.personal.filter((p) => !p.key.startsWith('address'));
      for (const [key, value] of Object.entries(entries))
        state.personal.push({
          key,
          label: key,
          value,
          updatedAt: new Date().toISOString(),
          source: 'manual',
        });
    } else state.personal = state.personal.filter((p) => !p.key.startsWith('address'));
  }
  if (params.has('appointment')) {
    const item = state.procedures
      .get(DEMO_IDS.dni)
      ?.runtime.prompts?.find((p) => p.id === DEMO_IDS.dniPrompt);
    if (item?.prompt.kind === 'form') {
      item.prompt.title = initialLang === 'es' ? 'Elige tu cita' : 'Choose your appointment';
      item.prompt.message =
        initialLang === 'es'
          ? 'Estas son las citas libres de la oficina de demostración. Elige la que te venga mejor.'
          : 'These are the free appointments at the demo office. Choose the one that suits you.';
      item.prompt.submitLabel = initialLang === 'es' ? 'Continuar' : 'Continue';
      item.prompt.fields = [
        {
          key: 'cita',
          label:
            initialLang === 'es'
              ? 'Cita en la Oficina de Documentación (demo)'
              : 'Appointment at the Documentation Office (demo)',
          type: 'appointment',
          required: true,
          slots: [
            '2026-10-19T09:20',
            '2026-10-19T19:00',
            '2026-10-20T10:40',
            '2026-10-20T19:00',
            '2026-10-22T19:00',
            '2026-10-26T09:00',
            '2026-10-26T19:00',
            '2026-10-27T19:00',
            '2026-10-29T12:20',
            '2026-10-29T19:00',
            '2026-11-02T09:40',
            '2026-11-03T10:00',
          ],
        },
      ];
    }
  }
  if (dnieSaved)
    state.credentials.push({
      id: 'cred-dnie',
      kind: 'dnie',
      label: 'DNIe con el móvil',
      policy: 'ask',
      createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      hasPin: params.get('dnieSaved') === 'pin',
    });
  if (params.has('phone')) {
    // The DNI card asks for a phone call instead of its form (the call card's states).
    const item = state.procedures
      .get(DEMO_IDS.dni)
      ?.runtime.prompts?.find((p) => p.id === DEMO_IDS.dniPrompt);
    if (item) item.prompt = phoneCallExample((es, en) => (initialLang === 'en' ? en : es));
  }
  if (params.has('playground')) {
    state.conversation = examplePromptItems(initialLang);
    state.personal = state.personal.filter((p) => !p.key.startsWith('address'));
    state.media.set(
      'playground-image',
      fakePage({ host: 'demo.local', title: 'Demostración / Demo', kind: 'qr' }),
    );
  }
  const lang = (): Lang => state.settings.language;
  const cancelled = () =>
    lang() === 'es' ? 'Has cancelado el inicio de sesión.' : 'Sign-in cancelled.';
  const tr = (es: string, en: string) => (lang() === 'en' ? en : es);

  const listeners = new Set<(event: SaEvent) => void>();
  const emit = (event: SaEvent) => {
    for (const listener of listeners) listener(clone(event));
  };

  if (params.has('playground'))
    resetPrompt = (id) => {
      const item = examplePromptItems(state.settings.language).find((item) => item.id === id);
      if (item) putChat(item);
    };

  // The phone pairing for DNIe signatures: a fake link that pairs a demo phone after a moment.
  const demoLink = 'https://relay.example.invalid/p#demo';
  const pairedUntil = new Date(Date.now() + 72 * 3600_000).toISOString();
  const companionParam = params.get('companion') ?? (params.has('playground') ? 'connected' : '');
  let companion: CompanionStatus =
    companionParam === 'connected'
      ? { state: 'connected', device: 'Pixel 8', expiresAt: pairedUntil }
      : companionParam === 'away'
        ? { state: 'away', device: 'Pixel 8', expiresAt: pairedUntil }
        : companionParam === 'waiting'
          ? { state: 'waiting', link: demoLink, expiresAt: pairedUntil }
          : companionParam === 'outdated' || companionParam === 'outdated_desktop'
            ? {
                state: 'away',
                device: 'Pixel 8',
                expiresAt: pairedUntil,
                outdated:
                  companionParam === 'outdated'
                    ? { phone: COMPANION_PROTOCOL - 1, desktop: COMPANION_PROTOCOL }
                    : { phone: COMPANION_PROTOCOL + 1, desktop: COMPANION_PROTOCOL },
              }
            : companionParam === 'stalled'
              ? { state: 'connecting', link: demoLink, expiresAt: pairedUntil, stalled: true }
              : companionParam === 'phone_unpaired' ||
                  companionParam === 'expired' ||
                  companionParam === 'relay_refused'
                ? { state: 'off', reason: companionParam }
                : { state: 'off' };
  const setCompanion = (next: CompanionStatus) => {
    companion = next;
    emit({ type: 'companion.changed', status: next });
  };

  // The must-update screen: `?mustUpdate=1` plays a Windows update (checking, downloading, ready);
  // a state name shows that one (`downloading` at 42 %). `?store=1`: the Microsoft Store build,
  // which never updates itself (the screen opens the Store instead).
  const store = params.get('store') === '1';
  const mustUpdateParam = params.get('mustUpdate');
  const mustUpdate = mustUpdateParam !== null && mustUpdateParam !== '0';
  let updates: UpdateStatus = store
    ? { state: 'unsupported' }
    : mustUpdateParam === 'downloading'
      ? { state: 'downloading', version: '0.3.0', percent: 42 }
      : mustUpdateParam === 'ready'
        ? { state: 'ready', version: '0.3.0' }
        : mustUpdateParam === 'checking' ||
            mustUpdateParam === 'error' ||
            mustUpdateParam === 'upToDate'
          ? { state: mustUpdateParam }
          : mustUpdateParam === '1'
            ? { state: 'checking' }
            : { state: 'unsupported' };
  if (mustUpdateParam === '1' && !freeze && !store) {
    const setUpdates = (next: UpdateStatus) => {
      updates = next;
      emit({ type: 'updates.status', status: next });
    };
    let percent = 0;
    window.setTimeout(() => {
      const timer = window.setInterval(() => {
        percent = Math.min(100, percent + 7);
        if (percent < 100) setUpdates({ state: 'downloading', version: '0.3.0', percent });
        else {
          window.clearInterval(timer);
          setUpdates({ state: 'ready', version: '0.3.0' });
        }
      }, 400 / speed);
    }, 1500 / speed);
  }

  let seq = 1;
  const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${seq++}`;
  const now = () => new Date().toISOString();
  const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms / speed));

  // -------------------------------------------------------------------------------------------
  // Procedures
  // -------------------------------------------------------------------------------------------

  function getProc(id: string): ProcedureListItem {
    const p = state.procedures.get(id);
    if (!p) throw new Error(tr(`Trámite no encontrado: ${id}`, `Procedure not found: ${id}`));
    return p;
  }

  function putProc(p: ProcedureListItem, touch = true) {
    const next = touch ? { ...p, updatedAt: now() } : p;
    state.procedures.set(p.id, next);
    emit({ type: 'procedure.upserted', procedure: next });
    return next;
  }

  function setRuntime(id: string, patch: Partial<ProcedureListItem['runtime']>) {
    const p = state.procedures.get(id);
    if (!p) return;
    const runtime = { ...p.runtime, ...patch };
    if (runtime.activity !== 'working') delete runtime.workingSince;
    else if (p.runtime.activity !== 'working') runtime.workingSince = new Date().toISOString();
    if ('now' in patch && patch.now === undefined) delete runtime.now;
    if ('error' in patch && patch.error === undefined) delete runtime.error;
    if ('prompts' in patch && patch.prompts === undefined) delete runtime.prompts;
    putProc({ ...p, runtime }, false);
  }

  /** The renderer marks a procedure read while it is open; approximate it via markRead. */
  const viewing = new Set<string>();

  function log(id: string): ChatItem[] {
    let list = state.logs.get(id);
    if (!list) {
      list = [];
      state.logs.set(id, list);
    }
    return list;
  }

  function putLog(procedureId: string, item: ChatItem) {
    const list = log(procedureId);
    const index = list.findIndex((i) => i.id === item.id);
    if (index === -1) list.push(item);
    else list[index] = item;
    emit({ type: 'procedure.log', procedureId, item });
  }

  function findLog<T extends ChatItem['type']>(procedureId: string, itemId: string, type: T) {
    const item = log(procedureId).find((i) => i.id === itemId);
    return item && item.type === type ? (item as Extract<ChatItem, { type: T }>) : undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Conversation
  // -------------------------------------------------------------------------------------------

  function putChat(item: ChatItem) {
    const list = state.conversation;
    const index = list.findIndex((i) => i.id === item.id);
    if (index === -1) list.push(item);
    else list[index] = item;
    emit({ type: 'chat.item', item });
  }

  function findChat<T extends ChatItem['type']>(itemId: string, type: T) {
    const item = state.conversation.find((i) => i.id === itemId);
    return item && item.type === type ? (item as Extract<ChatItem, { type: T }>) : undefined;
  }

  function setChatState(next: ConversationState) {
    state.chatState = next;
    emit({ type: 'chat.state', state: next });
  }

  function chatNotice(
    level: 'info' | 'success' | 'warning' | 'error',
    text: string,
    procedureId?: string,
  ) {
    putChat({ id: newId('n'), type: 'notice', createdAt: now(), level, text, procedureId });
  }

  // -------------------------------------------------------------------------------------------
  // The assistant (orchestrator): one run at a time, queued
  // -------------------------------------------------------------------------------------------

  let assistantToken: Token | null = null;
  let assistantEpoch = 0;
  let assistantQueue: Promise<void> = Promise.resolve();
  let assistantPending = 0;

  function runAssistant(steps: AStep[]) {
    const epoch = assistantEpoch;
    assistantPending++;
    if (state.chatState.activity !== 'working') setChatState({ activity: 'working' });
    assistantQueue = assistantQueue.then(async () => {
      try {
        if (epoch === assistantEpoch) await assistantRun(steps);
      } finally {
        assistantPending--;
        if (assistantPending === 0 && state.chatState.activity === 'working')
          setChatState({ activity: 'idle' });
      }
    });
  }

  async function streamInto(itemId: string, text: string, token: Token) {
    const chunks = text.match(/\S+\s*|\s+/g) ?? [];
    for (let i = 0; i < chunks.length; ) {
      if (token.cancelled) return false;
      const take = 1 + Math.floor(Math.random() * 3);
      const delta = chunks.slice(i, i + take).join('');
      i += take;
      const item = findChat(itemId, 'assistant');
      if (item?.status !== 'streaming') return false;
      item.text += delta;
      emit({ type: 'chat.delta', itemId, delta });
      await sleep(40 + Math.random() * 40);
    }
    return true;
  }

  async function assistantRun(steps: AStep[]) {
    const token: Token = { cancelled: false };
    assistantToken = token;
    for (const step of steps) {
      if (token.cancelled) return;
      switch (step.kind) {
        case 'wait':
          await sleep(step.ms);
          break;
        case 'say': {
          await sleep(350);
          if (token.cancelled) return;
          const item: AssistantItem = {
            id: newId('m'),
            type: 'assistant',
            createdAt: now(),
            text: '',
            status: 'streaming',
          };
          putChat(item);
          const ok = await streamInto(item.id, step.text, token);
          if (!ok) return;
          const latest = findChat(item.id, 'assistant');
          if (latest) putChat({ ...latest, status: 'complete' });
          break;
        }
        case 'start': {
          const { plan } = step;
          const row: ActivityItem = {
            id: newId('a'),
            type: 'activity',
            createdAt: now(),
            toolCallId: newId('call'),
            tool: 'procedure_start',
            args: { title: plan.title, brief: plan.brief },
            status: 'running',
          };
          putChat(row);
          await sleep(500);
          if (token.cancelled) {
            putChat({
              ...row,
              status: 'error',
              summary: tr('Detenido', 'Stopped'),
              finishedAt: now(),
            });
            return;
          }
          const id = newId('p');
          const t = now();
          const procedure: ProcedureListItem = {
            id,
            title: plan.title,
            status: 'researching',
            administration: plan.administration,
            steps: [],
            requirements: [],
            facts: [],
            sources: [],
            createdAt: t,
            updatedAt: t,
            archived: false,
            runtime: { activity: 'working', workingSince: t, unread: false },
          };
          state.procedures.set(id, procedure);
          topics.set(plan.topic, id);
          emit({ type: 'procedure.upserted', procedure });
          putLog(id, { id: newId('u'), type: 'user', createdAt: t, text: plan.brief });
          putChat({
            ...row,
            status: 'done',
            summary: tr('Trámite creado', 'Procedure created'),
            finishedAt: now(),
          });
          void runProcedure(id, plan.agent);
          break;
        }
      }
    }
    if (assistantToken === token) assistantToken = null;
  }

  function abortAssistant() {
    assistantEpoch++;
    if (assistantToken) assistantToken.cancelled = true;
    assistantToken = null;
    for (const item of state.conversation) {
      if (item.type === 'assistant' && item.status === 'streaming')
        putChat({ ...item, status: 'aborted' });
      if (item.type === 'activity' && item.status === 'running')
        putChat({
          ...item,
          status: 'error',
          summary: tr('Detenido', 'Stopped'),
          finishedAt: now(),
        });
    }
    setChatState({ activity: 'idle' });
  }

  /** Topic -> procedure id, so the assistant does not start the same procedure twice. */
  const topics = new Map<string, string>(Object.entries(DEMO_TOPICS));

  function assistantReplyTo(text: string): AStep[] {
    const topic = detectTopic(text);
    const existingId = topic ? topics.get(topic) : undefined;
    const existing = existingId ? state.procedures.get(existingId) : undefined;
    if (existing && !existing.archived)
      return [
        { kind: 'wait', ms: 500 },
        { kind: 'say', text: existingReply(existing, lang()) },
      ];
    if (topic || soundsLikeNeed(text)) {
      const { intro, plan } = newProcedurePlan(text, lang());
      return [
        { kind: 'wait', ms: 500 },
        { kind: 'say', text: intro },
        { kind: 'start', plan },
      ];
    }
    return [
      { kind: 'wait', ms: 500 },
      { kind: 'say', text: genericReply(text, lang()) },
    ];
  }

  // -------------------------------------------------------------------------------------------
  // Procedure agents
  // -------------------------------------------------------------------------------------------

  const runs = new Map<string, Token>();
  const pendingAsks = new Map<string, PendingAsk>();

  function cancelRun(procedureId: string) {
    const run = runs.get(procedureId);
    if (run) run.cancelled = true;
    runs.delete(procedureId);
  }

  /** The questions waiting on a procedure's card. */
  function cardPrompts(procedureId: string): PromptItem[] {
    return state.procedures.get(procedureId)?.runtime.prompts ?? [];
  }

  function setCardPrompts(procedureId: string, prompts: PromptItem[]) {
    setRuntime(procedureId, { prompts: prompts.length ? prompts : undefined });
  }

  /** Cancels the questions still waiting on the procedure's card. */
  function cancelPrompts(procedureId: string) {
    for (const item of cardPrompts(procedureId)) pendingAsks.delete(item.id);
    setCardPrompts(procedureId, []);
  }

  /** A pending question: the assistant's (in the conversation) or a procedure's (on its card). */
  function findPrompt(itemId: string): PromptItem | undefined {
    const own = findChat(itemId, 'prompt');
    if (own) return own;
    for (const p of state.procedures.values()) {
      const item = p.runtime.prompts?.find((i) => i.id === itemId);
      if (item) return item;
    }
    return undefined;
  }

  async function runProcedure(procedureId: string, steps: PStep[]) {
    cancelRun(procedureId);
    const token: Token = { cancelled: false };
    runs.set(procedureId, token);
    setRuntime(procedureId, { activity: 'working', error: undefined });
    const alive = () => !token.cancelled && state.procedures.has(procedureId);
    // The document this run saved last: a report's reply may link it (`LAST_DOCUMENT`).
    let lastDocumentId: string | undefined;

    for (const step of steps) {
      if (!alive()) return;
      switch (step.kind) {
        case 'wait':
          await sleep(step.ms);
          break;
        case 'tool': {
          const args = step.args ?? {};
          const item: ActivityItem = {
            id: newId('a'),
            type: 'activity',
            createdAt: now(),
            toolCallId: newId('call'),
            tool: step.tool,
            args,
            status: 'running',
          };
          putLog(procedureId, item);
          setRuntime(procedureId, { now: { tool: step.tool, args } });
          await sleep(step.ms ?? 900);
          if (!alive()) return;
          putLog(procedureId, {
            ...item,
            status: step.fail ? 'error' : 'done',
            summary: step.summary,
            imageId: step.imageId,
            finishedAt: now(),
          });
          break;
        }
        case 'finish': {
          const item = findLog(procedureId, step.itemId, 'activity');
          if (item)
            putLog(procedureId, {
              ...item,
              status: 'done',
              summary: step.summary,
              finishedAt: now(),
            });
          break;
        }
        case 'update': {
          const p = getProc(procedureId);
          const { nextAction, ...rest } = step.patch;
          const next: ProcedureListItem = { ...p };
          for (const [key, value] of Object.entries(rest)) {
            if (value !== undefined) (next as Record<string, unknown>)[key] = value;
          }
          if (nextAction === null) delete next.nextAction;
          else if (nextAction) next.nextAction = nextAction;
          putProc(next);
          break;
        }
        case 'notice':
          putLog(procedureId, {
            id: newId('n'),
            type: 'notice',
            createdAt: now(),
            level: step.level,
            text: step.text,
            procedureId,
          });
          break;
        case 'document': {
          const doc: DocumentMeta = {
            id: newId('doc'),
            name: step.name,
            mimeType: 'application/pdf',
            size: 60_000 + Math.floor(Math.random() * 60_000),
            source: 'download',
            procedureId,
            createdAt: now(),
          };
          state.documents.unshift(doc);
          lastDocumentId = doc.id;
          state.documentPreviews.set(doc.id, fakeDocumentPage(step.preview[0], step.preview[1]));
          emit({ type: 'vault.changed' });
          break;
        }
        case 'ask': {
          const tool = step.prompt.kind === 'confirm' ? 'confirm_action' : 'ask_user';
          const logItem: ActivityItem = {
            id: newId('a'),
            type: 'activity',
            createdAt: now(),
            toolCallId: newId('call'),
            tool,
            args: { title: step.prompt.title },
            status: 'running',
          };
          putLog(procedureId, logItem);
          const prompt: PromptItem = {
            id: newId('c'),
            type: 'prompt',
            createdAt: now(),
            procedureId,
            prompt: step.prompt,
            status: 'pending',
          };
          setCardPrompts(procedureId, [...cardPrompts(procedureId), prompt]);
          pendingAsks.set(prompt.id, {
            procedureId,
            logItemId: logItem.id,
            onAnswer: step.onAnswer,
          });
          runs.delete(procedureId);
          setRuntime(procedureId, {
            activity: 'needs_user',
            now: undefined,
            unread: !viewing.has(procedureId),
          });
          return;
        }
        case 'report': {
          const t = now();
          putLog(procedureId, {
            id: newId('m'),
            type: 'assistant',
            createdAt: t,
            text: step.summary,
            status: step.error ? 'error' : 'complete',
          });
          runs.delete(procedureId);
          setRuntime(procedureId, {
            activity: 'idle',
            now: undefined,
            unread: !viewing.has(procedureId),
          });
          const p = getProc(procedureId);
          putChat({
            id: newId('a'),
            type: 'activity',
            createdAt: t,
            toolCallId: `report-${procedureId}-${t}`,
            tool: REPORT_TOOL,
            args: { procedureId, title: p.title },
            status: step.error ? 'error' : 'done',
            summary: step.summary,
            finishedAt: t,
          });
          const reply = lastDocumentId
            ? step.reply.replaceAll(LAST_DOCUMENT, lastDocumentId)
            : step.reply;
          runAssistant([{ kind: 'say', text: reply }]);
          return;
        }
      }
    }
    if (!token.cancelled) {
      runs.delete(procedureId);
      setRuntime(procedureId, { activity: 'idle', now: undefined });
    }
  }

  /** Stops a procedure's agent: running activities end, pending prompts are cancelled. */
  function stopProcedure(procedureId: string) {
    cancelRun(procedureId);
    cancelPrompts(procedureId);
    for (const item of log(procedureId)) {
      if (item.type === 'activity' && item.status === 'running')
        putLog(procedureId, {
          ...item,
          status: 'error',
          summary: tr('Detenido', 'Stopped'),
          finishedAt: now(),
        });
    }
  }

  // The pending demo form belongs to the DNI agent.
  if (cardPrompts(DEMO_IDS.dni).some((i) => i.id === DEMO_IDS.dniPrompt)) {
    pendingAsks.set(DEMO_IDS.dniPrompt, {
      procedureId: DEMO_IDS.dni,
      logItemId: DEMO_IDS.dniPromptActivity,
      onAnswer: (r) => dniAfterForm(r, lang()),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Vault helpers
  // -------------------------------------------------------------------------------------------

  const overview = (): VaultOverview => ({
    personal: state.personal,
    documents: state.documents,
    // Like main: without the feature flag, a saved DNIe stays hidden.
    credentials: dniePhone ? state.credentials : state.credentials.filter((c) => c.kind !== 'dnie'),
    storage: state.storage,
  });
  const requireDniePhone = () => {
    if (!dniePhone)
      throw new Error(
        tr(
          'El DNIe con el móvil no está disponible en esta versión de la app.',
          "DNIe with your phone isn't available in this version of the app.",
        ),
      );
  };

  const vaultChanged = () => {
    emit({ type: 'vault.changed' });
    return clone(overview());
  };

  function setProvider(status: ProviderStatus, config?: Settings['provider']) {
    state.provider = status;
    if (config) state.settings = { ...state.settings, provider: config };
    else if (!status.configured) {
      const { provider: _removed, ...rest } = state.settings;
      state.settings = rest as Settings;
    }
    emit({ type: 'providers.status', status });
    emit({ type: 'settings.changed', settings: state.settings });
  }

  function upsertPersonal(
    key: string,
    value: string,
    source: PersonalDataItem['source'],
    label?: string,
  ) {
    const def = personalFieldDef(key);
    const item: PersonalDataItem = {
      key,
      label: def ? def.label[lang()] : (label ?? key),
      value,
      source,
      updatedAt: now(),
    };
    const index = state.personal.findIndex((p) => p.key === key);
    if (index === -1) state.personal.push(item);
    else state.personal[index] = item;
    return item;
  }

  let loginAbort: (() => void) | null = null;

  // -------------------------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------------------------

  /** Demo pins for the offline map options (their addresses). */
  const DEMO_PLACES: Record<string, { latitude: number; longitude: number }> = {
    'Calle de ejemplo 20, Sevilla': { latitude: 37.404, longitude: -5.991 },
    'Avenida de ejemplo 1, Sevilla': { latitude: 37.371, longitude: -5.988 },
    'Plaza de ejemplo 3, Sevilla': { latitude: 37.388, longitude: -5.968 },
  };

  /** The DNI/NIE of each Cl@ve Permanente (the demo's own one is the demo DNI). */
  const claveUsernames = new Map<string, string>();
  const claveUsername = (id: string) => claveUsernames.get(id) ?? '12345678Z';

  const handlers: Handlers = {
    'places.locateHome': () => ({ latitude: 37.375, longitude: -5.986 }),
    'places.pins': (itemId, fieldKey) => {
      if (params.get('nomap') === '1') return null;
      const item = findPrompt(itemId);
      const field =
        item?.prompt.kind === 'form'
          ? item.prompt.fields.find((f) => f.key === fieldKey)
          : undefined;
      return (field?.options ?? []).map((option) => DEMO_PLACES[option.address ?? ''] ?? null);
    },
    'app.info': () => ({
      name: 'Spain Assist',
      version: '0.3.0-beta',
      platform: dataImportParam || store ? 'win32' : 'darwin',
      installChannel: dataImportParam || store ? 'msix' : 'dev',
      isDev: true,
      isE2E: false,
      features: {
        dniePhone,
        mustUpdate,
        errorReports: params.get('errors') === '1',
      },
      errorReports: false,
    }),
    'updates.status': () => updates,
    'dataImport.status': () => {
      if (dataImport.state === 'uninstall' && uninstalledAt && Date.now() >= uninstalledAt)
        dataImport = { state: 'import' };
      return dataImport;
    },
    'dataImport.uninstall': () => {
      toast.info(tr('Desinstalador de ejemplo', 'Example uninstaller'));
      if (!freeze) uninstalledAt = Date.now() + 3000;
    },
    'dataImport.run': async () => {
      if (freeze) await new Promise<never>(() => {});
      await sleep(1500);
      // The real app restarts into the imported data.
      const next = new URLSearchParams(params);
      next.delete('dataImport');
      location.search = next.toString();
      await new Promise<never>(() => {});
    },
    'updates.openStore': () => {
      toast.info(tr('Microsoft Store de ejemplo', 'Example Microsoft Store'));
    },
    'app.reveal': () => {},
    'app.windowControls': () => {},
    'app.exportTranscripts': () => 'SpainAssist-transcripts-2026-10-12.zip',
    'app.openExternal': (url) => {
      if (params.has('playground')) {
        toast.info(tr('Enlace de ejemplo', 'Example link'), url);
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    },

    'settings.get': () => state.settings,
    'settings.update': (patch) => {
      const s = state.settings;
      state.settings = {
        ...s,
        ...(patch.language ? { language: patch.language } : {}),
        ...(patch.onboardingCompleted !== undefined
          ? { onboardingCompleted: patch.onboardingCompleted }
          : {}),
        ...(patch.shareLearnings !== undefined ? { shareLearnings: patch.shareLearnings } : {}),
        ...(patch.errorReports !== undefined ? { errorReports: patch.errorReports } : {}),
      };
      emit({ type: 'settings.changed', settings: state.settings });
      return state.settings;
    },

    'providers.status': () => state.provider,
    'providers.loginChatGPT': async () => {
      let aborted = false;
      loginAbort = () => {
        aborted = true;
      };
      emit({
        type: 'providers.loginProgress',
        message:
          lang() === 'es'
            ? 'Continúa en tu navegador para iniciar sesión con ChatGPT.'
            : 'Continue in your browser to sign in with ChatGPT.',
        url: 'https://auth.openai.com/oauth/authorize',
      });
      await sleep(1200);
      if (aborted) return { ok: false, error: cancelled() };
      emit({
        type: 'providers.loginProgress',
        message:
          lang() === 'es'
            ? 'Esperando a que termines en el navegador…'
            : 'Waiting for you to finish in the browser…',
      });
      await sleep(2600);
      if (aborted) return { ok: false, error: cancelled() };
      loginAbort = null;
      if (chatgptIneligible) {
        return {
          ok: false,
          error:
            lang() === 'es'
              ? 'Spain Assist solo puede conectar la IA de ChatGPT en los planes Plus o superiores.'
              : 'Spain Assist can only connect ChatGPT on Plus plans or higher.',
        };
      }
      const status: ProviderStatus = {
        configured: true,
        kind: 'chatgpt',
        label: 'ChatGPT',
        model: 'gpt-6.1-sol',
        account: 'lucia@example.com · Plus',
      };
      setProvider(status, { kind: 'chatgpt' });
      return { ok: true, status };
    },
    'providers.loginCodexDevice': async () => {
      let aborted = false;
      loginAbort = () => {
        aborted = true;
      };
      emit({
        type: 'providers.loginProgress',
        message: 'Abre la página de OpenAI y escribe este código.',
        url: 'https://auth.openai.com/codex/device',
        userCode: 'K7QD-9XWM',
      });
      await sleep(6000);
      if (aborted) return { ok: false, error: cancelled() };
      loginAbort = null;
      const status: ProviderStatus = {
        configured: true,
        kind: 'codex',
        label: 'ChatGPT vía Codex (desarrollo)',
        model: 'gpt-6.1-sol',
        account: 'lucia@example.com',
      };
      setProvider(status, { kind: 'codex' });
      return { ok: true, status };
    },
    'providers.cancelLogin': () => {
      loginAbort?.();
      loginAbort = null;
    },
    'providers.redeemVoucher': async (code) => {
      await sleep(900);
      // Any well-formed code works, except SA-000000, which plays an already used one.
      const body = normalizeVoucherCode(code);
      if (!body)
        return { ok: false, error: 'El código no es válido. Revisa que esté bien escrito.' };
      if (body === '000000') return { ok: false, error: 'Este código ya se ha usado.' };
      // Every code adds 5 to the voucher key the app already holds (the key server's top-up).
      const addedUsd = 5;
      const old = state.provider.kind === 'voucher' ? state.provider.credit : undefined;
      const usageUsd = old?.usageUsd ?? 0;
      const limitUsd = (old?.limitUsd ?? 0) + addedUsd;
      const status: ProviderStatus = {
        configured: true,
        kind: 'voucher',
        label: 'Bono Spain Assist',
        model: 'openai/gpt-5-mini',
        credit: { usageUsd, limitUsd, remainingUsd: Math.max(0, limitUsd - usageUsd) },
        expiresAt: new Date(Date.now() + 180 * 86_400_000).toISOString(),
      };
      setProvider(status, {
        kind: 'voucher',
        secretId: 'sec-voucher',
        limitUsd,
      });
      return { ok: true, status, addedUsd };
    },
    'providers.setByok': async (input) => {
      await sleep(700);
      if (input.apiKey.trim().length < 8) return { ok: false, error: 'La clave no parece válida.' };
      const name = BYOK_PROVIDERS.find((p) => p.id === input.provider)?.name ?? input.provider;
      const status: ProviderStatus = {
        configured: true,
        kind: 'byok',
        label: `${name} (clave propia)`,
        model: input.model,
        exaKey: !!state.provider.exaKey,
      };
      setProvider(status, {
        kind: 'byok',
        provider: input.provider,
        model: input.model,
        secretId: 'sec-byok',
      });
      return { ok: true, status };
    },
    'providers.setCustom': async (input) => {
      await sleep(700);
      const status: ProviderStatus = {
        configured: true,
        kind: 'custom',
        label: 'Servidor propio',
        model: input.model,
        exaKey: !!state.provider.exaKey,
      };
      const { apiKey: _, ...config } = input;
      setProvider(status, { kind: 'custom', ...config });
      return { ok: true, status };
    },
    // A local Ollama-like server: vision models have "vl" or "llava" in their name.
    'providers.probeCustom': async (input) => {
      await sleep(500);
      if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(input.baseUrl)) {
        return { reachable: false, models: [], detected: {} };
      }
      const models = ['llama3.1:8b', 'qwen2.5vl:7b', 'qwen3:14b'];
      const model = input.model.trim();
      return {
        reachable: true,
        server: 'ollama',
        models,
        detected: models.includes(model)
          ? {
              supportsImages: /vl|llava/.test(model),
              reasoning: model.startsWith('qwen3'),
              contextWindow: 32_768,
            }
          : {},
      };
    },
    'providers.listByok': () => BYOK_PROVIDERS,
    'providers.listModels': () => {
      const p = state.settings.provider;
      if (p?.kind !== 'byok') return [];
      const provider = p.provider;
      const models = BYOK_PROVIDERS.find((o) => o.id === provider)?.models ?? [];
      return models.some((m) => m.id === p.model)
        ? models
        : [{ provider, id: p.model, name: p.model }, ...models];
    },
    'providers.setModel': (model) => {
      const p = state.settings.provider;
      // Only BYOK and custom endpoints: the app version picks the model of the others.
      if (p?.kind !== 'byok' && p?.kind !== 'custom') {
        throw new Error(tr('Solicitud no válida.', 'Invalid request.'));
      }
      const status = { ...state.provider, model };
      setProvider(status, { ...p, model });
      return status;
    },
    'providers.setExaKey': async (apiKey) => {
      await sleep(400);
      const kind = state.provider.kind;
      // Only BYOK and custom endpoints research with the user's Exa key.
      if (kind !== 'byok' && kind !== 'custom') {
        throw new Error(tr('Solicitud no válida.', 'Invalid request.'));
      }
      const status = { ...state.provider, exaKey: !!apiKey?.trim() };
      setProvider(status);
      return status;
    },
    'providers.logout': () => {
      const status: ProviderStatus = { configured: false };
      setProvider(status);
      return { status };
    },

    'procedures.list': () => [...state.procedures.values()],
    'procedures.get': (id) => state.procedures.get(id) ?? null,
    'procedures.log': (id) => (state.procedures.has(id) ? log(id) : []),
    'procedures.rename': (id, title) =>
      putProc({ ...getProc(id), title: title.trim().slice(0, 160) || getProc(id).title }),
    'procedures.archive': (id, archived) => putProc({ ...getProc(id), archived }),
    'procedures.stop': (id) => {
      getProc(id);
      stopProcedure(id);
      setRuntime(id, { activity: 'idle', now: undefined });
    },
    'procedures.delete': (id) => {
      stopProcedure(id);
      state.procedures.delete(id);
      state.logs.delete(id);
      for (const [topic, pid] of topics) if (pid === id) topics.delete(topic);
      emit({ type: 'procedure.deleted', procedureId: id });
    },
    'procedures.markRead': (id) => {
      viewing.clear();
      viewing.add(id);
      const p = state.procedures.get(id);
      if (p?.runtime.unread) setRuntime(id, { unread: false });
    },

    'chat.transcript': () => state.conversation,
    'chat.state': () => state.chatState,
    'chat.send': (input) => {
      if (!state.provider.configured)
        throw new Error(
          tr('Conecta una IA en Ajustes para empezar.', 'Connect an AI in Settings to start.'),
        );
      putChat({
        id: newId('u'),
        type: 'user',
        createdAt: now(),
        text: input.text,
        attachments: input.attachments,
      });
      if (freeze) return;
      runAssistant(assistantReplyTo(input.text));
    },
    'chat.abort': () => {
      abortAssistant();
    },
    'chat.respond': (promptItemId, response) => {
      const item = findPrompt(promptItemId);
      if (item?.status !== 'pending')
        throw new Error(
          tr('Esta pregunta ya no está pendiente.', 'This question is no longer pending.'),
        );
      if (item.procedureId)
        setCardPrompts(
          item.procedureId,
          cardPrompts(item.procedureId).filter((i) => i.id !== item.id),
        );
      else putChat({ ...item, status: 'answered', response });

      // Answers the user chose to keep go to "Mis datos" (never secrets or documents).
      if (
        response.kind === 'form' &&
        !response.dismissed &&
        response.values &&
        item.prompt.kind === 'form'
      ) {
        const saved: string[] = [];
        for (const key of response.savedToVault) {
          const field = item.prompt.fields.find((f) => f.key === key);
          const value = response.values[key];
          if (!field?.vaultKey || field.type === 'secret' || field.type === 'document') continue;
          if (typeof value !== 'string' || !value.trim()) continue;
          saved.push(upsertPersonal(field.vaultKey, value.trim(), 'form', field.label).label);
        }
        if (saved.length) {
          emit({ type: 'vault.changed' });
          const labels = saved.join(', ');
          chatNotice(
            'info',
            tr(`Guardado en Mis datos: ${labels}.`, `Saved to My data: ${labels}.`),
            item.procedureId,
          );
        }
      }

      const pending = pendingAsks.get(promptItemId);
      pendingAsks.delete(promptItemId);
      const procedureId = pending?.procedureId ?? item.procedureId;
      if (!procedureId || !state.procedures.has(procedureId)) return;
      if (pending?.logItemId) {
        const logItem = findLog(procedureId, pending.logItemId, 'activity');
        const dismissed =
          (response.kind === 'form' && response.dismissed) ||
          (response.kind === 'confirm' && !response.approved) ||
          (response.kind === 'user_action' && !response.done) ||
          (response.kind === 'phone_call' && response.outcome === 'skipped');
        if (logItem)
          putLog(procedureId, {
            ...logItem,
            status: 'done',
            summary: dismissed ? tr('Descartado', 'Dismissed') : tr('Respondido', 'Answered'),
            finishedAt: now(),
          });
      }
      if (cardPrompts(procedureId).length) return;
      if (freeze || !pending?.onAnswer) {
        setRuntime(procedureId, { activity: 'idle', now: undefined });
        return;
      }
      void runProcedure(procedureId, pending.onAnswer(response));
    },

    'vault.overview': () => overview(),
    'vault.setPersonal': (inputs) => {
      for (const input of inputs) upsertPersonal(input.key, input.value, 'manual', input.label);
      return vaultChanged();
    },
    'vault.setPersonalPartial': (inputs) => {
      for (const input of inputs) upsertPersonal(input.key, input.value, 'scan', input.label);
      return { overview: vaultChanged(), rejected: [] };
    },
    'vault.deletePersonal': (keys) => {
      state.personal = state.personal.filter((p) => !keys.includes(p.key));
      return vaultChanged();
    },
    'vault.addDocument': (input) => {
      const doc: DocumentMeta = {
        id: newId('doc'),
        name: input.name,
        mimeType: input.mimeType,
        size: input.bytes.byteLength,
        source: input.source === 'scan' ? 'scan' : 'user',
        procedureId: input.procedureId,
        createdAt: now(),
      };
      state.documents.unshift(doc);
      if (input.mimeType.startsWith('image/')) {
        state.documentPreviews.set(
          doc.id,
          URL.createObjectURL(new Blob([input.bytes as BlobPart], { type: input.mimeType })),
        );
      } else {
        state.documentPreviews.set(
          doc.id,
          fakeDocumentPage(input.name.replace(/\.[a-z0-9]+$/i, ''), 'Subido por ti'),
        );
      }
      emit({ type: 'vault.changed' });
      return doc;
    },
    'vault.deleteDocument': (id) => {
      state.documents = state.documents.filter((d) => d.id !== id);
      return vaultChanged();
    },
    'vault.openDocument': (id) => {
      const url = state.documentPreviews.get(id);
      if (url) window.open(url, '_blank', 'noopener');
    },
    'vault.downloadDocument': (id) => {
      const doc = state.documents.find((d) => d.id === id);
      if (!doc) throw new Error('Document not found');
      return doc.name;
    },
    'vault.previewDocument': (id) => state.documentPreviews.get(id) ?? null,
    'vault.addClave': async (input) => {
      await sleep(500);
      const username = input.username.trim().toUpperCase();
      if (!/^([0-9]{8}[A-Z]|[XYZ][0-9]{7}[A-Z])$/.test(username))
        throw new Error('El DNI o NIE no parece válido.');
      if (!input.password) throw new Error('Falta la contraseña.');
      state.credentials = state.credentials.filter((c) => c.kind !== 'clave_permanente');
      const cred: CredentialSummary = {
        id: newId('cred'),
        kind: 'clave_permanente',
        label: input.label?.trim() || 'Cl@ve Permanente',
        policy: 'auto',
        createdAt: now(),
        usernameHint: maskValue(username),
      };
      state.credentials.push(cred);
      claveUsernames.set(cred.id, username);
      emit({ type: 'vault.changed' });
      return cred;
    },
    'vault.updateClave': async (id, input) => {
      await sleep(500);
      const username = input.username.trim().toUpperCase();
      if (!/^([0-9]{8}[A-Z]|[XYZ][0-9]{7}[A-Z])$/.test(username))
        throw new Error('El DNI o NIE no parece válido.');
      const index = state.credentials.findIndex((c) => c.id === id);
      const old = state.credentials[index];
      if (old?.kind !== 'clave_permanente') throw new Error('No encontrado.');
      const cred: CredentialSummary = { ...old, usernameHint: maskValue(username) };
      state.credentials[index] = cred;
      claveUsernames.set(id, username);
      emit({ type: 'vault.changed' });
      return cred;
    },
    'vault.claveUsername': (id) => claveUsername(id),
    'vault.addClaveMovil': () => {
      const existing = state.credentials.find((c) => c.kind === 'clave_movil');
      if (existing) return existing;
      const cred: CredentialSummary = {
        id: newId('cred'),
        kind: 'clave_movil',
        label: 'Cl@ve Móvil',
        policy: 'auto',
        createdAt: now(),
      };
      state.credentials.push(cred);
      emit({ type: 'vault.changed' });
      return cred;
    },
    'vault.addDnie': () => {
      requireDniePhone();
      const existing = state.credentials.find((c) => c.kind === 'dnie');
      if (existing) return existing;
      const cred: CredentialSummary = {
        id: newId('cred'),
        kind: 'dnie',
        label: 'DNIe con el móvil',
        policy: 'ask',
        createdAt: now(),
        hasPin: false,
      };
      state.credentials.push(cred);
      emit({ type: 'vault.changed' });
      return cred;
    },
    'vault.setDniePin': (id, pin) => {
      const i = state.credentials.findIndex((c) => c.id === id && c.kind === 'dnie');
      if (i < 0) throw new Error(lang() === 'es' ? 'No lo encuentro.' : 'Not found.');
      const cred = { ...state.credentials[i]!, hasPin: pin !== null };
      state.credentials[i] = cred;
      emit({ type: 'vault.changed' });
      return cred;
    },
    'vault.addCertificate': async (input) => {
      await sleep(900);
      if (!input.passphrase || input.passphrase.toLowerCase() === 'mal')
        throw new Error('La contraseña del certificado no es correcta.');
      const holder = [
        state.personal.find((p) => p.key === 'givenName')?.value,
        state.personal.find((p) => p.key === 'surname1')?.value,
      ]
        .filter(Boolean)
        .join(' ');
      const cred: CredentialSummary = {
        id: newId('cred'),
        kind: 'certificate',
        label: input.label?.trim() || 'Certificado digital',
        policy: 'ask',
        createdAt: now(),
        certificate: {
          subject: `CN=${holder.toUpperCase() || 'TITULAR'} - 12345678Z`,
          issuer: 'AC FNMT Usuarios',
          serialNumber: '7C2B91AF00D3',
          validFrom: now(),
          validTo: new Date(Date.now() + 4 * 365 * 86_400_000).toISOString(),
          holderName: holder.toUpperCase() || undefined,
          holderId: '12345678Z',
          fingerprint: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        },
      };
      state.credentials.push(cred);
      emit({ type: 'vault.changed' });
      return cred;
    },
    'vault.setCredentialPolicy': (id, policy) => {
      const cred = state.credentials.find((c) => c.id === id);
      if (!cred) throw new Error('Credencial no encontrada.');
      cred.policy = policy;
      emit({ type: 'vault.changed' });
      return cred;
    },
    'vault.deleteCredential': (id) => {
      state.credentials = state.credentials.filter((c) => c.id !== id);
      return vaultChanged();
    },
    'vault.wipeAll': async () => {
      await sleep(800);
      abortAssistant();
      for (const id of state.procedures.keys()) {
        cancelRun(id);
        emit({ type: 'procedure.deleted', procedureId: id });
      }
      pendingAsks.clear();
      topics.clear();
      state = createDemoState(Date.now(), {
        provider: 'none',
        empty: true,
        onboarding: true,
        lang: state.settings.language,
      });
      state.settings = { ...DEFAULT_SETTINGS, language: state.settings.language };
      emit({ type: 'settings.changed', settings: state.settings });
      emit({ type: 'providers.status', status: state.provider });
      emit({ type: 'vault.changed' });
    },

    // Recording works in the preview (the browser's microphone); the transcript is canned.
    'phoneCall.transcriptionAvailable': () =>
      state.provider.kind === 'voucher' || state.provider.kind === 'chatgpt',
    'phoneCall.transcribe': async () => {
      await sleep(1500);
      return { text: DEMO_CALL_TRANSCRIPT };
    },

    'companion.status': () => {
      requireDniePhone();
      return companion;
    },
    'companion.pair': () => {
      requireDniePhone();
      if (companion.state !== 'off') return companion;
      const expiresAt = new Date(Date.now() + 72 * 3600_000).toISOString();
      setCompanion({ state: 'waiting', link: demoLink, expiresAt });
      if (!freeze)
        void sleep(4000).then(() => {
          if (companion.state === 'waiting')
            setCompanion({ state: 'connected', device: 'Pixel 8', expiresAt });
        });
      return companion;
    },
    'companion.unpair': () => {
      requireDniePhone();
      setCompanion({ state: 'off' });
      return companion;
    },
    'companion.pairAnother': () => {
      requireDniePhone();
      const expiresAt = new Date(Date.now() + 72 * 3600_000).toISOString();
      setCompanion({ state: 'waiting', link: demoLink, expiresAt });
      return companion;
    },
    'companion.unlock': (promptItemId) => {
      requireDniePhone();
      // Like main: the CAN and the PIN are never kept or shown; the card moves on.
      const item = findPrompt(promptItemId);
      if (item?.status !== 'pending' || item.prompt.kind !== 'dnie_signature')
        throw new Error(
          tr('Esta pregunta ya no está pendiente.', 'This question is no longer pending.'),
        );
      const { unlock: _unlock, ...prompt } = item.prompt;
      const next = { ...item, prompt: { ...prompt, stage: 'phone' as const } };
      if (item.procedureId)
        setCardPrompts(
          item.procedureId,
          cardPrompts(item.procedureId).map((i) => (i.id === item.id ? next : i)),
        );
      else putChat(next);
    },
    'media.get': (id) => state.media.get(id) ?? null,
    'browser.show': () => {
      if (params.has('playground'))
        toast.info(tr('Ventana del navegador de ejemplo', 'Example browser window'));
    },
  };

  // Keep the "live" demo moving: the padrón agent is reading the town hall's page.
  if (!freeze && state.procedures.get(DEMO_IDS.padron)?.runtime.activity === 'working') {
    window.setTimeout(() => {
      if (state.procedures.has(DEMO_IDS.padron))
        void runProcedure(DEMO_IDS.padron, padronLiveScript(lang()));
    }, 300);
  }

  return {
    async invoke<M extends SaMethod>(method: M, ...args: SaArgs<M>): Promise<SaResult<M>> {
      if (latency > 0) await new Promise((r) => window.setTimeout(r, latency));
      const handler = handlers[method] as unknown as (
        ...a: SaArgs<M>
      ) => SaResult<M> | Promise<SaResult<M>>;
      if (!handler) throw new Error(`Mock: método desconocido ${String(method)}`);
      return clone(await handler(...args));
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
