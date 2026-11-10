import type { ProcedureListItem } from '@sa/shared';
import { Pill, type Tone } from '../../components/ui/misc';
import { useT } from '../../i18n';
import { common } from '../../i18n/common';
import { type CardState, cardState } from '../../store/procedures';

/** The states a card says in words; the others show in what it asks of the user. */
const STATE_TONE: Partial<Record<CardState, Tone>> = {
  problem: 'blocked',
  done: 'done',
  blocked: 'blocked',
  cancelled: 'neutral',
};

/**
 * "Completado", "Bloqueado"… how a procedure ended or why it stopped. Nothing while it is under
 * way: the right side of the card (the next step, what is missing, its questions) says where it
 * stands, and the agent meter says what is being done.
 */
export function OutcomePill({
  procedure,
  size = 'md',
}: {
  procedure: ProcedureListItem;
  size?: 'sm' | 'md';
}) {
  const t = useT(common);
  const state = cardState(procedure);
  const tone = STATE_TONE[state];
  if (!tone || state === 'yourTurn' || state === 'working' || state === 'researching') return null;
  const label = state === 'problem' ? t.problem : t.status[state];
  return (
    <Pill tone={tone} dot size={size} className="ring-transparent">
      {label}
    </Pill>
  );
}
