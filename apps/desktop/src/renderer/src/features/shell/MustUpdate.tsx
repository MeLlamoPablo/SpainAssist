import { ArrowDownToLine, Download, Store } from 'lucide-react';
import { useEffect } from 'react';
import { BrandMark } from '../../components/brand';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/misc';
import { defineDict, useT } from '../../i18n';
import { api } from '../../lib/api';
import { useAppStore } from '../../store/app';

/** The website, which links the installers for every platform. */
const WEBSITE_URL = 'https://spainassist.es';

const dict = defineDict({
  es: {
    title: 'Actualiza Spain Assist',
    body: 'Esta versión ya no funciona. Para seguir con tus trámites, instala la nueva. Tus datos se quedan como están.',
    checking: 'Buscando la nueva versión…',
    downloading: (version: string, percent: number) =>
      `Descargando la versión ${version}… ${percent} %`,
    ready: (version: string) =>
      `Instalando la versión ${version}. Spain Assist se abrirá solo en un momento.`,
    failed: 'No he podido descargarla sola. Descárgala e instálala tú.',
    download: 'Descargar la nueva versión',
    store: 'Actualízala desde Microsoft Store.',
    openStore: 'Abrir Microsoft Store',
  },
  en: {
    title: 'Update Spain Assist',
    body: 'This version no longer works. To carry on with your procedures, install the new one. Your data stays as it is.',
    checking: 'Looking for the new version…',
    downloading: (version: string, percent: number) =>
      `Downloading version ${version}… ${percent}%`,
    ready: (version: string) =>
      `Installing version ${version}. Spain Assist will open again in a moment.`,
    failed: 'I couldn’t download it myself. Download and install it yourself.',
    download: 'Download the new version',
    store: 'Update it from the Microsoft Store.',
    openStore: 'Open the Microsoft Store',
  },
});

/**
 * Replaces the whole app when this version may no longer be used (the `must-update` flag). Where
 * the app updates itself (Windows, the Linux .deb), main downloads the update and restarts into
 * it; elsewhere, or when that fails, the user downloads it from the website. The Microsoft Store
 * build updates through the Store: the button opens its page there.
 */
export function MustUpdate() {
  const t = useT(dict);
  const updates = useAppStore((s) => s.updates);
  const fromStore = useAppStore((s) => s.info?.installChannel === 'msix');

  // The window opens hidden while the onboarding warms up; this screen replaces it.
  useEffect(() => {
    void api.invoke('app.reveal');
  }, []);

  const manual =
    updates.state === 'unsupported' || updates.state === 'upToDate' || updates.state === 'error';

  return (
    <div className="drag flex h-full items-center justify-center bg-surface p-8">
      <div className="no-drag w-full max-w-md text-center">
        <div className="mb-5 flex justify-center">
          <div className="relative">
            <BrandMark size={52} />
            <span className="absolute -right-2 -bottom-2 flex size-7 items-center justify-center rounded-full border-2 border-surface bg-accent-soft text-accent-text">
              <ArrowDownToLine size={14} aria-hidden />
            </span>
          </div>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{t.title}</h1>
        <p className="mt-2 text-[14px] text-fg-muted">{t.body}</p>

        {fromStore ? (
          <>
            <p className="mt-4 text-[13px] text-fg-muted">{t.store}</p>
            <Button
              variant="primary"
              icon={Store}
              className="mt-6"
              onClick={() => void api.invoke('updates.openStore')}
            >
              {t.openStore}
            </Button>
          </>
        ) : manual ? (
          <>
            {updates.state !== 'unsupported' && (
              <p className="mt-4 text-[13px] text-fg-muted">{t.failed}</p>
            )}
            <Button
              variant="primary"
              icon={Download}
              className="mt-6"
              onClick={() => void api.invoke('app.openExternal', WEBSITE_URL)}
            >
              {t.download}
            </Button>
          </>
        ) : (
          <div className="mt-6 flex flex-col items-center gap-3" aria-live="polite">
            {updates.state === 'downloading' ? (
              <div
                role="progressbar"
                aria-valuenow={updates.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-1.5 w-56 overflow-hidden rounded-full bg-surface-3"
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-300"
                  style={{ width: `${updates.percent}%` }}
                />
              </div>
            ) : (
              <Spinner size={18} className="text-fg-subtle" />
            )}
            <p className="text-[13px] text-fg-muted">
              {updates.state === 'downloading'
                ? t.downloading(updates.version, updates.percent)
                : updates.state === 'ready'
                  ? t.ready(updates.version)
                  : t.checking}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
