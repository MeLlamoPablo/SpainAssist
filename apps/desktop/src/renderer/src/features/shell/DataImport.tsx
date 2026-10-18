import { FolderInput, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BrandMark } from '../../components/brand';
import { Button } from '../../components/ui/button';
import { defineDict, useT } from '../../i18n';
import { api } from '../../lib/api';
import { useAppStore } from '../../store/app';

const dict = defineDict({
  es: {
    title: 'Pasa a la versión de Microsoft Store',
    body: 'Ya usabas Spain Assist en este ordenador. Para seguir, desinstala la versión antigua, que se instaló fuera de Microsoft Store.',
    migrate: 'Tus datos se migrarán de la aplicación antigua a la nueva.',
    uninstall: 'Desinstalar Spain Assist antiguo',
    waiting: 'Esperando a que termine la desinstalación…',
    importing: 'Trayendo tus datos',
    reopening: 'Spain Assist se abrirá de nuevo en un momento.',
    failed: 'No he podido traer tus datos.',
    retry: 'Reintentar',
  },
  en: {
    title: 'Move to the Microsoft Store version',
    body: 'You already used Spain Assist on this computer. To continue, uninstall the old version, which was installed outside the Microsoft Store.',
    migrate: 'Your data will be moved from the old app to the new one.',
    uninstall: 'Uninstall old Spain Assist',
    waiting: 'Waiting for the uninstall to finish…',
    importing: 'Bringing your data over',
    reopening: 'Spain Assist will open again in a moment.',
    failed: 'I couldn’t bring your data over.',
    retry: 'Try again',
  },
});

/** How often the screen checks whether the old version is gone. */
const POLL_MS = 1500;

/**
 * The Microsoft Store build while the GitHub (NSIS) install is on this Windows account: nothing
 * else shows until it is uninstalled. Then its data is copied in and the app restarts
 * (`main/migrate/nsis-import.ts`).
 */
export function StoreMigration() {
  const t = useT(dict);
  const state = useAppStore((s) => s.dataImport.state);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  // The window opens hidden while the onboarding warms up; this screen replaces it.
  useEffect(() => {
    void api.invoke('app.reveal');
  }, []);

  // Goes on by itself once the uninstaller is done.
  useEffect(() => {
    if (state !== 'uninstall') return;
    const timer = setInterval(() => {
      void api
        .invoke('dataImport.status')
        .then((dataImport) => {
          if (dataImport.state !== 'uninstall') useAppStore.setState({ dataImport });
        })
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [state]);

  const runImport = useCallback(async () => {
    setFailed(false);
    try {
      // Restarts the app: doesn't come back unless the copy fails.
      await api.invoke('dataImport.run');
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    if (state !== 'import' || started.current) return;
    started.current = true;
    void runImport();
  }, [state, runImport]);

  const uninstall = async () => {
    await api.invoke('dataImport.uninstall').catch(() => {});
    setWaiting(true);
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
        <p className="mt-2 text-[14px] text-fg-muted">{t.migrate}</p>
        <div className="mt-6 flex justify-center">
          {state === 'uninstall' ? (
            <Button variant="primary" icon={Trash2} onClick={() => void uninstall()}>
              {t.uninstall}
            </Button>
          ) : failed ? (
            <Button variant="primary" icon={FolderInput} onClick={() => void runImport()}>
              {t.retry}
            </Button>
          ) : (
            <Button variant="primary" icon={FolderInput} loading>
              {t.importing}
            </Button>
          )}
        </div>
        <p className="mt-4 min-h-5 text-[13px] text-fg-muted" aria-live="polite">
          {state === 'uninstall' ? (waiting ? t.waiting : '') : failed ? '' : t.reopening}
        </p>
        {failed && (
          <p role="alert" className="text-[13px] font-medium text-danger">
            {t.failed}
          </p>
        )}
      </div>
    </div>
  );
}
