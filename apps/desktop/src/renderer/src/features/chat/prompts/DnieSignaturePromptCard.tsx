import {
  DniAccessNumber,
  DniePin,
  type DnieSignaturePrompt,
  type DnieSignatureStage,
  type DnieUnlock,
  type PromptItem,
} from '@sa/shared';
import {
  ChevronDown,
  IdCard,
  KeyRound,
  Loader2,
  type LucideIcon,
  Nfc,
  ScanEye,
  Signature,
  Smartphone,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Field, Input, PasswordInput } from '../../../components/ui/field';
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
  unlock: KeyRound,
  phone: Smartphone,
  reviewing: ScanEye,
  card: Nfc,
  reading: IdCard,
  signing: Signature,
};

/**
 * A signature with the DNIe in the paired phone. This card first asks for the DNIe's CAN and PIN
 * when the app doesn't have them (and again if the card refuses one): they go straight to main
 * with `companion.unlock`, never into the transcript. Then it shows the QR code until a phone is
 * connected, then the phone's progress. The phone asks for consent; here the user can only
 * cancel.
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
  const unlock = prompt.stage === 'unlock' ? prompt.unlock : undefined;
  const hint = login
    ? tc.login.hint
    : prompt.stage === 'reviewing' && prompt.purpose === 'certificate'
      ? tc.reviewingCertificate
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
        {unlock ? (
          <UnlockForm itemId={item.id} unlock={unlock} onCancel={() => void cancel()} />
        ) : connected ? (
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

      {unlock ? null : (
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
      )}
    </PromptShell>
  );
}

/**
 * The CAN and/or PIN the request needs, with short help about both. Validated here as main
 * validates them; sent once and cleared.
 */
function UnlockForm({
  itemId,
  unlock,
  onCancel,
}: {
  itemId: string;
  unlock: DnieUnlock;
  onCancel: () => void;
}) {
  const t = useT(chatDict);
  const tc = useT(companionDict);
  const tu = tc.unlock;
  const [can, setCan] = useState('');
  const [pin, setPin] = useState('');
  const [errors, setErrors] = useState<{ can?: string; pin?: string }>({});
  const [busy, setBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const refused =
    unlock.refused === 'can'
      ? tu.canRefused
      : unlock.refused === 'pin'
        ? unlock.triesLeft
          ? tu.pinRefused(unlock.triesLeft)
          : tu.pinRefusedUnknown
        : null;

  const submit = async () => {
    const next = {
      ...(unlock.can && !DniAccessNumber.safeParse(can).success ? { can: tu.canInvalid } : {}),
      ...(unlock.pin && !DniePin.safeParse(pin).success ? { pin: tu.pinInvalid } : {}),
    };
    setErrors(next);
    if (next.can || next.pin) return;
    setBusy(true);
    try {
      await api.invoke('companion.unlock', itemId, {
        ...(unlock.can ? { can } : {}),
        ...(unlock.pin ? { pin } : {}),
      });
      setPin('');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="dnie-unlock"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-st-attention-bg text-st-attention-fg">
          <KeyRound size={19} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-semibold text-fg">{tc.stage.unlock}</p>
          <p className="mt-0.5 text-[13px] text-fg-muted">{tu.lead}</p>
        </div>
      </div>

      {refused ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-st-attention-bg px-3 py-2 text-[13px] font-medium text-st-attention-fg ring-1 ring-st-attention-line ring-inset"
        >
          <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
          {refused}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {unlock.can ? (
          <Field label={tu.can} help={tu.canHelp} error={errors.can} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                value={can}
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                placeholder="000000"
                className="tracking-[0.2em] tabular-nums"
                onChange={(e) => {
                  setCan(e.target.value.replace(/\D/g, ''));
                  setErrors((x) => ({ ...x, can: undefined }));
                }}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                data-testid="dnie-can"
                autoFocus
              />
            )}
          </Field>
        ) : null}
        {unlock.pin ? (
          <Field label={tu.pin} help={tu.pinHelp} error={errors.pin} required>
            {({ id, describedBy, invalid }) => (
              <PasswordInput
                id={id}
                value={pin}
                maxLength={16}
                onChange={(e) => {
                  setPin(e.target.value);
                  setErrors((x) => ({ ...x, pin: undefined }));
                }}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                revealLabel={t.prompt.reveal}
                hideLabel={t.prompt.hide}
                data-testid="dnie-pin"
                autoFocus={!unlock.can}
              />
            )}
          </Field>
        ) : null}
      </div>

      <div className="rounded-lg border border-line bg-surface">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-[13px] font-medium text-fg hover:text-accent"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((o) => !o)}
          data-testid="dnie-unlock-help"
        >
          {unlock.pin ? tu.helpTitle : tu.canHelpTitle}
          <ChevronDown
            size={15}
            className={cn('shrink-0 text-fg-subtle transition-transform', helpOpen && 'rotate-180')}
            aria-hidden
          />
        </button>
        {helpOpen ? (
          <ul className="flex list-disc flex-col gap-1.5 border-t border-line py-3 pr-3 pl-7 text-[13px] text-fg-muted">
            {(unlock.pin ? tu.help : tu.help.slice(-1)).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy} data-testid="dnie-cancel">
          {tc.cancel}
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={busy}>
          {tu.submit}
        </Button>
      </div>
    </form>
  );
}
