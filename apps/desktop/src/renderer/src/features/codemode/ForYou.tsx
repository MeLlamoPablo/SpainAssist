import type { PromptItem, WorkflowInfo, WorkflowUi } from '@sa/shared';
import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ErrorBoundary, Unshowable } from '../../components/ErrorBoundary';
import { useT } from '../../i18n';
import { openInterfaces, useCodemodeStore } from '../../store/codemode';
import { useProcedureStore } from '../../store/procedures';
import { PromptCard } from '../chat/ChatItems';
import { describeFailure, reportUiFailure } from './failures';
import { codemodeDict } from './i18n';
import { UiRenderer } from './UiRenderer';

export type ForYouEntry =
  | { kind: 'prompt'; id: string; at: string; item: PromptItem }
  | { kind: 'ui'; id: string; at: string; workflow: WorkflowInfo; ui: WorkflowUi };

/**
 * "Para ti" (no heading on screen): everything that waits for the user, in one place at the top
 * of their procedures, oldest first. Questions of agents (the classic harness's forms, approvals,
 * requests) and interfaces of workflows (codemode). Questions are not tied to procedures: none says which
 * procedure it is for, and cards don't point to them. A question says what it is about in its own
 * words (docs/codemode.md, decision 5).
 */
export function ForYou() {
  const t = useT(codemodeDict);
  const prompts = useProcedureStore(
    useShallow((s) =>
      Object.values(s.byId).flatMap((p) =>
        (p.runtime.prompts ?? []).filter((i) => i.status === 'pending'),
      ),
    ),
  );
  const workflows = useCodemodeStore((s) => s.workflows);
  const entries = useMemo<ForYouEntry[]>(() => {
    const list: ForYouEntry[] = [
      ...prompts.map(
        (item): ForYouEntry => ({ kind: 'prompt', id: item.id, at: item.createdAt, item }),
      ),
      ...openInterfaces(workflows).map(
        ({ workflow, ui }): ForYouEntry => ({
          kind: 'ui',
          id: `${workflow.id}/${ui.key}`,
          at: ui.openedAt,
          workflow,
          ui,
        }),
      ),
    ];
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }, [prompts, workflows]);

  if (!entries.length) return null;
  return (
    <section aria-label={t.forYou} className="flex flex-col gap-3 pt-6 pb-2" data-testid="for-you">
      {entries.map((entry) => (
        <ForYouItem key={entry.id} entry={entry} />
      ))}
    </section>
  );
}

/** One question's box (the agent playground shows them too). */
export const ForYouItem = memo(function ForYouItem({ entry }: { entry: ForYouEntry }) {
  const t = useT(codemodeDict);
  return (
    <article
      className="animate-slide-up overflow-hidden rounded-2xl border border-st-attention-line bg-surface px-6 pt-5 pb-6 shadow-raised"
      data-testid={entry.kind === 'ui' ? 'for-you-ui' : 'for-you-prompt'}
    >
      <ErrorBoundary
        // A new tree from the workflow (or a changed prompt) may render.
        resetKeys={entry.kind === 'prompt' ? [entry.item] : [entry.workflow.id, entry.ui.rev]}
        fallback={
          <Unshowable what="question">{entry.kind === 'ui' ? t.unshowable : null}</Unshowable>
        }
        // Its nodes report what failed (UiRenderer); this is for what fails around them.
        onError={(error) => {
          if (entry.kind === 'ui')
            reportUiFailure(
              entry.workflow.id,
              entry.ui.key,
              entry.ui.rev,
              describeFailure(undefined, error),
            );
        }}
      >
        {entry.kind === 'prompt' ? (
          <PromptCard item={entry.item} embedded />
        ) : entry.ui.tree ? (
          <UiRenderer
            workflowId={entry.workflow.id}
            uiKey={entry.ui.key}
            tree={entry.ui.tree}
            rev={entry.ui.rev}
          />
        ) : null}
      </ErrorBoundary>
    </article>
  );
});
