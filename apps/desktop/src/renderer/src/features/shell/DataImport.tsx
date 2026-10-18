import { FolderInput, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandMark } from '../../components/brand';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { defineDict, useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api } from '../../lib/api';
import { useAppStore } from '../../store/app';

const dict = defineDict({
  es: {
    title: '¿Traemos tus datos?',
    body: 'Ya usabas Spain Assist en este ordenador. Puedes traer aquí tus trámites, tus datos y tus credenciales.',
    closeOther: 'Si la otra versión está abierta, ciérrala antes. Sus datos se quedan como están.',
    accept: 'Traer mis datos',
    decline: 'Empezar de cero',
    copying: 'Copiando tus datos… Spain Assist se abrirá de nuevo en un momento.',
    failed: 'No he podido copiar tus datos. Inténtalo otra vez.',
    doneTitle: 'Tus datos ya están aquí',
    doneBody:
      'Ya no necesitas la otra versión de Spain Assist. Si quieres, desinstálala en Configuración de Windows, en Aplicaciones. Tus datos de aquí no se borran.',
    openSettings: 'Abrir Configuración',
    ok: 'Entendido',
  },
  en: {
    title: 'Bring your data over?',
    body: 'You already used Spain Assist on this computer. You can bring your procedures, your data and your credentials here.',
    closeOther: 'If the other version is open, close it first. Its data stays as it is.',
    accept: 'Bring my data',
    decline: 'Start from scratch',
    copying: 'Copying your data… Spain Assist will open again in a moment.',
    failed: 'I couldn’t copy your data. Try again.',
    doneTitle: 'Your data is here',
    doneBody:
      'You no longer need the other version of Spain Assist. If you like, uninstall it in Windows Settings, under Apps. Your data here isn’t deleted.',
    openSettings: 'Open Settings',
    ok: 'Got it',
  },
});

/**
 * The Microsoft Store build's first start, when the GitHub (NSIS) install left data on this
 * Windows account: replaces the onboarding until the user answers. Accepting restarts the app.
 */
export function DataImportOffer() {
  const t = useT(dict);
  const [step, setStep] = useState<'ask' | 'copying' | 'failed'>('ask');

  // The window opens hidden while the onboarding warms up; this screen replaces it.
  useEffect(() => {
    void api.invoke('app.reveal');
  }, []);

  const accept = async () => {
    setStep('copying');
    try {
      await api.invoke('dataImport.accept');
    } catch {
      setStep('failed');
    }
  };
  const decline = async () => {
    await api.invoke('dataImport.decline').catch(() => {});
    useAppStore.setState({ dataImport: { state: 'none' } });
  };

  return (
    <div className="drag flex h-full items-center justify-center bg-surface p-8">
      <div className="no-drag w-full max-w-md text-center">
        <div className="mb-5 flex justify-center">
          <div className="relative">
            <BrandMark size={52} />
            <span className="absolute -right-2 -bottom-2 flex size-7 items-center justify-center rounded-full border-2 border-surface bg-accent-soft text-accent-text">
              <FolderInput size={14} aria-hidden />
            </span>
          </div>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{t.title}</h1>
        <p className="mt-2 text-[14px] text-fg-muted">{t.body}</p>
        <p className="mt-2 text-[13px] text-fg-subtle">{t.closeOther}</p>
        {step === 'failed' && (
          <p role="alert" className="mt-4 text-[13px] font-medium text-danger">
            {t.failed}
          </p>
        )}
        <div className="mt-6 flex justify-center gap-2">
          <Button variant="secondary" disabled={step === 'copying'} onClick={() => void decline()}>
            {t.decline}
          </Button>
          <Button
            variant="primary"
            icon={FolderInput}
            loading={step === 'copying'}
            onClick={() => void accept()}
          >
            {t.accept}
          </Button>
        </div>
        {step === 'copying' && (
          <p className="mt-4 text-[13px] text-fg-muted" aria-live="polite">
            {t.copying}
          </p>
        )}
      </div>
    </div>
  );
}

/** Once, after the import: the other version can go. */
export function DataImportDone() {
  const t = useT(dict);
  const tc = useT(common);
  const windows = useAppStore((s) => s.info?.platform === 'win32');
  const dismiss = () => {
    useAppStore.setState({ dataImport: { state: 'none' } });
    void api.invoke('dataImport.dismiss').catch(() => {});
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && dismiss()}
      title={t.doneTitle}
      closeLabel={tc.close}
      width="sm"
      footer={
        <>
          {windows && (
            <Button
              variant="secondary"
              icon={Settings}
              onClick={() => void api.invoke('dataImport.openAppsSettings').catch(() => {})}
            >
              {t.openSettings}
            </Button>
          )}
          <Button variant="primary" onClick={dismiss}>
            {t.ok}
          </Button>
        </>
      }
    >
      <p className="text-[14px] leading-relaxed text-fg-muted">{t.doneBody}</p>
    </Dialog>
  );
}
