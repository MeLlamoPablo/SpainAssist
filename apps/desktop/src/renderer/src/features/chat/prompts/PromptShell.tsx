import type { PromptItem } from '@sa/shared';
import { CircleCheck, CircleSlash, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { useAppStore } from '../../../store/app';
import { useProcedure } from '../../../store/procedures';
import { chatDict } from '../i18n';

/**
 * Common frame of the three prompt cards. Pending prompts glow amber ("te necesito"). Embedded
 * (a procedure's question on its card), the card is the frame: no border, no kicker.
 */
export function PromptShell({
  item,
  icon: Icon,
  kicker,
  title,
  danger,
  embedded,
  children,
  answeredSummary,
}: {
  item: PromptItem;
  icon: LucideIcon;
  kicker: string;
  title: string;
  danger?: boolean;
  embedded?: boolean;
  children: ReactNode;
  answeredSummary?: ReactNode;
}) {
  const t = useT(chatDict);
  const pending = item.status === 'pending';
  const headingId = `prompt-${item.id}`;
  // Questions from a procedure's agent say which procedure asks (and link to its card).
  const procedure = useProcedure(item.procedureId);
  const focusProcedure = useAppStore((s) => s.focusProcedure);

  if (!pending) {
    const cancelled = item.status === 'cancelled';
    const dismissed = item.response?.kind === 'form' && item.response.dismissed;
    return (
      <section
        aria-labelledby={headingId}
        className="rounded-xl border border-line bg-surface-2/60 px-4 py-3"
        data-testid="prompt-card"
        data-status={item.status}
      >
        <div className="flex items-center gap-2.5">
          {cancelled || dismissed ? (
            <CircleSlash size={16} className="shrink-0 text-fg-faint" aria-hidden />
          ) : (
            <CircleCheck size={16} className="shrink-0 text-st-done-dot" aria-hidden />
          )}
          <h3
            id={headingId}
            className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg-muted"
          >
            {title}
          </h3>
          <span className="shrink-0 text-[12px] font-medium text-fg-subtle">
            {cancelled ? t.prompt.cancelled : dismissed ? t.prompt.dismissed : t.prompt.answered}
          </span>
        </div>
        {!cancelled && !dismissed && answeredSummary ? (
          <div className="mt-2 pl-[26px] text-[13px] text-fg-muted">{answeredSummary}</div>
        ) : null}
      </section>
    );
  }

  if (embedded) {
    return (
      <section
        aria-labelledby={headingId}
        className="animate-slide-up"
        data-testid="prompt-card"
        data-status="pending"
      >
        <header className="flex items-center gap-2.5">
          <span
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-lg',
              danger
                ? 'bg-st-blocked-bg text-st-blocked-fg'
                : 'bg-st-attention-bg text-st-attention-fg',
            )}
          >
            <Icon size={15} aria-hidden />
          </span>
          <h3
            id={headingId}
            className="min-w-0 flex-1 text-[15px] font-semibold leading-snug tracking-[-0.01em] text-fg"
          >
            {title}
          </h3>
        </header>
        <div className="pt-3">{children}</div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'animate-slide-up overflow-hidden rounded-2xl border bg-surface shadow-raised ring-4',
        danger
          ? 'border-st-blocked-line ring-st-blocked-bg'
          : 'border-st-attention-line ring-st-attention-bg',
      )}
      data-testid="prompt-card"
      data-status="pending"
    >
      <header className="flex items-start gap-3 px-5 pt-4">
        <span
          className={cn(
            'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl',
            danger
              ? 'bg-st-blocked-bg text-st-blocked-fg'
              : 'bg-st-attention-bg text-st-attention-fg',
          )}
        >
          <Icon size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'flex items-center gap-1.5 text-[12px] font-semibold',
              danger ? 'text-st-blocked-fg' : 'text-st-attention-fg',
            )}
          >
            <span
              className={cn(
                'size-1.5 animate-pulse-soft rounded-full',
                danger ? 'bg-st-blocked-dot' : 'bg-st-attention-dot',
              )}
              aria-hidden
            />
            {procedure ? (
              <button
                type="button"
                onClick={() => focusProcedure(procedure.id)}
                className="min-w-0 truncate hover:underline"
                data-testid="prompt-procedure"
              >
                {procedure.title}
              </button>
            ) : (
              kicker
            )}
          </p>
          <h3
            id={headingId}
            className="mt-0.5 text-[16px] font-semibold leading-snug tracking-[-0.01em] text-fg"
          >
            {title}
          </h3>
        </div>
      </header>
      <div className="px-5 pt-3 pb-5">{children}</div>
    </section>
  );
}
