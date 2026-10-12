import { SPANISH_PROVINCES } from '@sa/shared';
import { Check, ChevronDown } from 'lucide-react';
import { Popover } from 'radix-ui';
import { type InputHTMLAttributes, useEffect, useRef, useState } from 'react';
import { defineDict, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { Input } from './field';
import { filterProvinces } from './provinceSearch';

const dict = defineDict({
  es: { placeholder: 'Busca una provincia', empty: 'No hay provincias con ese nombre.' },
  en: { placeholder: 'Search for a province', empty: 'No provinces match that name.' },
});

/** Search text is local; only a chosen canonical province becomes the field value. */
export function ProvinceSelect({
  value,
  onValueChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const t = useT(dict);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const options = filterProvinces(query ?? '');
  const selected = SPANISH_PROVINCES.find((p) => p.value === value);
  const listId = `${props.id}-options`;
  const activeId = open && options[active] ? `${listId}-${options[active].code}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const close = () => {
    setOpen(false);
    setQuery(null);
  };
  const show = () => {
    setActive(
      Math.max(
        0,
        options.findIndex((p) => p.value === value),
      ),
    );
    setOpen(true);
  };
  const choose = (index: number) => {
    const province = options[index];
    if (!province) return;
    onValueChange(province.value);
    close();
  };

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? show() : close())}>
      <Popover.Anchor asChild>
        <div ref={anchor} className="relative">
          <Input
            {...props}
            ref={input}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
            placeholder={props.placeholder ?? t.placeholder}
            value={query ?? selected?.label ?? value}
            className={cn('pr-9', props.className)}
            onFocus={(e) => {
              show();
              props.onFocus?.(e);
            }}
            onClick={() => {
              if (!open) show();
            }}
            onBlur={(e) => {
              close();
              props.onBlur?.(e);
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
              if (value) onValueChange('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (open) choose(active);
                else show();
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!open) show();
                else {
                  const delta = e.key === 'ArrowDown' ? 1 : -1;
                  setActive((i) => (i + delta + options.length) % (options.length || 1));
                }
              } else if (open && (e.key === 'Home' || e.key === 'End')) {
                e.preventDefault();
                setActive(e.key === 'Home' ? 0 : Math.max(0, options.length - 1));
              } else if (open && e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
              } else props.onKeyDown?.(e);
            }}
          />
          <ChevronDown
            size={16}
            className="pointer-events-none absolute inset-y-0 right-3 my-auto text-fg-subtle"
            aria-hidden
          />
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={5}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (e.target instanceof Node && anchor.current?.contains(e.target)) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => e.preventDefault()}
          className="z-50 max-h-[min(280px,var(--radix-popover-content-available-height))] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-pop"
          style={{ width: anchor.current?.offsetWidth }}
        >
          <div id={listId} role="listbox" aria-label={props['aria-label']}>
            {options.map((province, index) => (
              <button
                type="button"
                tabIndex={-1}
                key={province.code}
                id={`${listId}-${province.code}`}
                role="option"
                aria-selected={province.value === value}
                onPointerMove={() => setActive(index)}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => choose(index)}
                className={cn(
                  'flex min-h-9 w-full cursor-pointer items-center gap-2 text-left rounded-lg px-2.5 text-[13.5px] text-fg',
                  index === active && 'bg-surface-3',
                  province.value === value && 'font-semibold text-accent-text',
                )}
              >
                <span className="flex-1">{province.label}</span>
                {province.value === value ? <Check size={14} aria-hidden /> : null}
              </button>
            ))}
          </div>
          {!options.length && (
            <p role="status" className="px-2.5 py-2 text-[13px] text-fg-muted">
              {t.empty}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
