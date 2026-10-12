import type { CredentialSummary, DocumentMeta, PersonalDataItem, VaultOverview } from '@sa/shared';
import { create } from 'zustand';

const NO_DOCUMENTS: DocumentMeta[] = [];
const NO_PERSONAL: PersonalDataItem[] = [];
const NO_CREDENTIALS: CredentialSummary[] = [];

interface VaultState {
  overview: VaultOverview | null;
  set: (overview: VaultOverview) => void;
}

export const useVaultStore = create<VaultState>()((set) => ({
  overview: null,
  set: (overview) => set({ overview }),
}));

/** Stable selectors (never return a fresh array: zustand would re-render forever). */
export const useDocuments = () => useVaultStore((s) => s.overview?.documents ?? NO_DOCUMENTS);
export const usePersonal = () => useVaultStore((s) => s.overview?.personal ?? NO_PERSONAL);
export const useCredentials = () => useVaultStore((s) => s.overview?.credentials ?? NO_CREDENTIALS);
