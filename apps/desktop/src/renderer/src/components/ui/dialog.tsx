import { X } from 'lucide-react';
import { AlertDialog, Dialog as RDialog } from 'radix-ui';
import { type ReactNode, useState } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './button';
import { Input } from './field';

const overlay =
  'fixed inset-0 z-40 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in';
const content =
  'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-48px)] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop focus:outline-none data-[state=open]:animate-pop-in';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'md',
  closeLabel,
  className,
  bodyClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
  closeLabel: string;
  className?: string;
  bodyClassName?: string;
}) {
  const max = {
    sm: 'max-w-[420px]',
    md: 'max-w-[520px]',
    lg: 'max-w-[680px]',
    xl: 'max-w-[860px]',
  }[width];
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className={overlay} />
        <RDialog.Content
          className={cn(content, max, className)}
          aria-describedby={description ? undefined : undefined}
        >
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
            <div className="min-w-0">
              <RDialog.Title className="text-[17px] font-semibold tracking-[-0.01em] text-fg">
                {title}
              </RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-1 text-[13.5px] text-fg-muted">
                  {description}
                </RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">{title}</RDialog.Description>
              )}
            </div>
            <RDialog.Close
              aria-label={closeLabel}
              className="-mr-2 flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-subtle hover:bg-surface-3 hover:text-fg"
            >
              <X size={18} aria-hidden />
            </RDialog.Close>
          </div>
          <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 pb-5', bodyClassName)}>
            {children}
          </div>
          {footer ? (
            <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-6 py-3.5">
              {footer}
            </div>
          ) : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/**
 * Destructive confirmation. With `typeToConfirm`, the user has to type the given word before
 * the confirm button is enabled (used for "Borrar todos mis datos").
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  danger = true,
  typeToConfirm,
  typeToConfirmLabel,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void | Promise<void>;
  danger?: boolean;
  typeToConfirm?: string;
  typeToConfirmLabel?: ReactNode;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const blocked = typeToConfirm
    ? typed.trim().toLowerCase() !== typeToConfirm.toLowerCase()
    : false;

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped('');
        onOpenChange(o);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={overlay} />
        <AlertDialog.Content className={cn(content, 'max-w-[440px] p-6')}>
          <AlertDialog.Title className="text-[17px] font-semibold tracking-[-0.01em] text-fg">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 text-[14px] leading-relaxed text-fg-muted">{description}</div>
          </AlertDialog.Description>
          {children}
          {typeToConfirm ? (
            <div className="mt-4">
              <label
                className="mb-1.5 block text-[13px] font-medium text-fg"
                htmlFor="type-confirm"
              >
                {typeToConfirmLabel}
              </label>
              <Input
                id="type-confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary">{cancelLabel}</Button>
            </AlertDialog.Cancel>
            <Button
              variant={danger ? 'danger' : 'primary'}
              disabled={blocked}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  onOpenChange(false);
                  setTyped('');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
