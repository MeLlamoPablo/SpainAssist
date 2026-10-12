import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useToastStore } from '../../store/toast';

const ICON = { info: Info, success: CircleCheck, error: CircleAlert } as const;

export function Toaster({ closeLabel }: { closeLabel: string }) {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex animate-slide-up items-start gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-pop"
          >
            <Icon
              size={18}
              className={cn(
                'mt-px shrink-0',
                t.kind === 'success' && 'text-st-done-dot',
                t.kind === 'error' && 'text-danger',
                t.kind === 'info' && 'text-st-research-dot',
              )}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium text-fg">{t.title}</p>
              {t.description ? (
                <p className="mt-0.5 text-[13px] text-fg-muted">{t.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label={closeLabel}
              className="-m-1 flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-3 hover:text-fg"
            >
              <X size={15} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
