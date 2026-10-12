import type { DnieSignaturePrompt, DnieSignatureStage, PromptItem } from '@sa/shared';
import {
  IdCard,
  Loader2,
  type LucideIcon,
  Nfc,
  ScanEye,
  Signature,
  Smartphone,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { useT } from '../../../i18n';
import { api, errorMessage } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { useAppStore } from '../../../store/app';
import { toast } from '../../../store/toast';
import { companionDict } from '../../companion/i18n';
import { PairingPanel } from '../../companion/PairingPanel';
import { chatDict } from '../i18n';
import { Markdown } from '../Markdown';
import { PromptShell } from './PromptShell';

const STAGE_ICON: Record<DnieSignatureStage, LucideIcon> = {
  phone: Smartphone,
  reviewing: ScanEye,
  card: Nfc,
  reading: IdCard,
  signing: Signature,
};

/**
 * A signature with the DNIe in the paired phone. The phone asks for consent and the PIN (unless
 * the request carries the saved one); this card shows the QR code until a phone is connected,
 * then the phone's progress, and can only cancel.
 */
export function DnieSignaturePromptCard({
  item,
  prompt,
  embedded,
}: {
  item: PromptItem;
  prompt: DnieSignaturePrompt;
  embedded?: boolean;
}) {
  const t = useT(chatDict);
  const tc = useT(companionDict);
  const companion = useAppStore((s) => s.companion);
  const [busy, setBusy] = useState(false);
  const login = prompt.purpose === 'login';
  const connected = companion.state === 'connected';
  const StageIcon = STAGE_ICON[prompt.stage];
  const working = prompt.stage === 'reading' || prompt.stage === 'signing';
  // The phone asks for the PIN while reviewing, except for certificate reads and a saved PIN.
  const hint = login
    ? tc.login.hint
    : prompt.stage === 'reviewing' && prompt.purpose === 'certificate'
      ? tc.reviewingNoPin.certificate
      : prompt.stage === 'reviewing' && prompt.savedPin
        ? tc.reviewingNoPin.savedPin
        : tc.stageHint[prompt.stage];

  const cancel = async () => {
    setBusy(true);
    try {
      await api.invoke('chat.respond', item.id, { kind: 'dnie_signature', outcome: 'cancelled' });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const outcome = item.response?.kind === 'dnie_signature' ? item.response.outcome : undefined;

  return (
    <PromptShell
      item={item}
      icon={IdCard}
      kicker={`${login ? t.prompt.confirmKind.credential : t.prompt.confirmKind.signature} · ${t.prompt.needsYou.toLowerCase()}`}
      title={prompt.title}
      embedded={embedded}
      answeredSummary={
        outcome ? (
          <span
            className={cn(
              'font-medium',
              outcome === 'signed' ? 'text-st-done-fg' : 'text-fg-muted',
            )}
          >
            {outcome === 'signed'
              ? login
                ? tc.login.finished
                : tc.signed
              : outcome === 'failed'
                ? login
                  ? tc.login.failed
                  : tc.failed
                : login
                  ? tc.login.cancelled
                  : tc.cancelledByUser}
          </span>
        ) : null
      }
    >
      <Markdown text={prompt.message} className="text-[14px] text-fg" />

      <div className="mt-4 rounded-xl border border-line bg-surface-2/60 p-4">
        {connected ? (
          <div
            className="flex items-start gap-3"
            data-testid="dnie-stage"
            data-stage={prompt.stage}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-st-attention-bg text-st-attention-fg">
              {working ? (
                <Loader2 size={19} className="animate-spin" aria-hidden />
              ) : (
                <StageIcon size={19} aria-hidden />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14.5px] font-semibold text-fg">
                {login && (prompt.stage === 'reviewing' || prompt.stage === 'signing')
                  ? tc.login[prompt.stage]
                  : tc.stage[prompt.stage]}
              </p>
              <p className="mt-0.5 text-[13px] text-fg-muted">{hint}</p>
              <p className="mt-2 text-[12.5px] text-fg-subtle">
                {tc.connected(companion.device ?? tc.app)}
              </p>
            </div>
          </div>
        ) : (
          <PairingPanel status={companion} />
        )}
      </div>

      {prompt.details?.length ? (
        <dl className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-2/60">
          {prompt.details.map((d) => (
            <div
              key={d.label}
              className="grid grid-cols-[minmax(110px,34%)_1fr] gap-3 px-3.5 py-2.5 text-[13.5px]"
            >
              <dt className="text-fg-subtle">{d.label}</dt>
              <dd className="selectable font-medium whitespace-pre-line text-fg">{d.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="mt-5 flex justify-end">
        <Button
          variant="secondary"
          onClick={() => void cancel()}
          loading={busy}
          disabled={busy}
          data-testid="dnie-cancel"
        >
          {tc.cancel}
        </Button>
      </div>
    </PromptShell>
  );
}
