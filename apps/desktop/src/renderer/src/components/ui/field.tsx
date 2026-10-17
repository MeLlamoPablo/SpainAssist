import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../../lib/cn';

const inputBase =
  'w-full rounded-lg border border-line-strong/70 bg-surface px-3 text-[14px] text-fg shadow-xs transition-[border-color,box-shadow] duration-150 placeholder:text-fg-subtle hover:border-line-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-ring/40 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-muted aria-invalid:border-danger aria-invalid:focus:ring-danger/25';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(inputBase, 'h-10', className)} {...rest} />;
  },
);

/**
 * Input with fixed, non-editable text in front (e.g. the `SA-` of voucher codes). The prefix
 * sits inside the field's border and is not part of the value; clicking it focuses the input.
 */
export const PrefixedInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & {
    prefix: string;
    /** No border or shadow: a soft fill on a surface that already frames it. */
    naked?: boolean;
  }
>(function PrefixedInput({ className, prefix, naked, ...rest }, ref) {
  const invalid = rest['aria-invalid'] === true || rest['aria-invalid'] === 'true';
  return (
    <label
      className={cn(
        'flex h-10 w-full min-w-0 cursor-text items-center rounded-lg border border-line-strong/70 bg-surface px-3 text-[14px] text-fg shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-line-strong focus-within:border-accent focus-within:ring-3 focus-within:ring-ring/40',
        naked && 'border-transparent bg-surface-2 shadow-none hover:border-transparent',
        invalid &&
          'border-danger hover:border-danger focus-within:border-danger focus-within:ring-danger/25',
        rest.disabled && 'cursor-not-allowed bg-surface-2 text-fg-muted',
      )}
    >
      <span className={cn('select-none text-fg-muted', className)} aria-hidden>
        {prefix}
      </span>
      <input
        ref={ref}
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg-subtle disabled:cursor-not-allowed',
          className,
        )}
        {...rest}
      />
    </label>
  );
});

export const PasswordInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { revealLabel: string; hideLabel: string }
>(function PasswordInput({ className, revealLabel, hideLabel, ...rest }, ref) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        ref={ref}
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        className={cn(inputBase, 'h-10 pr-10', className)}
        {...rest}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? hideLabel : revealLabel}
        className="absolute inset-y-0 right-1 my-auto flex size-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-3 hover:text-fg"
      >
        {visible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
      </button>
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow with the content up to maxRows. */
  autosize?: boolean;
  minRows?: number;
  maxRows?: number;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, autosize, minRows = 3, maxRows = 10, value, onChange, ...rest },
  forwarded,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const setRefs = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inner.current = el;
      if (typeof forwarded === 'function') forwarded(el);
      else if (forwarded) forwarded.current = el;
    },
    [forwarded],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = inner.current;
    if (!autosize || !el) return;
    const styles = window.getComputedStyle(el);
    const line = Number.parseFloat(styles.lineHeight) || 22;
    const pad = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    const border =
      Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
    el.style.height = 'auto';
    const min = minRows * line + pad + border;
    const max = maxRows * line + pad + border;
    const next = Math.min(max, Math.max(min, el.scrollHeight + border));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight + border > max ? 'auto' : 'hidden';
  }, [autosize, value, minRows, maxRows]);

  return (
    <textarea
      ref={setRefs}
      rows={autosize ? minRows : rest.rows}
      value={value}
      onChange={onChange}
      className={cn(inputBase, 'resize-none py-2 leading-[1.45]', className)}
      {...rest}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(inputBase, 'h-10 cursor-pointer appearance-none pr-9', className)}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown
          size={16}
          className="pointer-events-none absolute inset-y-0 right-3 my-auto text-fg-subtle"
          aria-hidden
        />
      </div>
    );
  },
);

/** Label + control + help/error, wired for accessibility via render prop ids. */
export function Field({
  id: fixedId,
  label,
  help,
  error,
  optionalLabel,
  required,
  className,
  children,
  aside,
}: {
  /** The control's id, when the caller needs a stable one (default: generated). */
  id?: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string | null;
  /** Shown next to the label for optional fields. */
  optionalLabel?: string;
  required?: boolean;
  className?: string;
  aside?: ReactNode;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}) {
  const generated = useId();
  const id = fixedId ?? generated;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium text-fg">
          {label}
          {!required && optionalLabel ? (
            <span className="ml-1.5 font-normal text-fg-subtle">({optionalLabel})</span>
          ) : null}
        </label>
        {aside}
      </div>
      {children({ id, describedBy: describedBy || undefined, invalid: Boolean(error) })}
      {error ? (
        <p id={errorId} className="text-[12.5px] font-medium text-danger" role="alert">
          {error}
        </p>
      ) : help ? (
        <p id={helpId} className="text-[12.5px] text-fg-muted">
          {help}
        </p>
      ) : null}
    </div>
  );
}
