import { LicenceCategories, type LicenceCategory } from '@sa/shared';
import { Check, Plus, Trash, X } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { Button, IconButton } from '../../components/ui/button';
import { Input } from '../../components/ui/field';
import { useLang, useT } from '../../i18n';
import { common } from '../../i18n/common';
import { cn } from '../../lib/cn';
import { formatDate } from '../../lib/format';
import { vaultDict } from './i18n';

/** Saved `drivingLicenceCategories` rows, or null when the value isn't a valid category list. */
function parseCategories(value: string): LicenceCategory[] | null {
  try {
    const rows = LicenceCategories.safeParse(JSON.parse(value));
    return rows.success ? rows.data : null;
  } catch {
    return null;
  }
}

/** Driving licence categories with their dates and restrictions (columns 9–12). */
export function LicenceCategoryTable({ value }: { value: string }) {
  const t = useT(vaultDict);
  const lang = useLang();
  const rows = parseCategories(value);
  if (!rows) return <span className="text-[14px] font-medium text-fg">{value}</span>;
  const restrictions = rows.some((row) => row.restrictions);
  return (
    <table className={cn('w-full text-left text-[14px]', restrictions ? 'max-w-2xl' : 'max-w-lg')}>
      <thead>
        <tr className="text-[12.5px] text-fg-muted">
          <th className="py-1 pr-4 font-normal">{t.personal.categories.category}</th>
          <th className="py-1 pr-4 font-normal">{t.personal.categories.issueDate}</th>
          <th className="py-1 pr-4 font-normal">{t.personal.categories.expiry}</th>
          {restrictions ? (
            <th className="py-1 font-normal">{t.personal.categories.restrictions}</th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.category} className="selectable border-t border-line font-medium text-fg">
            <td className="py-1.5 pr-4">{row.category}</td>
            <td className="py-1.5 pr-4">{row.issueDate ? formatDate(row.issueDate, lang) : '—'}</td>
            <td className="py-1.5 pr-4">{row.expiry ? formatDate(row.expiry, lang) : '—'}</td>
            {restrictions ? <td className="py-1.5">{row.restrictions ?? '—'}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const EMPTY_ROW: LicenceCategory = { category: '' };

/** Edits the rows as a table. `onChange` gets the JSON the vault stores ('' with no rows). */
export function LicenceCategoryEditor({
  label,
  value,
  busy,
  onChange,
  onKeyDown,
  onSave,
  onCancel,
}: {
  label: string;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useT(vaultDict);
  const tc = useT(common);
  const [rows, setRows] = useState<LicenceCategory[]>(() => parseCategories(value) ?? [EMPTY_ROW]);

  const update = (next: LicenceCategory[]) => {
    setRows(next);
    const filled = next
      .map((row) => ({
        category: row.category.trim().toUpperCase(),
        ...(row.issueDate ? { issueDate: row.issueDate } : {}),
        ...(row.expiry ? { expiry: row.expiry } : {}),
        ...(row.restrictions?.trim() ? { restrictions: row.restrictions.trim() } : {}),
      }))
      .filter((row) => row.category || row.issueDate || row.expiry || row.restrictions);
    onChange(filled.length ? JSON.stringify(filled) : '');
  };
  const set = (index: number, patch: Partial<LicenceCategory>) =>
    update(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className="col-span-2 col-start-1 row-span-2 row-start-1 flex min-w-0 flex-col gap-2">
      <fieldset
        aria-label={label}
        className="m-0 grid max-w-2xl border-0 p-0 grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2"
      >
        <span className="text-[12.5px] text-fg-muted">{t.personal.categories.category}</span>
        <span className="text-[12.5px] text-fg-muted">{t.personal.categories.issueDate}</span>
        <span className="text-[12.5px] text-fg-muted">{t.personal.categories.expiry}</span>
        <span className="text-[12.5px] text-fg-muted">{t.personal.categories.restrictions}</span>
        <span />
        {rows.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id while being typed
          <div key={index} className="contents">
            <Input
              aria-label={t.personal.categories.category}
              value={row.category}
              onChange={(e) => set(index, { category: e.target.value.toUpperCase() })}
              onKeyDown={onKeyDown}
              className="h-9"
              autoFocus={index === rows.length - 1}
            />
            <Input
              aria-label={t.personal.categories.issueDate}
              type="date"
              value={row.issueDate ?? ''}
              onChange={(e) => set(index, { issueDate: e.target.value || undefined })}
              onKeyDown={onKeyDown}
              className="h-9"
            />
            <Input
              aria-label={t.personal.categories.expiry}
              type="date"
              value={row.expiry ?? ''}
              onChange={(e) => set(index, { expiry: e.target.value || undefined })}
              onKeyDown={onKeyDown}
              className="h-9"
            />
            <Input
              aria-label={t.personal.categories.restrictions}
              value={row.restrictions ?? ''}
              onChange={(e) => set(index, { restrictions: e.target.value || undefined })}
              onKeyDown={onKeyDown}
              className="h-9"
            />
            <IconButton
              icon={Trash}
              size="sm"
              label={t.personal.categories.removeRow}
              onClick={() => update(rows.filter((_, i) => i !== index))}
            />
          </div>
        ))}
      </fieldset>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" icon={Plus} onClick={() => setRows([...rows, EMPTY_ROW])}>
          {t.personal.categories.addRow}
        </Button>
        <span className="flex-1" />
        <IconButton
          icon={Check}
          label={tc.save}
          variant="primary"
          size="md"
          onClick={onSave}
          disabled={busy}
        />
        <IconButton icon={X} label={tc.cancel} onClick={onCancel} />
      </div>
    </div>
  );
}
