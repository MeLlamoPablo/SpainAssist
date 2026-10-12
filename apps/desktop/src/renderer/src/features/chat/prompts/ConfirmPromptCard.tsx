import type { ConfirmKind, ConfirmPrompt, PromptItem } from '@sa/shared';
import {
  Check,
  CreditCard,
  FingerprintPattern,
  Hand,
  KeyRound,
  type LucideIcon,
  Send,
  Signature,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { useT } from '../../../i18n';
import { api, errorMessage } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { toast } from '../../../store/toast';
import { chatDict } from '../i18n';
import { Markdown } from '../Markdown';
import { PromptShell } from './PromptShell';

const ICON: Record<ConfirmKind, LucideIcon> = {
  action: Hand,
  submission: Send,
  payment: CreditCard,
  credential: KeyRound,
  signature: Signature,
};

export function ConfirmPromptCard({
  item,
  prompt,
  embedded,
}: {
  item: PromptItem;
  prompt: ConfirmPrompt;
  /** Shown on the procedure's card. */
  embedded?: boolean;
}) {
  const t = useT(chatDict);
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);

  const respond = async (approved: boolean) => {
    setBusy(approved ? 'yes' : 'no');
    try {
      await api.invoke('chat.respond', item.id, { kind: 'confirm', approved });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const approved = item.response?.kind === 'confirm' ? item.response.approved : undefined;

  return (
    <PromptShell
      item={item}
      icon={ICON[prompt.confirmKind]}
      kicker={`${t.prompt.confirmKind[prompt.confirmKind]} · ${t.prompt.needsYou.toLowerCase()}`}
      title={prompt.title}
      danger={prompt.danger}
      embedded={embedded}
      answeredSummary={
        approved === undefined ? null : (
          <span className={cn('font-medium', approved ? 'text-st-done-fg' : 'text-fg-muted')}>
            {approved ? t.prompt.approved : t.prompt.rejected}
          </span>
        )
      }
    >
      <Markdown text={prompt.message} className="text-[14px] text-fg" />

      {prompt.details?.length ? (
        <dl className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-2/60">
          {prompt.details.map((d) => (
            <div
              key={d.label}
              className="grid grid-cols-[minmax(110px,34%)_1fr] gap-3 px-3.5 py-2.5 text-[13.5px]"
            >
              <dt className="text-fg-subtle">{d.label}</dt>
              <dd className="selectable font-medium text-fg">{d.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {prompt.danger ? (
        <p className="mt-4 flex items-center gap-2 text-[13px] font-medium text-st-blocked-fg">
          <TriangleAlert size={15} aria-hidden />
          {t.prompt.irreversible}
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        {prompt.biometric ? (
          <span className="flex items-center gap-2 text-[12.5px] text-fg-muted">
            <FingerprintPattern size={16} className="text-accent-text" aria-hidden />
            {t.prompt.biometric}
          </span>
        ) : (
          <span />
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => void respond(false)}
            loading={busy === 'no'}
            disabled={busy !== null}
          >
            {prompt.rejectLabel ?? t.prompt.reject}
          </Button>
          <Button
            variant={prompt.danger ? 'danger' : 'primary'}
            icon={Check}
            onClick={() => void respond(true)}
            loading={busy === 'yes'}
            disabled={busy !== null}
            data-testid="confirm-approve"
          >
            {prompt.confirmLabel ?? t.prompt.approve}
          </Button>
        </div>
      </div>
    </PromptShell>
  );
}
