import type { PendingCertificateRequest } from '@sa/shared';
import { FileKey, KeyRound, Trash } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Card, Pill } from '../../components/ui/misc';
import { defineDict, useLang, useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api, errorMessage } from '../../lib/api';
import { formatLongDate, formatRelative, hostOf } from '../../lib/format';
import { useAppStore } from '../../store/app';
import { useProcedureStore } from '../../store/procedures';
import { toast } from '../../store/toast';
import { useVaultStore } from '../../store/vault';

const dict = defineDict({
  es: {
    title: 'Certificado digital',
    issuer: 'FNMT',
    status: 'En proceso',
    requested: (when: string) => `Solicitado ${when}`,
    site: 'Web',
    procedure: 'Trámite',
    kept: 'Tu clave está guardada en este dispositivo. Cuando descargues el certificado, se guardará aquí automáticamente.',
    discard: 'Descartar la solicitud',
    discardTitle: '¿Descartar la solicitud del certificado?',
    discardBody:
      'Se borrará su clave de este dispositivo. Sin ella, ese certificado ya no se puede descargar y tendrás que solicitarlo otra vez a la FNMT.',
    discardConfirm: 'Descartar',
    discarded: 'Solicitud descartada',
  },
  en: {
    title: 'Digital certificate',
    issuer: 'FNMT',
    status: 'In progress',
    requested: (when: string) => `Requested ${when}`,
    site: 'Website',
    procedure: 'Procedure',
    kept: 'Your key is kept on this device. Once you download the certificate, it’s saved here automatically.',
    discard: 'Discard the request',
    discardTitle: 'Discard the certificate request?',
    discardBody:
      'Its key will be deleted from this device. Without it, that certificate can no longer be downloaded and you’ll have to request it from FNMT again.',
    discardConfirm: 'Discard',
    discarded: 'Request discarded',
  },
});

/**
 * Mis datos → Credenciales: an FNMT certificate requested through the app, whose key waits in the
 * vault until the certificate is downloaded (then it becomes an ordinary certificate credential).
 */
export function CertificateRequestCard({ request: r }: { request: PendingCertificateRequest }) {
  const t = useT(dict);
  const tc = useT(common);
  const lang = useLang();
  const focusProcedure = useAppStore((s) => s.focusProcedure);
  // A deleted procedure leaves its request behind: then there is nothing to link to.
  const procedure = useProcedureStore((s) => (r.procedureId ? s.byId[r.procedureId] : undefined));
  const [confirm, setConfirm] = useState(false);

  const discard = async () => {
    try {
      useVaultStore.getState().set(await api.invoke('vault.deleteCertificateRequest', r.id));
      toast.success(t.discarded);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card className="overflow-hidden" data-testid="certificate-request">
      <div className="flex items-start gap-4 px-5 pt-4 pb-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-st-progress-bg text-st-progress-fg">
          <FileKey size={19} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[14.5px] font-semibold text-fg">{t.title}</p>
            <span className="text-[13px] text-fg-subtle">· {t.issuer}</span>
            <Pill tone="progress" size="sm" dot>
              {t.status}
            </Pill>
          </div>
          <p
            className="mt-0.5 text-[12.5px] text-fg-subtle"
            title={formatLongDate(r.createdAt, lang)}
          >
            {t.requested(formatRelative(r.createdAt, lang))}
          </p>
          <dl className="mt-3 grid grid-cols-1 gap-3 @min-[720px]:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-[11.5px] font-medium text-fg-subtle">{t.site}</dt>
              <dd className="mt-0.5 truncate text-[13.5px] font-medium text-fg">
                {hostOf(r.origin)}
              </dd>
            </div>
            {procedure ? (
              <div className="min-w-0">
                <dt className="text-[11.5px] font-medium text-fg-subtle">{t.procedure}</dt>
                <dd className="mt-0.5 flex text-[13.5px] font-medium text-fg">
                  <button
                    type="button"
                    title={procedure.title}
                    onClick={() => focusProcedure(procedure.id)}
                    className="min-w-0 truncate text-left transition-colors duration-150 hover:text-accent-text hover:underline"
                  >
                    {procedure.title}
                  </button>
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-surface-2/60 px-3 py-2 text-[13px] text-fg-muted">
            <KeyRound size={15} className="mt-0.5 shrink-0 text-st-progress-fg" aria-hidden />
            {t.kept}
          </p>
        </div>
        <IconButton icon={Trash} label={t.discard} onClick={() => setConfirm(true)} />
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t.discardTitle}
        description={t.discardBody}
        confirmLabel={t.discardConfirm}
        cancelLabel={tc.cancel}
        onConfirm={discard}
      />
    </Card>
  );
}
