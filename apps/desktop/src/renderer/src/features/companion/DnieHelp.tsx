import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { companionDict } from './i18n';

/** The same DNIe help in the signature prompt and the saved PIN dialog. */
export function DnieHelp({ pin }: { pin: boolean }) {
  const t = useT(companionDict).unlock;
  const [open, setOpen] = useState(false);
  const contentId = useId();

  return (
    <div className="rounded-lg border border-line bg-surface">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-[13px] font-medium text-fg hover:text-accent"
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        onClick={() => setOpen((o) => !o)}
        data-testid="dnie-unlock-help"
      >
        {pin ? t.helpTitle : t.canHelpTitle}
        <ChevronDown
          size={15}
          className={cn('shrink-0 text-fg-subtle transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open ? (
        <ul
          id={contentId}
          className="flex list-disc flex-col gap-1.5 border-t border-line py-3 pr-3 pl-7 text-[13px] text-fg-muted"
        >
          {(pin ? t.help : [t.canWhere]).map((line) => (
            <li key={line} className="whitespace-pre-line">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
