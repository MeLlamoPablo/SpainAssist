import type { CodemodeAgentInfo, WorkflowInfo } from '@sa/shared';
import { create } from 'zustand';

/**
 * Codemode (`codemode` flag): the agents behind the progress meter and the workflows whose
 * interfaces wait for the user ("Para ti"). Kept from `codemode.state` and its push events.
 */
interface CodemodeState {
  agents: Record<string, CodemodeAgentInfo>;
  workflows: Record<string, WorkflowInfo>;
  setAll: (state: { agents: CodemodeAgentInfo[]; workflows: WorkflowInfo[] }) => void;
  upsertAgent: (agent: CodemodeAgentInfo) => void;
  upsertWorkflow: (workflow: WorkflowInfo) => void;
}

export const useCodemodeStore = create<CodemodeState>()((set) => ({
  agents: {},
  workflows: {},
  setAll: ({ agents, workflows }) =>
    set({
      agents: Object.fromEntries(agents.map((a) => [a.id, a])),
      workflows: Object.fromEntries(workflows.map((w) => [w.id, w])),
    }),
  upsertAgent: (agent) => set((s) => ({ agents: { ...s.agents, [agent.id]: agent } })),
  upsertWorkflow: (workflow) =>
    set((s) => {
      // Finished workflows with nothing on screen leave the inbox.
      const keep =
        workflow.ui.length > 0 ||
        workflow.status === 'running' ||
        workflow.status === 'waiting_user';
      const workflows = { ...s.workflows };
      if (keep) workflows[workflow.id] = workflow;
      else delete workflows[workflow.id];
      return { workflows };
    }),
}));

/** Every open interface, oldest first, with the workflow it belongs to. */
export function openInterfaces(workflows: Record<string, WorkflowInfo>) {
  return Object.values(workflows)
    .flatMap((workflow) => workflow.ui.map((ui) => ({ workflow, ui })))
    .sort((a, b) => a.ui.openedAt.localeCompare(b.ui.openedAt));
}
