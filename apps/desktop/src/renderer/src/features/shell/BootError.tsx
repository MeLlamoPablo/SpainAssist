import { RotateCcw, Unplug } from 'lucide-react';
import { BrandMark } from '../../components/brand';
import { Button } from '../../components/ui/button';
import { defineDict, useT } from '../../i18n';

const dict = defineDict({
  es: {
    title: 'No he podido arrancar',
    body: 'Algo ha fallado al abrir Spain Assist. Tus datos están a salvo. Prueba a abrirlo de nuevo.',
    retry: 'Volver a intentarlo',
    details: 'Detalles técnicos',
  },
  en: {
    title: 'I couldn’t start',
    body: 'Something went wrong while opening Spain Assist. Your data is safe. Please try again.',
    retry: 'Try again',
    details: 'Technical details',
  },
});

export function BootError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT(dict);
  return (
    <div className="drag flex h-full items-center justify-center bg-surface p-8">
      <div className="no-drag w-full max-w-md text-center">
        <div className="mb-5 flex justify-center">
          <div className="relative">
            <BrandMark size={52} />
            <span className="absolute -right-2 -bottom-2 flex size-7 items-center justify-center rounded-full border-2 border-surface bg-st-blocked-bg text-st-blocked-fg">
              <Unplug size={14} aria-hidden />
            </span>
          </div>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{t.title}</h1>
        <p className="mt-2 text-[14px] text-fg-muted">{t.body}</p>
        <Button variant="primary" icon={RotateCcw} className="mt-6" onClick={onRetry}>
          {t.retry}
        </Button>
        <details className="mt-6 text-left text-[12px] text-fg-subtle">
          <summary className="cursor-pointer">{t.details}</summary>
          <pre className="selectable mt-2 whitespace-pre-wrap rounded-lg bg-surface-2 p-3">
            {message}
          </pre>
        </details>
      </div>
    </div>
  );
}
