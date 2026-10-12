import type { ProcedureListItem } from '@sa/shared';
import { Pill, type Tone } from '../../components/ui/misc';
import { useT } from '../../i18n';
import { common } from '../../i18n/common';
import { type CardState, cardState } from '../../store/procedures';

const STATE_TONE: Record<Exclude<CardState, 'yourTurn' | 'working' | 'researching'>, Tone> = {
  problem: 'blocked',
  planned: 'planned',
  in_progress: 'progress',
  waiting_admin: 'waiting',
  done: 'done',
  blocked: 'blocked',
  cancelled: 'neutral',
};

/**
 * "Plan listo", "Completado"… where a procedure stands at a glance. Nothing when it is the
 * user's turn (the highlighted card, its question or its next step already say so) or while
 * its agent works or researches (the spinner strip at the bottom of the card says so).
 */
export function StatePill({
  procedure,
  size = 'md',
}: {
  procedure: ProcedureListItem;
  size?: 'sm' | 'md';
}) {
  const t = useT(common);
  const state = cardState(procedure);
  if (state === 'yourTurn' || state === 'working' || state === 'researching') return null;
  const label = state === 'problem' ? t.problem : t.status[state];
  return (
    <Pill tone={STATE_TONE[state]} dot size={size} className="ring-transparent">
      {label}
    </Pill>
  );
}
