import type { Appointment, ProcedureListItem } from '@sa/shared';
import {
  Archive,
  ArchiveRestore,
  CalendarPlus,
  Ellipsis,
  MapPin,
  Pencil,
  Trash,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Button, IconButton } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import { useLang, useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api, errorMessage } from '../../lib/api';
import { toast } from '../../store/toast';
import { calendarUrl, formatAppointment, mapsUrl } from './appointment';
import { procedureDict } from './i18n';

/** Where and when, each with a button that opens it in Google Maps or Google Calendar. */
export function AppointmentLinks({
  appointment,
  title,
  details,
}: {
  appointment: Appointment;
  title: string;
  details: string;
}) {
  const t = useT(procedureDict);
  const lang = useLang();
  const rows = [
    { icon: MapPin, text: appointment.address, action: t.openInMaps, url: mapsUrl(appointment) },
    {
      icon: CalendarPlus,
      text: formatAppointment(appointment, lang),
      action: t.addToCalendar,
      url: calendarUrl(appointment, title, details),
    },
  ];
  return (
    <ul className="mt-2 flex flex-col gap-2" data-testid="card-appointment">
      {rows.map(({ icon: Icon, text, action, url }) => (
        <li key={action} className="flex items-start gap-2.5">
          {/* In the arrow's column. */}
          <Icon size={14} className="mt-[3px] shrink-0 text-fg-faint" aria-hidden />
          <div className="flex min-w-0 flex-col items-start gap-0.5">
            <span className="text-fg">{text}</span>
            <Button
              variant="link"
              size="sm"
              onClick={() => void api.invoke('app.openExternal', url)}
            >
              {action}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Menu, rename
// ---------------------------------------------------------------------------------------------

export function CardMenu({
  procedure: p,
  onRename,
}: {
  procedure: ProcedureListItem;
  onRename: () => void;
}) {
  const t = useT(procedureDict);
  const tc = useT(common);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const archive = async (archived: boolean) => {
    try {
      await api.invoke('procedures.archive', p.id, archived);
      toast.success(archived ? t.archived : t.unarchived);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async () => {
    try {
      await api.invoke('procedures.delete', p.id);
      toast.success(t.deleted);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <IconButton icon={Ellipsis} label={t.menu} size="sm" data-testid="card-menu" />
        </MenuTrigger>
        <MenuContent>
          <MenuItem icon={Pencil} onSelect={onRename}>
            {t.rename}
          </MenuItem>
          {p.archived ? (
            <MenuItem icon={ArchiveRestore} onSelect={() => void archive(false)}>
              {t.unarchive}
            </MenuItem>
          ) : (
            <MenuItem icon={Archive} onSelect={() => void archive(true)}>
              {t.archive}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={Trash} danger onSelect={() => setConfirmDelete(true)}>
            {t.delete}
          </MenuItem>
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t.deleteTitle(p.title)}
        description={t.deleteBody}
        confirmLabel={t.deleteConfirm}
        cancelLabel={tc.cancel}
        onConfirm={remove}
      />
    </>
  );
}

export function TitleEditor({
  procedure: p,
  onDone,
}: {
  procedure: ProcedureListItem;
  onDone: () => void;
}) {
  const t = useT(procedureDict);
  const [value, setValue] = useState(p.title);
  const ref = useRef<HTMLInputElement>(null);
  const saved = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const save = async () => {
    if (saved.current) return;
    saved.current = true;
    const title = value.trim();
    onDone();
    if (!title || title === p.title) return;
    try {
      await api.invoke('procedures.rename', p.id, title);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      saved.current = true;
      onDone();
    }
  };

  return (
    <input
      ref={ref}
      value={value}
      maxLength={160}
      aria-label={t.renameLabel}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={onKeyDown}
      className="-ml-1.5 h-8 w-full rounded-md border border-accent bg-surface px-1.5 text-[16px] font-semibold text-fg ring-3 ring-ring/30 outline-none"
    />
  );
}
