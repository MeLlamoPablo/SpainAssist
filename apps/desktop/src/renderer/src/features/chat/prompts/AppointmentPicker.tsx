import type { FormField } from '@sa/shared';
import { CalendarCheck, CalendarSearch, ChevronLeft, ChevronRight } from 'lucide-react';
import { ToggleGroup } from 'radix-ui';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button, IconButton } from '../../../components/ui/button';
import { useLang, useT } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { chatDict } from '../i18n';
import {
  appointmentDays,
  columnsFor,
  dayHeading,
  pageOf,
  rangeLabel,
  slotLabel,
} from './appointmentLogic';

/**
 * Free appointment slots in day columns (only days with slots), paged by as many columns as fit.
 * "Buscar más citas" answers the form at once, asking the agent for other slots.
 */
export function AppointmentPicker({
  field,
  value,
  onChange,
  onRequestMore,
  busy,
  inputId,
  describedBy,
  invalid,
}: {
  field: FormField;
  value: string;
  onChange: (value: string) => void;
  onRequestMore: () => void;
  busy?: boolean;
  inputId: string;
  describedBy?: string;
  invalid: boolean;
}) {
  const t = useT(chatDict);
  const lang = useLang();
  const days = appointmentDays(field.slots ?? []);
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(() => ({ perPage: 4, page: pageOf(days, 4, value) }));
  // A narrower card has more pages: re-page around the chosen slot when the columns change.
  const placement = useRef({ days, value });
  placement.current = { days, value };
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const perPage = columnsFor(node.clientWidth);
      setView((current) =>
        current.perPage === perPage
          ? current
          : {
              perPage,
              page: pageOf(placement.current.days, perPage, placement.current.value),
            },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const { perPage } = view;
  const pages = Math.max(1, Math.ceil(days.length / perPage));
  const page = Math.min(view.page, pages - 1);
  const setPage = (next: number) => setView({ perPage, page: next });
  const shown = days.slice(page * perPage, page * perPage + perPage);

  return (
    <div ref={ref} className="flex flex-col gap-3" data-testid="appointment-picker">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[15px] font-semibold text-fg tabular-nums" aria-live="polite">
          {rangeLabel(shown, lang)}
        </p>
        {pages > 1 ? (
          <div className="flex items-center gap-1">
            <IconButton
              icon={ChevronLeft}
              label={t.prompt.appointmentEarlier}
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            />
            <IconButton
              icon={ChevronRight}
              label={t.prompt.appointmentLater}
              disabled={page >= pages - 1}
              onClick={() => setPage(page + 1)}
            />
          </div>
        ) : null}
      </div>
      <div className="border-t border-line" />
      <ToggleGroup.Root
        id={inputId}
        type="single"
        value={value}
        onValueChange={(v) => v && onChange(v)}
        aria-label={field.label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className="grid max-h-[300px] gap-3 overflow-y-auto py-1"
        style={{ gridTemplateColumns: `repeat(${perPage}, minmax(0, 1fr))` }}
      >
        {shown.map((day) => {
          const heading = dayHeading(day.date, lang);
          return (
            <div key={day.date} className="flex min-w-0 flex-col gap-2">
              <p className="sticky top-0 bg-surface pb-1 text-center text-[12.5px] font-medium tracking-wide text-fg-muted">
                {heading.weekday} {heading.day}
              </p>
              {day.slots.map((slot) => (
                <ToggleGroup.Item
                  key={slot}
                  value={slot}
                  aria-label={slotLabel(slot, lang)}
                  className={cn(
                    'group inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-line-strong/70 bg-surface text-[14px] font-medium text-fg tabular-nums shadow-xs transition-colors duration-150',
                    'hover:border-fg-subtle data-[state=on]:border-accent data-[state=on]:bg-accent data-[state=on]:text-accent-fg',
                  )}
                >
                  <span
                    className="size-2 rounded-full bg-st-done-dot group-data-[state=on]:bg-accent-fg"
                    aria-hidden
                  />
                  {slot.slice(11, 16)}
                </ToggleGroup.Item>
              ))}
            </div>
          );
        })}
      </ToggleGroup.Root>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Button
          size="sm"
          variant="secondary"
          icon={CalendarSearch}
          disabled={busy}
          onClick={onRequestMore}
          data-testid="appointment-more"
        >
          {t.prompt.appointmentMore}
        </Button>
        {value ? (
          <p
            className="flex min-w-0 items-center gap-2 text-[13.5px] font-medium text-fg"
            data-testid="appointment-chosen"
          >
            <CalendarCheck size={16} className="shrink-0 text-accent-text" aria-hidden />
            <span className="truncate first-letter:uppercase">{slotLabel(value, lang)}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
