import { CERTIFICATE_EXPORT_PASSWORD_MIN } from '@sa/shared';
import { FingerprintPattern, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, PasswordInput } from '../../components/ui/field';
import { useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api, errorMessage } from '../../lib/api';
import { toast } from '../../store/toast';
import { chatDict } from '../chat/i18n';
import { exportDict } from './exportI18n';

export type ExportPasswordIssue = 'short' | 'mismatch';

/** What's wrong with the two passwords typed, if anything. */
export function exportPasswordIssue(password: string, repeat: string): ExportPasswordIssue | null {
  if (password.length < CERTIFICATE_EXPORT_PASSWORD_MIN) return 'short';
  if (password !== repeat) return 'mismatch';
  return null;
}

/**
 * Checks the passwords, then has main export (Touch ID when available, then the OS save dialog).
 * `name` is the saved file's, or null when the user cancelled.
 */
export async function submitCertificateExport(
  credentialId: string,
  password: string,
  repeat: string,
): Promise<{ issue: ExportPasswordIssue } | { name: string | null }> {
  const issue = exportPasswordIssue(password, repeat);
  if (issue) return { issue };
  return { name: await api.invoke('vault.exportCertificate', credentialId, password) };
}

/** The new password, typed twice. Main never keeps it. */
export function CertificateExportDialog({
  credentialId,
  biometric,
  open,
  onOpenChange,
}: {
  credentialId: string;
  biometric: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT(exportDict);
  const tc = useT(common);
  const tchat = useT(chatDict);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [issue, setIssue] = useState<ExportPasswordIssue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = (o: boolean) => {
    if (!o) {
      setPassword('');
      setRepeat('');
      setIssue(null);
      setError(null);
    }
    onOpenChange(o);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await submitCertificateExport(credentialId, password, repeat);
      if ('issue' in outcome) setIssue(outcome.issue);
      else if (outcome.name !== null) {
        toast.success(t.saved(outcome.name));
        close(false);
      }
      // Cancelled (Touch ID or the save dialog): the dialog stays, to try again or close.
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const min = CERTIFICATE_EXPORT_PASSWORD_MIN;
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t.title}
      description={t.lead}
      closeLabel={tc.close}
      width="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            {tc.cancel}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!password || !repeat}
            onClick={() => void submit()}
            data-testid="certificate-export-submit"
          >
            {t.submit}
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
        <Field
          label={t.password}
          help={t.passwordHelp(min)}
          error={issue === 'short' ? t.short(min) : null}
          required
        >
          {({ id, describedBy, invalid }) => (
            <PasswordInput
              id={id}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setIssue(null);
              }}
              maxLength={256}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              revealLabel={tchat.prompt.reveal}
              hideLabel={tchat.prompt.hide}
              data-testid="certificate-export-password"
              autoFocus
            />
          )}
        </Field>
        <Field label={t.repeat} error={issue === 'mismatch' ? t.mismatch : error} required>
          {({ id, describedBy, invalid }) => (
            <PasswordInput
              id={id}
              value={repeat}
              onChange={(e) => {
                setRepeat(e.target.value);
                setIssue(null);
              }}
              maxLength={256}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              revealLabel={tchat.prompt.reveal}
              hideLabel={tchat.prompt.hide}
              data-testid="certificate-export-repeat"
            />
          )}
        </Field>
        <p className="text-[13px] text-fg-muted">{t.note}</p>
        <p className="flex items-start gap-2 rounded-lg bg-st-attention-bg px-3 py-2 text-[12.5px] font-medium text-st-attention-fg ring-1 ring-st-attention-line ring-inset">
          <TriangleAlert size={15} className="mt-px shrink-0" aria-hidden />
          {t.warning}
        </p>
        {biometric ? (
          <p className="flex items-center gap-2 text-[12.5px] text-fg-muted">
            <FingerprintPattern size={16} className="text-accent-text" aria-hidden />
            {tchat.prompt.biometric}
          </p>
        ) : null}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
