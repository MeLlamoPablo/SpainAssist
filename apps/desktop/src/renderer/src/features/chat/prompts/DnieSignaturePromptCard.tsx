import {
  type CompanionPhoneApp,
  companionOutdatedSide,
  DniAccessNumber,
  DniePin,
  type DnieSignaturePrompt,
  type DnieSignatureStage,
  type DnieUnlock,
  type PromptItem,
} from '@sa/shared';
import {
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
import { Fragment, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Field, Input, PasswordInput } from '../../../components/ui/field';
import { useT } from '../../../i18n';
import { api, errorMessage } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { useAppStore } from '../../../store/app';
import { toast } from '../../../store/toast';
import { DnieHelp } from '../../companion/DnieHelp';
import { companionDict } from '../../companion/i18n';
import { OutdatedNotice, PairingPanel, PhoneUpdateNotice } from '../../companion/PairingPanel';
import { chatDict } from '../i18n';
import { Markdown } from '../Markdown';
import { PromptShell } from './PromptShell';

/** The stages the phone goes through; `update` comes before them and has its own view. */
type PhoneStage = Exclude<DnieSignatureStage, 'update'>;

const STAGE_ICON: Record<PhoneStage, LucideIcon> = {
  unlock: KeyRound,
  phone: Smartphone,
  reviewing: ScanEye,
  card: Nfc,
  reading: IdCard,
  signing: Signature,
};

/**
 * A signature with the DNIe in the paired phone. When the phone's app is behind the one offered
 * outside Google Play, this card first shows the QR that downloads it and waits: the user
 * updates it or goes on without it. Then it asks for the DNIe's CAN and PIN
 * when the app doesn't have them (and again if the card refuses one): they go straight to main
 * with `companion.unlock`, never into the transcript. Then it shows the QR code until a phone
 * pairs, or asks to open the app on a paired phone that isn't connected (it gets requests only
 * while the app is open), then the phone's progress. The phone asks for consent; here the user can only
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
  const updating = prompt.stage === 'update';
  const stage: PhoneStage = prompt.stage === 'update' ? 'phone' : prompt.stage;
  const StageIcon = STAGE_ICON[stage];
  const working = stage === 'reading' || stage === 'signing';
  const unlock = prompt.stage === 'unlock' ? prompt.unlock : undefined;
  const hint = login
    ? tc.login.hint
    : stage === 'reviewing' && prompt.purpose === 'certificate'
      ? tc.reviewingCertificate
      : tc.stageHint[stage];

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
      {!login && <Markdown text={prompt.message} className="text-[14px] text-fg" />}

      <div className={cn('rounded-xl border border-line bg-surface-2/60 p-4', !login && 'mt-4')}>
        {unlock ? (
          <>
            {/* The request would fail once sent: say why before the user types anything. */}
            {companion.outdated ? (
              <div className="mb-4 flex">
                <OutdatedNotice
                  side={companionOutdatedSide(companion.outdated)}
                  phoneApp={companion.phoneApp}
                />
              </div>
            ) : null}
            <UnlockForm itemId={item.id} unlock={unlock} onCancel={() => void cancel()} />
          </>
        ) : updating ? (
          <PhoneUpdateGate itemId={item.id} phoneApp={companion.phoneApp} />
        ) : connected ? (
          <div className="flex items-start gap-3" data-testid="dnie-stage" data-stage={stage}>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-st-attention-bg text-st-attention-fg">
              {working ? (
                <Loader2 size={19} className="animate-spin" aria-hidden />
              ) : (
                <StageIcon size={19} aria-hidden />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14.5px] font-semibold text-fg">
                {login && (stage === 'reviewing' || stage === 'signing')
                  ? tc.login[stage]
                  : tc.stage[stage]}
              </p>
              <p className="mt-0.5 text-[13px] text-fg-muted">{hint}</p>
              <p className="mt-2 text-[12.5px] text-fg-subtle">
                {tc.connected(companion.device ?? tc.app)}
              </p>
            </div>
          </div>
        ) : companion.outdated && !companion.link && companion.state !== 'unavailable' ? (
          // Opening the outdated app won't help: only the update notice (and another phone).
          <OutdatedPhone
            side={companionOutdatedSide(companion.outdated)}
            phoneApp={companion.phoneApp}
          />
        ) : (
          <PairingPanel status={companion} request />
        )}
      </div>

      {prompt.details?.length ? (
        <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[13.5px]">
          {prompt.details.map((d) => (
            <Fragment key={d.label}>
              <dt className="text-fg-subtle">{d.label}</dt>
              <dd className="selectable min-w-0 font-medium break-words whitespace-pre-line text-fg">
                {d.value}
              </dd>
            </Fragment>
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
 * Before anything goes to the phone: its app has a newer version outside Google Play. The QR
 * downloads it, and the request goes on by itself once the updated app connects. "Seguir sin
 * actualizar" goes on now: this update isn't one the phone needs to sign.
 */
function PhoneUpdateGate({ itemId, phoneApp }: { itemId: string; phoneApp?: CompanionPhoneApp }) {
  const tc = useT(companionDict);
  const [busy, setBusy] = useState(false);
  const skip = async () => {
    setBusy(true);
    try {
      await api.invoke('companion.skipUpdate', itemId);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const button = (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void skip()}
      loading={busy}
      disabled={busy}
      data-testid="dnie-update-skip"
    >
      {tc.update.skip}
    </Button>
  );
  return (
    <div data-testid="dnie-update">
      {phoneApp ? (
        <PhoneUpdateNotice phoneApp={phoneApp} action={button} />
      ) : (
        <div className="flex justify-end">{button}</div>
      )}
    </div>
  );
}

/** A paired phone whose app speaks another protocol version: which app to update. */
function OutdatedPhone({
  side,
  phoneApp,
}: {
  side: 'phone' | 'desktop';
  phoneApp?: CompanionPhoneApp;
}) {
  const tc = useT(companionDict);
  const pairAnother = async () => {
    try {
      useAppStore.setState({ companion: await api.invoke('companion.pairAnother') });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="dnie-outdated">
      <OutdatedNotice side={side} phoneApp={phoneApp} />
      {/* Another phone can help only when this one is behind. */}
      {side === 'phone' ? (
        <div>
          <p className="text-[12.5px] text-fg-subtle">{tc.otherPhone}</p>
          <Button
            variant="secondary"
            size="sm"
            icon={Smartphone}
            className="mt-3"
            onClick={() => void pairAnother()}
          >
            {tc.pairOther}
          </Button>
        </div>
      ) : null}
    </div>
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
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-st-attention-bg text-st-attention-fg">
          <KeyRound size={19} aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-[14.5px] font-semibold text-fg">{tc.stage.unlock}</p>
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

      <DnieHelp pin={unlock.pin} />

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
