import type { ProcedureListItem } from '@sa/shared';
import { create } from 'zustand';

interface ProceduresState {
  loaded: boolean;
  byId: Record<string, ProcedureListItem>;
  setAll: (list: ProcedureListItem[]) => void;
  upsert: (procedure: ProcedureListItem) => void;
  remove: (id: string) => void;
}

export const useProcedureStore = create<ProceduresState>()((set) => ({
  loaded: false,
  byId: {},
  setAll: (list) => set({ loaded: true, byId: Object.fromEntries(list.map((p) => [p.id, p])) }),
  upsert: (procedure) => set((s) => ({ byId: { ...s.byId, [procedure.id]: procedure } })),
  remove: (id) =>
    set((s) => {
      if (!(id in s.byId)) return s;
      const byId = { ...s.byId };
      delete byId[id];
      return { byId };
    }),
}));

export function useProcedure(id: string | null | undefined): ProcedureListItem | undefined {
  return useProcedureStore((s) => (id ? s.byId[id] : undefined));
}

// ---------------------------------------------------------------------------------------------
// What a card says at a glance, and the order of the cards
// ---------------------------------------------------------------------------------------------

/**
 * The state a card shows in its pill:
 *  - yourTurn: a question is waiting for the user, or the next step is theirs;
 *  - problem: the procedure's agent hit an error;
 *  - working: its agent is working right now;
 *  - otherwise the procedure's own status.
 */
export type CardState =
  | 'yourTurn'
  | 'problem'
  | 'working'
  | 'researching'
  | 'planned'
  | 'in_progress'
  | 'waiting_admin'
  | 'done'
  | 'blocked'
  | 'cancelled';

const OVER: ReadonlySet<ProcedureListItem['status']> = new Set(['done', 'cancelled']);

export function isOver(p: Pick<ProcedureListItem, 'status'>): boolean {
  return OVER.has(p.status);
}

export function cardState(p: ProcedureListItem): CardState {
  if (p.runtime.activity === 'needs_user') return 'yourTurn';
  if (p.runtime.error) return 'problem';
  if (isOver(p)) return p.status;
  if (p.runtime.activity === 'working')
    return p.status === 'researching' ? 'researching' : 'working';
  if (p.nextAction?.owner === 'user') return 'yourTurn';
  return p.status;
}

const RANK: Record<CardState, number> = {
  yourTurn: 0,
  problem: 1,
  working: 2,
  researching: 2,
  in_progress: 3,
  planned: 3,
  blocked: 3,
  waiting_admin: 4,
  done: 5,
  cancelled: 6,
};

/** Cards that need the user first, then active ones, then finished; most recent first. */
export function orderProcedures(list: ProcedureListItem[]): {
  active: ProcedureListItem[];
  archived: ProcedureListItem[];
} {
  const sorted = [...list].sort(
    (a, b) => RANK[cardState(a)] - RANK[cardState(b)] || b.updatedAt.localeCompare(a.updatedAt),
  );
  return { active: sorted.filter((p) => !p.archived), archived: sorted.filter((p) => p.archived) };
}

export function stepProgress(p: Pick<ProcedureListItem, 'steps'>): { done: number; total: number } {
  const relevant = p.steps.filter((s) => s.status !== 'skipped');
  return { done: relevant.filter((s) => s.status === 'done').length, total: relevant.length };
}
