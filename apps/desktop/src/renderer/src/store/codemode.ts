import type { CodemodeAgentInfo, RunInfo } from '@sa/shared';
import { create } from 'zustand';

/**
 * Codemode: the agents behind the progress meter and the runs whose interfaces wait for the
 * user ("Para ti"). Kept from `codemode.state` and its push events.
 */
interface CodemodeState {
  agents: Record<string, CodemodeAgentInfo>;
  runs: Record<string, RunInfo>;
  setAll: (state: { agents: CodemodeAgentInfo[]; runs: RunInfo[] }) => void;
  upsertAgent: (agent: CodemodeAgentInfo) => void;
  upsertRun: (run: RunInfo) => void;
}

export const useCodemodeStore = create<CodemodeState>()((set) => ({
  agents: {},
  runs: {},
  setAll: ({ agents, runs }) =>
    set({
      agents: Object.fromEntries(agents.map((a) => [a.id, a])),
      runs: Object.fromEntries(runs.map((w) => [w.id, w])),
    }),
  upsertAgent: (agent) => set((s) => ({ agents: { ...s.agents, [agent.id]: agent } })),
  upsertRun: (run) =>
    set((s) => {
      // Finished runs with nothing on screen leave the inbox.
      const keep = run.ui.length > 0 || run.status === 'running' || run.status === 'waiting_user';
      const runs = { ...s.runs };
      if (keep) runs[run.id] = run;
      else delete runs[run.id];
      return { runs };
    }),
}));

/** Every open interface, oldest first, with the run it belongs to. */
export function openInterfaces(runs: Record<string, RunInfo>) {
  return Object.values(runs)
    .flatMap((run) => run.ui.map((ui) => ({ run, ui })))
    .sort((a, b) => a.ui.openedAt.localeCompare(b.ui.openedAt));
}
