import type { LucideIcon } from 'lucide-react';
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Spinner } from './misc';
import { Tooltip } from './tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-fg shadow-xs hover:bg-accent-hover active:translate-y-px disabled:opacity-50',
  secondary:
    'border border-line bg-surface text-fg shadow-xs hover:border-line-strong hover:bg-surface-2 active:translate-y-px disabled:opacity-50',
  ghost: 'text-fg-muted hover:bg-surface-3 hover:text-fg disabled:opacity-40',
  danger:
    'bg-danger text-danger-fg shadow-xs hover:bg-danger-hover active:translate-y-px disabled:opacity-50',
  soft: 'bg-accent-soft text-accent-text hover:bg-accent-soft-strong disabled:opacity-50',
  link: 'h-auto px-0 text-accent-text underline-offset-4 hover:underline disabled:opacity-50',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 rounded-lg px-3 text-[13px]',
  md: 'h-9 gap-2 rounded-lg px-3.5 text-sm',
  lg: 'h-11 gap-2 rounded-xl px-5 text-[15px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon: Icon,
    iconRight: IconRight,
    loading,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const iconSize = size === 'lg' ? 18 : size === 'sm' ? 15 : 16;
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'no-drag inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,border-color,color,transform] duration-150',
        SIZE[size],
        VARIANT[variant],
        variant === 'link' && 'h-auto px-0',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : Icon ? <Icon size={iconSize} aria-hidden /> : null}
      {children}
      {IconRight && !loading ? <IconRight size={iconSize} aria-hidden /> : null}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  /** Accessible name, also shown as a tooltip. */
  label: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'secondary' | 'primary';
  tooltip?: boolean;
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
  children?: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon: Icon,
    label,
    size = 'md',
    variant = 'ghost',
    tooltip = true,
    tooltipSide = 'bottom',
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  const dim =
    size === 'sm'
      ? 'size-7 rounded-md'
      : size === 'lg'
        ? 'size-10 rounded-xl'
        : 'size-8 rounded-lg';
  const iconSize = size === 'sm' ? 15 : size === 'lg' ? 19 : 17;
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(
        'no-drag inline-flex shrink-0 items-center justify-center transition-colors duration-150 disabled:opacity-40',
        dim,
        variant === 'ghost' && 'text-fg-muted hover:bg-surface-3 hover:text-fg',
        variant === 'secondary' &&
          'border border-line bg-surface text-fg-muted shadow-xs hover:bg-surface-2 hover:text-fg',
        variant === 'primary' && 'bg-accent text-accent-fg hover:bg-accent-hover',
        className,
      )}
      {...rest}
    >
      <Icon size={iconSize} aria-hidden />
    </button>
  );
  return tooltip ? (
    <Tooltip content={label} side={tooltipSide}>
      {button}
    </Tooltip>
  ) : (
    button
  );
});
