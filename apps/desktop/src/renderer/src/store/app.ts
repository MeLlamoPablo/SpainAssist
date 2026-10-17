import type { AppInfo, CompanionStatus, ProviderStatus, Settings, UpdateStatus } from '@sa/shared';
import { create } from 'zustand';

export type VaultTab = 'personal' | 'documents' | 'credentials';
export type SettingsSection = 'provider' | 'general' | 'advanced' | 'about';

/** What the right-hand pane shows. The conversation is always on the left. */
export type View =
  | { kind: 'procedures' }
  | { kind: 'vault'; tab?: VaultTab }
  | { kind: 'settings'; section?: SettingsSection };

interface LoginProgress {
  message: string;
  url?: string;
  /** Device-code logins: the code to type at `url`. */
  userCode?: string;
}

interface AppState {
  ready: boolean;
  /** Fatal error during startup (main process unreachable...). */
  bootError: string | null;
  info: AppInfo | null;
  settings: Settings | null;
  provider: ProviderStatus | null;
  loginProgress: LoginProgress | null;
  /** The phone pairing for DNIe signatures (QR link while no phone is connected). */
  companion: CompanionStatus;
  /** The app's own updates; the must-update screen shows them. */
  updates: UpdateStatus;
  view: View;
  showArchived: boolean;
  /** The procedure card to bring into view and highlight (e.g. from a procedure event in the chat). */
  focusedProcedure: { id: string; tick: number } | null;
  /** Bumped to ask the chat composer to take focus (e.g. ⌘N). */
  composerFocusTick: number;
  /** Text to put in the composer (suggestions). */
  draft: { text: string; tick: number } | null;

  navigate: (view: View) => void;
  setShowArchived: (show: boolean) => void;
  /** Show a procedure's card in "Mis trámites". */
  focusProcedure: (id: string) => void;
  focusComposer: (text?: string) => void;
}

export const useAppStore = create<AppState>()((set) => ({
  ready: false,
  bootError: null,
  info: null,
  settings: null,
  provider: null,
  loginProgress: null,
  companion: { state: 'off' },
  updates: { state: 'unsupported' },
  view: { kind: 'procedures' },
  showArchived: false,
  focusedProcedure: null,
  composerFocusTick: 0,
  draft: null,

  navigate: (view) => set({ view, focusedProcedure: null }),
  setShowArchived: (showArchived) => set({ showArchived }),
  focusProcedure: (id) =>
    set((s) => ({
      view: { kind: 'procedures' },
      focusedProcedure: { id, tick: (s.focusedProcedure?.tick ?? 0) + 1 },
    })),
  focusComposer: (text) =>
    set((s) => ({
      composerFocusTick: s.composerFocusTick + 1,
      ...(text !== undefined ? { draft: { text, tick: (s.draft?.tick ?? 0) + 1 } } : {}),
    })),
}));
