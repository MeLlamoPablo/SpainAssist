import type { CompanionStatus, SaEvent } from '@sa/shared';
import { api } from '../lib/api';
import { useAppStore } from './app';
import { useChatStore } from './chat';
import { useProcedureStore } from './procedures';
import { useVaultStore } from './vault';

/** Applies one push event from main to the stores. Exported for tests. */
function applyEvent(event: SaEvent): void {
  switch (event.type) {
    case 'procedure.upserted':
      useProcedureStore.getState().upsert(event.procedure);
      return;
    case 'procedure.deleted':
      useProcedureStore.getState().remove(event.procedureId);
      return;
    case 'chat.item':
      useChatStore.getState().applyItem(event.item);
      return;
    case 'chat.delta':
      useChatStore.getState().applyDelta(event.itemId, event.delta);
      return;
    case 'chat.state':
      useChatStore.getState().setState(event.state);
      return;
    case 'providers.status':
      useAppStore.setState({ provider: event.status });
      return;
    case 'providers.loginProgress':
      useAppStore.setState({
        loginProgress: { message: event.message, url: event.url, userCode: event.userCode },
      });
      return;
    case 'vault.changed':
      scheduleVaultReload();
      return;
    case 'settings.changed':
      useAppStore.setState({ settings: event.settings });
      return;
    case 'companion.changed':
      useAppStore.setState({ companion: event.status });
      return;
    case 'updates.status':
      useAppStore.setState({ updates: event.status });
      return;
  }
}

let vaultTimer: number | undefined;
function scheduleVaultReload(): void {
  window.clearTimeout(vaultTimer);
  vaultTimer = window.setTimeout(() => void reloadVault(), 120);
}

export async function reloadVault(): Promise<void> {
  try {
    useVaultStore.getState().set(await api.invoke('vault.overview'));
  } catch {
    // Keep the previous overview; screens show their own errors on actions.
  }
}

export async function reloadProcedures(): Promise<void> {
  useProcedureStore.getState().setAll(await api.invoke('procedures.list'));
}

/** Subscribe to main's events and load the initial state. */
export async function startSync(): Promise<() => void> {
  const unsubscribe = api.on(applyEvent);
  const appInfo = api.invoke('app.info');
  const [info, settings, provider, procedures, state, companion, updates, dataImport] =
    await Promise.all([
      appInfo,
      api.invoke('settings.get'),
      api.invoke('providers.status'),
      api.invoke('procedures.list'),
      api.invoke('chat.state'),
      // Without the DNIe feature flag, main refuses the pairing calls.
      appInfo.then((i): Promise<CompanionStatus> | CompanionStatus =>
        i.features.dniePhone ? api.invoke('companion.status') : { state: 'unavailable' },
      ),
      api.invoke('updates.status'),
      api.invoke('dataImport.status'),
    ]);
  document.documentElement.dataset.platform = info.platform;
  useProcedureStore.getState().setAll(procedures);
  useChatStore.getState().setState(state);
  useAppStore.setState({
    info,
    settings,
    provider,
    companion,
    updates,
    dataImport,
    ready: true,
  });
  void reloadVault();
  void loadConversation();
  return unsubscribe;
}

/** Load (or refresh) the conversation. */
export async function loadConversation(): Promise<void> {
  const chat = useChatStore.getState();
  chat.setConversation({ status: 'loading', items: [] });
  try {
    const items = await api.invoke('chat.transcript');
    useChatStore.getState().setConversation({ status: 'loaded', items });
  } catch {
    useChatStore.getState().setConversation({ status: 'error', items: [] });
  }
}
