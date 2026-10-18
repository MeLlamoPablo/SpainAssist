import {
  type CredentialPolicy,
  type CredentialSummary,
  companionOutdatedSide,
  DniePin,
  type VaultOverview,
} from '@sa/shared';
import {
  FileKey,
  IdCard,
  KeyRound,
  type LucideIcon,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button, IconButton } from '../../components/ui/button';
import { SegmentedControl } from '../../components/ui/controls';
import { ConfirmDialog, Dialog } from '../../components/ui/dialog';
import { Field, Input, PasswordInput } from '../../components/ui/field';
import { Card, Pill } from '../../components/ui/misc';
import { useLang, useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { pickFiles, readFileBytes } from '../../lib/files';
import { daysUntil, formatLongDate, formatRelative } from '../../lib/format';
import { useAppStore } from '../../store/app';
import { reloadVault } from '../../store/sync';
import { toast } from '../../store/toast';
import { usePersonal, useVaultStore } from '../../store/vault';
import { chatDict } from '../chat/i18n';
import { companionDict } from '../companion/i18n';
import { PairingPanel } from '../companion/PairingPanel';
import { vaultDict } from './i18n';
import { SectionIntro } from './VaultView';

export function CredentialsSection({ overview }: { overview: VaultOverview }) {
  const t = useT(vaultDict);
  const [claveOpen, setClaveOpen] = useState(false);
  const [certOpen, setCertOpen] = useState(false);
  const [movilBusy, setMovilBusy] = useState(false);
  const [dnieBusy, setDnieBusy] = useState(false);
  const clave = overview.credentials.find((c) => c.kind === 'clave_permanente');
  const movil = overview.credentials.find((c) => c.kind === 'clave_movil');
  const certs = overview.credentials.filter((c) => c.kind === 'certificate');
  // DNIe with the phone is behind a feature flag (main hides a saved one without it, too).
  const dniePhone = useAppStore((s) => s.info?.features.dniePhone ?? false);
  const dnie = overview.credentials.find((c) => c.kind === 'dnie');
  const biometric = overview.storage.biometricAvailable;

  const addMovil = async () => {
    setMovilBusy(true);
    try {
      await api.invoke('vault.addClaveMovil');
      await reloadVault();
      toast.success(t.credentials.movil.saved);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setMovilBusy(false);
    }
  };

  const addDnie = async () => {
    setDnieBusy(true);
    try {
      await api.invoke('vault.addDnie');
      await reloadVault();
      toast.success(t.credentials.dnie.saved);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDnieBusy(false);
    }
  };

  return (
    <div>
      <SectionIntro lead={t.credentials.lead} />
      <div className="flex flex-col gap-4">
        {/* Cl@ve Permanente */}
        {clave ? (
          <CredentialCard
            credential={clave}
            icon={KeyRound}
            title={t.credentials.clave.title}
            biometric={biometric}
          >
            <Meta label={t.credentials.clave.user} value={clave.usernameHint ?? '•••••'} mono />
          </CredentialCard>
        ) : (
          <AddCard
            icon={KeyRound}
            title={t.credentials.clave.title}
            body={t.credentials.clave.what}
            action={
              <Button variant="secondary" icon={Plus} onClick={() => setClaveOpen(true)}>
                {t.credentials.clave.add}
              </Button>
            }
          />
        )}

        {/* Cl@ve Móvil */}
        {movil ? (
          <CredentialCard
            credential={movil}
            icon={Smartphone}
            title={t.credentials.movil.title}
            biometric={biometric}
          >
            <p className="text-[13px] text-fg-muted">{t.credentials.movil.active}</p>
          </CredentialCard>
        ) : (
          <AddCard
            icon={Smartphone}
            title={t.credentials.movil.title}
            body={`${t.credentials.movil.what} ${t.credentials.movil.hasHint}`}
            action={
              <Button
                variant="secondary"
                icon={ShieldCheck}
                loading={movilBusy}
                onClick={() => void addMovil()}
              >
                {t.credentials.movil.has}
              </Button>
            }
          />
        )}

        {/* DNIe, read by the phone */}
        {!dniePhone ? null : dnie ? (
          <DnieCard credential={dnie} biometric={biometric} />
        ) : (
          <AddCard
            icon={IdCard}
            title={t.credentials.dnie.title}
            body={t.credentials.dnie.what}
            action={
              <Button
                variant="secondary"
                icon={ShieldCheck}
                loading={dnieBusy}
                onClick={() => void addDnie()}
              >
                {t.credentials.dnie.has}
              </Button>
            }
          />
        )}

        {/* Certificates */}
        {certs.map((cert) => (
          <CertificateCard key={cert.id} credential={cert} biometric={biometric} />
        ))}
        {certs.length === 0 ? (
          <AddCard
            icon={FileKey}
            title={t.credentials.cert.title}
            body={t.credentials.cert.what}
            action={
              <Button variant="secondary" icon={Plus} onClick={() => setCertOpen(true)}>
                {t.credentials.cert.add}
              </Button>
            }
          />
        ) : (
          <div>
            <Button variant="ghost" icon={Plus} onClick={() => setCertOpen(true)}>
              {t.credentials.cert.another}
            </Button>
          </div>
        )}
      </div>
      <ClaveDialog open={claveOpen} onOpenChange={setClaveOpen} />
      <CertificateDialog open={certOpen} onOpenChange={setCertOpen} />
    </div>
  );
}

function AddCard({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-xl border border-dashed border-line-strong bg-surface-2/50 px-5 py-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-3 text-fg-subtle">
        <Icon size={19} aria-hidden />
      </span>
      <div className="min-w-[220px] flex-1">
        <p className="text-[14.5px] font-semibold text-fg">{title}</p>
        <p className="mt-0.5 text-[13px] text-fg-muted">{body}</p>
      </div>
      {action}
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] font-medium text-fg-subtle">{label}</dt>
      <dd
        className={cn(
          'mt-0.5 truncate text-[13.5px] font-medium text-fg',
          mono && 'tracking-wider tabular-nums',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function CredentialCard({
  credential: c,
  icon: Icon,
  title,
  biometric,
  children,
  warning,
  below,
}: {
  credential: CredentialSummary;
  icon: LucideIcon;
  title: string;
  biometric: boolean;
  children?: ReactNode;
  warning?: ReactNode;
  /** Shown under the details (e.g. the DNIe's phone pairing). */
  below?: ReactNode;
}) {
  const t = useT(vaultDict);
  const tc = useT(common);
  const lang = useLang();
  const [confirm, setConfirm] = useState(false);
  const [policy, setPolicy] = useState<CredentialPolicy>(c.policy);
  useEffect(() => setPolicy(c.policy), [c.policy]);

  const changePolicy = async (next: CredentialPolicy) => {
    const prev = policy;
    setPolicy(next);
    try {
      await api.invoke('vault.setCredentialPolicy', c.id, next);
      await reloadVault();
      toast.success(t.credentials.policySaved);
    } catch (err) {
      setPolicy(prev);
      toast.error(errorMessage(err));
    }
  };

  const remove = async () => {
    try {
      useVaultStore.getState().set(await api.invoke('vault.deleteCredential', c.id));
      toast.success(t.credentials.deleted);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card className="overflow-hidden" data-testid={`credential-${c.kind}`}>
      <div className="flex items-start gap-4 px-5 pt-4 pb-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-st-done-bg text-st-done-fg">
          <Icon size={19} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[14.5px] font-semibold text-fg">{title}</p>
            {c.label !== title ? (
              <span className="text-[13px] text-fg-subtle">· {c.label}</span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[12.5px] text-fg-subtle">
            {c.lastUsedAt
              ? t.credentials.lastUsed(formatRelative(c.lastUsedAt, lang))
              : t.credentials.neverUsed}
          </p>
          {children ? (
            <dl className="mt-3 grid grid-cols-1 gap-3 @min-[720px]:grid-cols-3">{children}</dl>
          ) : null}
          {warning}
          {below}
        </div>
        <IconButton
          icon={Trash}
          label={`${t.credentials.remove} ${title}`}
          onClick={() => setConfirm(true)}
        />
      </div>
      {/* Cl@ve Móvil and the DNIe are always approved on the phone. */}
      {c.kind !== 'clave_movil' && c.kind !== 'dnie' ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-2/60 px-5 py-3">
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold text-fg">{t.credentials.policy}</p>
            <p className="text-[12.5px] text-fg-muted">
              {policy === 'auto'
                ? t.credentials.autoHint
                : biometric
                  ? t.credentials.askHintBio
                  : t.credentials.askHint}
            </p>
          </div>
          <SegmentedControl
            label={`${t.credentials.policy}: ${title}`}
            value={policy}
            onValueChange={(v) => void changePolicy(v)}
            options={[
              { value: 'auto', label: t.credentials.auto },
              { value: 'ask', label: t.credentials.ask },
            ]}
          />
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t.credentials.deleteTitle(title)}
        description={t.credentials.deleteBody}
        confirmLabel={tc.delete}
        cancelLabel={tc.cancel}
        onConfirm={remove}
      />
    </Card>
  );
}

function CertificateCard({
  credential: c,
  biometric,
}: {
  credential: CredentialSummary;
  biometric: boolean;
}) {
  const t = useT(vaultDict);
  const lang = useLang();
  const info = c.certificate;
  const days = info ? daysUntil(info.validTo) : null;
  const soon = days !== null && days < 30;

  return (
    <CredentialCard
      credential={c}
      icon={FileKey}
      title={t.credentials.cert.title}
      biometric={biometric}
      warning={
        soon && days !== null ? (
          <div
            className={cn(
              'mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px] font-medium ring-1 ring-inset',
              days < 0
                ? 'bg-st-blocked-bg text-st-blocked-fg ring-st-blocked-line'
                : 'bg-st-attention-bg text-st-attention-fg ring-st-attention-line',
            )}
          >
            <TriangleAlert size={15} className="mt-px shrink-0" aria-hidden />
            {t.credentials.cert.expiresSoon(days)}
          </div>
        ) : null
      }
    >
      {info ? (
        <>
          <Meta label={t.credentials.cert.holder} value={info.holderName ?? info.subject} />
          <Meta label={t.credentials.cert.issuer} value={info.issuer} />
          <Meta
            label={t.credentials.cert.validTo}
            value={
              <span className="flex items-center gap-2">
                {formatLongDate(info.validTo, lang)}
                {days !== null && days < 0 ? (
                  <Pill tone="blocked" size="sm">
                    {t.credentials.cert.expired}
                  </Pill>
                ) : null}
              </span>
            }
          />
        </>
      ) : null}
    </CredentialCard>
  );
}

function DnieCard({
  credential: c,
  biometric,
}: {
  credential: CredentialSummary;
  biometric: boolean;
}) {
  const t = useT(vaultDict);
  const tc = useT(companionDict);
  const tcommon = useT(common);
  const lang = useLang();
  const companion = useAppStore((s) => s.companion);
  const [pairing, setPairing] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinDelete, setPinDelete] = useState(false);
  const info = c.certificate;
  const connected = companion.state === 'connected';
  const paired = connected || companion.state === 'away';
  // Why the last pairing ended, unless the user unpaired here.
  const ended = companion.state === 'off' ? companion.reason : undefined;
  // What keeps the phone from signing now: an app to update, or no relay.
  const problem = companion.outdated
    ? tc.outdated[companionOutdatedSide(companion.outdated)]
    : companion.state === 'connecting' && companion.stalled
      ? tc.stalled
      : undefined;

  const pair = async () => {
    setPairing(true);
    try {
      useAppStore.setState({ companion: await api.invoke('companion.pair') });
    } catch (err) {
      setPairing(false);
      toast.error(errorMessage(err));
    }
  };
  const unpair = async () => {
    try {
      useAppStore.setState({ companion: await api.invoke('companion.unpair') });
      toast.success(tc.unpaired);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const deletePin = async () => {
    try {
      await api.invoke('vault.setDniePin', c.id, null);
      await reloadVault();
      toast.success(t.credentials.dnie.pinDeleted);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <CredentialCard
      credential={c}
      icon={IdCard}
      title={t.credentials.dnie.title}
      biometric={biometric}
      below={
        <>
          <div
            className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2/60 px-3 py-2"
            data-testid="dnie-pin-row"
          >
            <p className="flex min-w-0 items-center gap-2 text-[13px] text-fg-muted">
              <KeyRound
                size={15}
                className={c.hasPin ? 'text-st-done-fg' : 'text-fg-subtle'}
                aria-hidden
              />
              <span className="font-medium text-fg">{t.credentials.dnie.pin}</span>
              {c.hasPin ? t.credentials.dnie.pinSaved : t.credentials.dnie.pinNone}
            </p>
            {c.hasPin ? (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => setPinOpen(true)}>
                  {t.credentials.dnie.pinChange}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setPinDelete(true)}>
                  {t.credentials.dnie.pinRemove}
                </Button>
              </div>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={KeyRound}
                onClick={() => setPinOpen(true)}
              >
                {t.credentials.dnie.pinAdd}
              </Button>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2/60 px-3 py-2">
            <div className="min-w-0">
              <p className="flex min-w-0 items-center gap-2 text-[13px] text-fg-muted">
                <Smartphone
                  size={15}
                  className={
                    connected && !problem
                      ? 'text-st-done-fg'
                      : ended || problem
                        ? 'text-st-attention-fg'
                        : 'text-fg-subtle'
                  }
                  aria-hidden
                />
                {connected
                  ? tc.connected(companion.device ?? tc.app)
                  : companion.state === 'away' && companion.device
                    ? tc.away(companion.device)
                    : tc.noPhone}
              </p>
              {ended ? (
                <p
                  className="mt-0.5 pl-[23px] text-[12.5px] text-fg-subtle"
                  data-testid="companion-ended"
                >
                  {tc.ended[ended]}
                </p>
              ) : problem ? (
                <p
                  className="mt-0.5 pl-[23px] text-[12.5px] text-st-attention-fg"
                  data-testid="companion-problem"
                >
                  {problem}
                </p>
              ) : null}
            </div>
            {companion.state === 'unavailable' ? null : paired ? (
              <Button variant="ghost" size="sm" onClick={() => void unpair()}>
                {tc.unpair}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" icon={Smartphone} onClick={() => void pair()}>
                {tc.pair}
              </Button>
            )}
          </div>
        </>
      }
    >
      {info ? (
        <>
          <Meta label={t.credentials.cert.holder} value={info.holderName ?? info.subject} />
          <Meta label={t.credentials.cert.validTo} value={formatLongDate(info.validTo, lang)} />
        </>
      ) : null}
      <Dialog
        open={pairing}
        onOpenChange={setPairing}
        title={tc.pairTitle}
        description={tc.pairLead}
        closeLabel={tc.done}
        width="lg"
        footer={
          <Button variant={connected ? 'primary' : 'secondary'} onClick={() => setPairing(false)}>
            {tc.done}
          </Button>
        }
      >
        <PairingPanel status={companion} />
      </Dialog>
      <DniePinDialog credentialId={c.id} open={pinOpen} onOpenChange={setPinOpen} />
      <ConfirmDialog
        open={pinDelete}
        onOpenChange={setPinDelete}
        title={t.credentials.dnie.pinDeleteTitle}
        description={t.credentials.dnie.pinDeleteBody}
        confirmLabel={tcommon.delete}
        cancelLabel={tcommon.cancel}
        onConfirm={deletePin}
      />
    </CredentialCard>
  );
}

/** Saves or changes the DNIe PIN. Write-only: main never sends it back. */
function DniePinDialog({
  credentialId,
  open,
  onOpenChange,
}: {
  credentialId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT(vaultDict);
  const tc = useT(common);
  const tu = useT(companionDict).unlock;
  const tchat = useT(chatDict);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = (o: boolean) => {
    if (!o) {
      setPin('');
      setError(null);
    }
    onOpenChange(o);
  };

  const submit = async () => {
    if (!DniePin.safeParse(pin).success) {
      setError(tu.pinInvalid);
      return;
    }
    setBusy(true);
    try {
      await api.invoke('vault.setDniePin', credentialId, pin);
      await reloadVault();
      toast.success(t.credentials.dnie.pinStored);
      close(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t.credentials.dnie.pinDialogTitle}
      description={t.credentials.dnie.pinDialogLead}
      closeLabel={tc.close}
      width="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            {tc.cancel}
          </Button>
          <Button variant="primary" loading={busy} disabled={!pin} onClick={() => void submit()}>
            {t.credentials.dnie.pinSave}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={tu.pin} help={t.credentials.dnie.pinHelp} error={error} required>
          {({ id, describedBy, invalid }) => (
            <PasswordInput
              id={id}
              value={pin}
              onChange={(e) => {
                setPin(e.target.value);
                setError(null);
              }}
              maxLength={16}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              revealLabel={tchat.prompt.reveal}
              hideLabel={tchat.prompt.hide}
              data-testid="dnie-pin-input"
              autoFocus
            />
          )}
        </Field>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

const DNI_NIE = /^([0-9]{8}[A-Z]|[XYZ][0-9]{7}[A-Z])$/;

/** The DNI or NIE saved in Mis datos (e.g. from a scanned document), if any. */
function useSavedDniNie(): string | undefined {
  const personal = usePersonal();
  for (const key of ['dniNumber', 'tieNumber']) {
    const value = personal
      .find((item) => item.key === key)
      ?.value.trim()
      .toUpperCase()
      .replace(/[\s-]/g, '');
    if (value && DNI_NIE.test(value)) return value;
  }
  return undefined;
}

export function ClaveDialog({
  open,
  onOpenChange,
  onSaved,
  replaceId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved?: (credential: CredentialSummary) => void | Promise<void>;
  /** Corrects this saved Cl@ve Permanente (prefilled with its DNI/NIE) instead of adding one. */
  replaceId?: string;
}) {
  const t = useT(vaultDict);
  const tc = useT(common);
  const tchat = useT(chatDict);
  const savedUser = useSavedDniNie();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [knownUser, setKnownUser] = useState<string>();
  useEffect(() => {
    if (!open || !replaceId) return;
    let live = true;
    api
      .invoke('vault.claveUsername', replaceId)
      .then((user) => live && setKnownUser(user))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, replaceId]);
  const prefill = replaceId ? knownUser : savedUser;
  // Its DNI/NIE arrives a moment later when correcting: the password takes the focus anyway.
  const focusPassword = !!(replaceId || savedUser);

  // The DNI/NIE comes prefilled when it is known: the user only types the password.
  useEffect(() => {
    if (open && prefill) setUsername((u) => u || prefill);
  }, [open, prefill]);

  const reset = () => {
    setUsername('');
    setPassword('');
    setError(null);
  };

  const submit = async () => {
    const user = username.trim().toUpperCase().replace(/[\s-]/g, '');
    if (!DNI_NIE.test(user)) {
      setError(t.credentials.clave.invalidUser);
      return;
    }
    if (!password) return;
    setBusy(true);
    try {
      const credential = replaceId
        ? await api.invoke('vault.updateClave', replaceId, { username: user, password })
        : await api.invoke('vault.addClave', { username: user, password });
      await reloadVault();
      await onSaved?.(credential);
      toast.success(replaceId ? t.credentials.clave.fixed : t.credentials.clave.saved);
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={replaceId ? t.credentials.clave.fixTitle : t.credentials.clave.dialogTitle}
      description={t.credentials.clave.dialogLead}
      closeLabel={tc.close}
      width="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {tc.cancel}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!username || !password}
            onClick={() => void submit()}
          >
            {t.credentials.clave.save}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t.credentials.clave.username} error={error} required>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError(null);
              }}
              placeholder="12345678Z"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              className="uppercase tracking-wider"
              autoFocus={!focusPassword}
            />
          )}
        </Field>
        <Field label={t.credentials.clave.password} required>
          {({ id }) => (
            <PasswordInput
              id={id}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              revealLabel={tchat.prompt.reveal}
              hideLabel={tchat.prompt.hide}
              autoFocus={focusPassword}
            />
          )}
        </Field>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

function CertificateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT(vaultDict);
  const tc = useT(common);
  const tchat = useT(chatDict);
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setFile(null);
    setPassphrase('');
    setError(null);
  };

  const choose = async () => {
    const [picked] = await pickFiles('.p12,.pfx,application/x-pkcs12');
    if (picked) {
      setFile(picked);
      setError(null);
    }
  };

  const submit = async () => {
    if (!file || !passphrase) return;
    setBusy(true);
    try {
      await api.invoke('vault.addCertificate', {
        fileName: file.name,
        bytes: await readFileBytes(file),
        passphrase,
      });
      await reloadVault();
      toast.success(t.credentials.cert.saved);
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={t.credentials.cert.dialogTitle}
      description={t.credentials.cert.dialogLead}
      closeLabel={tc.close}
      width="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {tc.cancel}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!file || !passphrase}
            onClick={() => void submit()}
          >
            {t.credentials.cert.save}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg">{t.credentials.cert.file}</span>
          <button
            type="button"
            onClick={() => void choose()}
            className="flex items-center gap-3 rounded-lg border border-dashed border-line-strong bg-surface-2/60 px-3.5 py-3 text-left hover:border-accent-line hover:bg-accent-soft"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-fg-subtle ring-1 ring-line">
              {file ? <FileKey size={17} aria-hidden /> : <Upload size={17} aria-hidden />}
            </span>
            <span className="min-w-0 truncate text-[13.5px] font-medium text-fg">
              {file ? file.name : t.credentials.cert.chooseFile}
            </span>
          </button>
        </div>
        <Field label={t.credentials.cert.password} error={error} required>
          {({ id, describedBy, invalid }) => (
            <PasswordInput
              id={id}
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setError(null);
              }}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              revealLabel={tchat.prompt.reveal}
              hideLabel={tchat.prompt.hide}
            />
          )}
        </Field>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
