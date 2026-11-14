import type { CredentialSummary } from '@sa/shared';
import {
  Download,
  Ellipsis,
  FingerprintPattern,
  Info,
  MonitorCheck,
  MonitorDown,
  Trash,
  TriangleAlert,
} from 'lucide-react';
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
import { systemCertificateManager, systemDict, systemName } from './systemI18n';

/**
 * The three-dots menu of a certificate the app holds: download a copy, move it to the operating
 * system (only offered where the app could then use it from there) and delete it. One that is
 * also installed in the operating system (`inSystem`) can be neither moved nor deleted: its one
 * way out of the app is to use the system's, which checks first that it is the same.
 */
export function CertificateMenu({
  credential,
  biometric,
  onDelete,
}: {
  credential: CredentialSummary;
  biometric: boolean;
  /** "Borrar": the card asks for confirmation. */
  onDelete: () => void;
}) {
  const t = useT(systemDict);
  const tc = useT(common);
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
          {credential.inSystem ? (
            <MenuItem icon={MonitorCheck} onSelect={() => setDialog('move')}>
              {t.useSystem}
            </MenuItem>
          ) : (
            <>
              {credential.canMoveToSystem ? (
                <MenuItem icon={MonitorDown} onSelect={() => setDialog('move')}>
                  {t.move}
                </MenuItem>
              ) : null}
              <MenuItem icon={Trash} danger onSelect={onDelete}>
                {tc.delete}
              </MenuItem>
            </>
          )}
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
        inSystem={credential.inSystem === true}
        automatic={credential.policy === 'auto'}
        biometric={biometric}
        open={dialog === 'move'}
        onOpenChange={(open) => setDialog(open ? 'move' : null)}
      />
    </>
  );
}

/** `text` with its first `link` (when it has one) as an inline link. */
function WithLink({ text, link, onClick }: { text: string; link?: string; onClick: () => void }) {
  const at = link ? text.indexOf(link) : -1;
  if (!link || at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <button
        type="button"
        onClick={onClick}
        className="font-medium text-accent-text underline decoration-accent-line decoration-1 underline-offset-[3px] hover:decoration-current"
        data-testid="certificate-move-manager"
      >
        {link}
      </button>
      {text.slice(at + link.length)}
    </>
  );
}

/**
 * Explains the move, then main does it (Touch ID when available). For a certificate that is
 * already in the system (`inSystem`) nothing moves: main drops the app's copy. One the app uses
 * without asking (`automatic`) gets a notice: from the system it always asks.
 */
export function CertificateMoveDialog({
  credentialId,
  inSystem = false,
  automatic = false,
  biometric,
  open,
  onOpenChange,
}: {
  credentialId: string;
  inSystem?: boolean;
  automatic?: boolean;
  biometric: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const dict = useT(systemDict);
  const t = inSystem ? dict.useDialog : dict.moveDialog;
  const warning = inSystem ? dict.useDialog.warning : null;
  const tc = useT(common);
  const tchat = useT(chatDict);
  const platform = useAppStore((s) => s.info?.platform);
  const lang = useLang();
  const system = systemName(platform, lang);
  const manager = systemCertificateManager(platform, lang);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = (o: boolean) => {
    if (busy) return;
    if (!o) setError(null);
    onOpenChange(o);
  };

  const openManager = async () => {
    try {
      await api.invoke('vault.openSystemCertificates');
    } catch (err) {
      toast.error(errorMessage(err));
    }
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
        toast.success(t.done(system));
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
      title={t.title(system)}
      description={t.lead(system)}
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
            {t.submit}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pt-1">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-[13px] text-fg-muted">
          {t.points(system, manager.name).map((point) => (
            <li key={point}>
              <WithLink text={point} link={manager.app} onClick={() => void openManager()} />
            </li>
          ))}
        </ul>
        {automatic ? (
          <p
            className="flex items-start gap-2 rounded-lg bg-st-research-bg px-3 py-2 text-[12.5px] font-medium text-st-research-fg ring-1 ring-st-research-line ring-inset"
            data-testid="certificate-move-automatic"
          >
            <Info size={15} className="mt-px shrink-0" aria-hidden />
            {dict.automaticNotice}
          </p>
        ) : null}
        {warning ? (
          <p className="flex items-start gap-2 rounded-lg bg-st-attention-bg px-3 py-2 text-[12.5px] font-medium text-st-attention-fg ring-1 ring-st-attention-line ring-inset">
            <TriangleAlert size={15} className="mt-px shrink-0" aria-hidden />
            {warning}
          </p>
        ) : null}
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
