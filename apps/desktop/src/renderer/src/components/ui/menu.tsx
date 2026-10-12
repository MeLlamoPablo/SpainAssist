import type { LucideIcon } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({
  children,
  align = 'end',
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'end' | 'center';
  className?: string;
}) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={6}
        className={cn(
          'z-50 min-w-52 animate-pop-in rounded-xl border border-line bg-surface p-1 shadow-pop',
          className,
        )}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export function MenuItem({
  icon: Icon,
  children,
  onSelect,
  danger,
  disabled,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        'flex h-9 cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-3',
        danger ? 'text-danger' : 'text-fg',
      )}
    >
      {Icon ? (
        <Icon size={16} className={danger ? 'text-danger' : 'text-fg-subtle'} aria-hidden />
      ) : null}
      {children}
    </DropdownMenu.Item>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}
