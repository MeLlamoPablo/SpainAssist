import type { CredentialSummary } from '@sa/shared';
import { Download, Ellipsis, FingerprintPattern, MonitorDown, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button, IconButton } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/ui/menu';
import { useLang, useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api, errorMessage } from '../../lib/api';
import { useAppStore } from '../../store/app';
import { toast } from '../../store/toast';
import { useVaultStore } from '../../store/vault';
import { chatDict } from '../chat/i18n';
import { CertificateExportDialog } from './CertificateExport';
import { systemDict, systemName } from './systemI18n';

/**
 * The three-dots menu of a certificate the app holds, next to its bin: download a copy, or move
 * it to the operating system (only offered where the app could then use it from there).
 */
export function CertificateMenu({
  credential,
  biometric,
}: {
  credential: CredentialSummary;
  biometric: boolean;
}) {
  const t = useT(systemDict);
  const [dialog, setDialog] = useState<'export' | 'move' | null>(null);
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <IconButton icon={Ellipsis} label={t.menu} data-testid="certificate-menu" />
        </MenuTrigger>
        <MenuContent>
          <MenuItem icon={Download} onSelect={() => setDialog('export')}>
            {t.download}
          </MenuItem>
          {credential.canMoveToSystem ? (
            <MenuItem icon={MonitorDown} onSelect={() => setDialog('move')}>
              {t.move}
            </MenuItem>
          ) : null}
        </MenuContent>
      </Menu>
      <CertificateExportDialog
        credentialId={credential.id}
        biometric={biometric}
        open={dialog === 'export'}
        onOpenChange={(open) => setDialog(open ? 'export' : null)}
      />
      <CertificateMoveDialog
        credentialId={credential.id}
        biometric={biometric}
        open={dialog === 'move'}
        onOpenChange={(open) => setDialog(open ? 'move' : null)}
      />
    </>
  );
}

/** Explains the move, then main does it (Touch ID when available). */
export function CertificateMoveDialog({
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
  const t = useT(systemDict);
  const tc = useT(common);
  const tchat = useT(chatDict);
  const system = systemName(
    useAppStore((s) => s.info?.platform),
    useLang(),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = (o: boolean) => {
    if (busy) return;
    if (!o) setError(null);
    onOpenChange(o);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const overview = await api.invoke('vault.moveCertificateToSystem', credentialId);
      // Cancelled (Touch ID): the dialog stays, to try again or close.
      if (overview) {
        useVaultStore.getState().set(overview);
        toast.success(t.moved(system));
        onOpenChange(false);
      }
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
      title={t.moveTitle(system)}
      description={t.moveLead(system)}
      closeLabel={tc.close}
      width="sm"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={() => close(false)}>
            {tc.cancel}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void submit()}
            data-testid="certificate-move-submit"
          >
            {t.moveSubmit}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pt-1">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-[13px] text-fg-muted">
          {t.movePoints(system).map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <p className="flex items-start gap-2 rounded-lg bg-st-attention-bg px-3 py-2 text-[12.5px] font-medium text-st-attention-fg ring-1 ring-st-attention-line ring-inset">
          <TriangleAlert size={15} className="mt-px shrink-0" aria-hidden />
          {t.moveWarning}
        </p>
        {error ? (
          <p role="alert" className="text-[13px] font-medium text-danger">
            {error}
          </p>
        ) : null}
        {biometric ? (
          <p className="flex items-center gap-2 text-[12.5px] text-fg-muted">
            <FingerprintPattern size={16} className="text-accent-text" aria-hidden />
            {tchat.prompt.biometric}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
