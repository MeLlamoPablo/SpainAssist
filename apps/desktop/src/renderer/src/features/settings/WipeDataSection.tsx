import { Trash } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api, errorMessage } from '../../lib/api';
import { useAppStore } from '../../store/app';
import { loadConversation, reloadProcedures, reloadVault } from '../../store/sync';
import { toast } from '../../store/toast';
import { vaultDict } from '../vault/i18n';

/** After "Borrar todos mis datos": reload everything from main (onboarding shows again). */
async function reloadAfterWipe() {
  const [settings, provider] = await Promise.all([
    api.invoke('settings.get'),
    api.invoke('providers.status'),
  ]);
  await Promise.all([reloadProcedures(), reloadVault(), loadConversation()]);
  useAppStore.setState({ settings, provider, view: { kind: 'procedures' } });
}

export function WipeDataSection() {
  const t = useT(vaultDict);
  const tc = useT(common);
  const [confirm, setConfirm] = useState(false);

  const wipe = async () => {
    try {
      await api.invoke('vault.wipeAll');
      await reloadAfterWipe();
      toast.success(t.privacy.wiped);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-st-blocked-line bg-st-blocked-bg/40 px-5 py-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-[240px] flex-1">
            <p className="text-[14.5px] font-semibold text-st-blocked-fg">{t.privacy.wipeTitle}</p>
            <p className="mt-0.5 text-[13.5px] text-fg-muted">{t.privacy.wipeBody}</p>
          </div>
          <Button
            variant="danger"
            icon={Trash}
            onClick={() => setConfirm(true)}
            data-testid="wipe-all"
          >
            {t.privacy.wipe}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t.privacy.wipeConfirmTitle}
        description={t.privacy.wipeConfirmBody}
        confirmLabel={t.privacy.wipeConfirm}
        cancelLabel={tc.cancel}
        typeToConfirm={t.privacy.wipeWord}
        typeToConfirmLabel={t.privacy.wipeTypeLabel}
        onConfirm={wipe}
      />
    </div>
  );
}
