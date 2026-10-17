import type { LucideIcon } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn('shrink-0 animate-spin', className)}
      role="presentation"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export type Tone =
  | 'research'
  | 'attention'
  | 'progress'
  | 'planned'
  | 'waiting'
  | 'done'
  | 'blocked'
  | 'neutral'
  | 'brand';

export const TONE_PILL: Record<Tone, string> = {
  research: 'bg-st-research-bg text-st-research-fg ring-st-research-line',
  attention: 'bg-st-attention-bg text-st-attention-fg ring-st-attention-line',
  progress: 'bg-st-progress-bg text-st-progress-fg ring-st-progress-line',
  planned: 'bg-st-planned-bg text-st-planned-fg ring-st-planned-line',
  waiting: 'bg-st-waiting-bg text-st-waiting-fg ring-st-waiting-line',
  done: 'bg-st-done-bg text-st-done-fg ring-st-done-line',
  blocked: 'bg-st-blocked-bg text-st-blocked-fg ring-st-blocked-line',
  neutral: 'bg-st-neutral-bg text-st-neutral-fg ring-st-neutral-line',
  brand: 'bg-accent-soft text-accent-text ring-accent-line',
};

const TONE_DOT: Record<Tone, string> = {
  research: 'bg-st-research-dot',
  attention: 'bg-st-attention-dot',
  progress: 'bg-st-progress-dot',
  planned: 'bg-st-planned-dot',
  waiting: 'bg-st-waiting-dot',
  done: 'bg-st-done-dot',
  blocked: 'bg-st-blocked-dot',
  neutral: 'bg-st-neutral-dot',
  brand: 'bg-accent',
};

export function Pill({
  tone = 'neutral',
  icon: Icon,
  dot,
  size = 'md',
  className,
  children,
}: {
  tone?: Tone;
  icon?: LucideIcon;
  dot?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium ring-1 ring-inset',
        size === 'sm' ? 'h-5 px-2 text-[11px]' : 'h-6 px-2.5 text-xs',
        TONE_PILL[tone],
        className,
      )}
    >
      {dot ? <span className={cn('size-1.5 rounded-full', TONE_DOT[tone])} aria-hidden /> : null}
      {Icon ? <Icon size={size === 'sm' ? 11 : 13} aria-hidden /> : null}
      {children}
    </span>
  );
}

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-line bg-surface shadow-card', className)}
      {...rest}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-3', className)} aria-hidden />;
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-10 text-center', className)}>
      <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-surface-3 text-fg-subtle">
        <Icon size={20} aria-hidden />
      </div>
      <p className="font-medium text-fg">{title}</p>
      {children ? <p className="mt-1 max-w-sm text-[13px] text-fg-muted">{children}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** Inline callout (info / warning / danger / success). */
export function Callout({
  tone = 'research',
  icon: Icon,
  title,
  children,
  className,
  action,
}: {
  tone?: Tone;
  icon?: LucideIcon;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl px-3.5 py-3 text-[13px] ring-1 ring-inset',
        TONE_PILL[tone],
        className,
      )}
    >
      {Icon ? <Icon size={17} className="mt-px shrink-0" aria-hidden /> : null}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? (
          <div className={cn(title ? 'mt-0.5' : '', 'opacity-90')}>{children}</div>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
