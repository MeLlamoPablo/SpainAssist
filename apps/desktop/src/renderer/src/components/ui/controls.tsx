import { Check } from 'lucide-react';
import { Checkbox as RCheckbox, Switch as RSwitch, ToggleGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import { useId } from 'react';
import { cn } from '../../lib/cn';

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-start justify-between gap-6', className)}>
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {description ? (
          <p id={`${id}-d`} className="mt-0.5 text-[13px] text-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
      <RSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={description ? `${id}-d` : undefined}
        className="no-drag relative mt-0.5 inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full bg-line-strong transition-colors duration-150 data-[state=checked]:bg-accent disabled:opacity-50"
      >
        <RSwitch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-(--sa-white) shadow-xs transition-transform duration-150 data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-accent-fg" />
      </RSwitch.Root>
    </div>
  );
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <RCheckbox.Root
        id={id}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        disabled={disabled}
        className="no-drag mt-[1px] flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border border-line-strong bg-surface shadow-xs transition-colors duration-150 hover:border-fg-subtle data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:opacity-50"
      >
        <RCheckbox.Indicator>
          <Check size={13} strokeWidth={3} className="text-accent-fg" aria-hidden />
        </RCheckbox.Indicator>
      </RCheckbox.Root>
      <div className="min-w-0">
        <label htmlFor={id} className="text-[13.5px] leading-5 text-fg">
          {label}
        </label>
        {description ? <p className="text-[12.5px] text-fg-muted">{description}</p> : null}
      </div>
    </div>
  );
}

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
}

export function SegmentedControl<V extends string>({
  value,
  onValueChange,
  options,
  label,
  size = 'md',
  className,
}: {
  value: V;
  onValueChange: (value: V) => void;
  options: SegmentOption<V>[];
  /** Accessible group name. */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => {
        if (v) onValueChange(v as V);
      }}
      aria-label={label}
      className={cn(
        'no-drag inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-3 p-0.5',
        className,
      )}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 rounded-md font-medium text-fg-muted transition-[background-color,color,box-shadow] duration-150 hover:text-fg data-[state=on]:bg-surface data-[state=on]:text-fg data-[state=on]:shadow-xs',
            size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-8 px-3 text-[13px]',
          )}
        >
          {o.icon}
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
