import { useEffect } from 'react';
import { useAppStore, type View } from '../../store/app';
import { ChatPanel } from '../chat/ChatPanel';
import { ProceduresView } from '../procedures/ProceduresView';
import { SettingsView } from '../settings/SettingsView';
import { VaultView } from '../vault/VaultView';
import { TopBar } from './TopBar';

/**
 * The whole app: the one conversation with the assistant on the left; procedures, the user's
 * data and settings on the right.
 */
export function Shell() {
  const view = useAppStore((s) => s.view);
  useShortcuts();

  return (
    <div className="flex h-full min-w-[960px]">
      <ChatPanel />
      <main className="@container relative flex min-w-0 flex-1 flex-col bg-surface">
        <TopBar />
        <div className="min-h-0 flex-1 overflow-y-auto" id="pane-scroll" data-scroll-stable>
          {view.kind === 'procedures' ? <ProceduresView /> : null}
          {view.kind === 'vault' ? <VaultView initialTab={view.tab} /> : null}
          {view.kind === 'settings' ? <SettingsView section={view.section} /> : null}
        </div>
      </main>
    </div>
  );
}

const TAB_KEYS: Record<string, View> = {
  '1': { kind: 'procedures' },
  '2': { kind: 'vault' },
  '3': { kind: 'settings' },
  ',': { kind: 'settings' },
};

/** ⌘N / Ctrl+N: write to the assistant. ⌘1–3: tabs. ⌘, / Ctrl+,: settings. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      if (e.key === 'n') {
        e.preventDefault();
        useAppStore.getState().focusComposer();
        return;
      }
      const view = TAB_KEYS[e.key];
      if (view) {
        e.preventDefault();
        useAppStore.getState().navigate(view);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
