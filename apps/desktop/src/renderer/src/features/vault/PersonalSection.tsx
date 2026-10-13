import {
  DOCUMENT_FIELD_GROUPS,
  PERSONAL_FIELDS,
  type PersonalDataItem,
  type PersonalFieldDef,
  type PersonalFieldGroup,
  personalFieldDef,
  type VaultOverview,
} from '@sa/shared';
import { Check, IdCard, Pencil, Plus, ScanLine, Trash, X } from 'lucide-react';
import { type KeyboardEvent, useMemo, useState } from 'react';
import { Button, IconButton } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Input, Select } from '../../components/ui/field';
import { Card, EmptyState } from '../../components/ui/misc';
import { Tooltip } from '../../components/ui/tooltip';
import { type Lang, useLang, useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatLongDate } from '../../lib/format';
import { useAppStore } from '../../store/app';
import { toast } from '../../store/toast';
import { useVaultStore } from '../../store/vault';
import { vaultDict } from './i18n';
import { LicenceCategoryEditor, LicenceCategoryTable } from './LicenceCategories';
import { type RenewableDocument, renewableDocument } from './renewal';
import { ScanDialog } from './ScanDialog';

const GROUPS: PersonalFieldGroup[] = [
  'identity',
  ...DOCUMENT_FIELD_GROUPS,
  'contact',
  'address',
  'other',
];

function personalLabel(def: PersonalFieldDef, lang: Lang): string {
  if (def.key === 'addressStreet') return lang === 'es' ? 'Dirección' : 'Address';
  return def.label[lang].replace(/^Fecha de (.)/, (_, initial: string) => initial.toUpperCase());
}

/** Display value for a personal data item (select labels, long dates). */
function displayPersonal(key: string, value: string, lang: Lang): string {
  if (key === 'dniExpiry' && value.startsWith('9999-'))
    return lang === 'es' ? 'Permanente' : 'Permanent';
  const def = personalFieldDef(key);
  if (!def) return value;
  if (def.input === 'select') {
    return def.options?.find((o) => o.value === value)?.label[lang] ?? value;
  }
  if (def.input === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatLongDate(value, lang);
  return value;
}

/** Asks the assistant to renew a document (or drafts the ask until a model is set up). */
function useRenew() {
  const t = useT(vaultDict);
  const lang = useLang();
  const configured = useAppStore((s) => Boolean(s.provider?.configured));
  const focusComposer = useAppStore((s) => s.focusComposer);
  return async ({ group, days }: RenewableDocument, expiry: string) => {
    const text = t.personal.renewMessage(group, formatLongDate(expiry, lang), days < 0);
    if (!configured) {
      focusComposer(text);
      return;
    }
    try {
      await api.invoke('chat.send', { text });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
}

async function save(key: string, value: string, label?: string) {
  const overview = await api.invoke('vault.setPersonal', [{ key, value, label }]);
  useVaultStore.getState().set(overview);
}

export function PersonalSection({ overview }: { overview: VaultOverview }) {
  const t = useT(vaultDict);
  const [scanOpen, setScanOpen] = useState(false);
  const byKey = useMemo(
    () => new Map(overview.personal.map((p) => [p.key, p])),
    [overview.personal],
  );
  const custom = useMemo(
    () => overview.personal.filter((p) => !personalFieldDef(p.key)),
    [overview.personal],
  );
  const empty = overview.personal.length === 0;

  return (
    <div className="@container/personal">
      {!empty ? (
        <div className="mb-5 flex items-center gap-2">
          <Button
            variant="secondary"
            icon={ScanLine}
            onClick={() => setScanOpen(true)}
            data-testid="scan-document"
          >
            {t.personal.scan}
          </Button>
        </div>
      ) : null}

      {empty ? (
        <Card className="mb-4">
          <EmptyState
            icon={IdCard}
            title={t.personal.empty}
            action={
              <Button
                variant="secondary"
                icon={ScanLine}
                onClick={() => setScanOpen(true)}
                data-testid="scan-document"
              >
                {t.personal.scan}
              </Button>
            }
          >
            {t.personal.emptyHint}
          </EmptyState>
        </Card>
      ) : null}

      <div className="flex flex-col gap-4">
        {GROUPS.map((group) => {
          const defs = PERSONAL_FIELDS.filter((f) => f.group === group);
          if (DOCUMENT_FIELD_GROUPS.some((g) => g === group) && !defs.some((d) => byKey.has(d.key)))
            return null;
          return <GroupCard key={group} group={group} defs={defs} byKey={byKey} />;
        })}
        {custom.length ? (
          <Card className="overflow-hidden">
            <h3 className="px-4 py-3.5 text-[13px] font-semibold text-fg">{t.personal.custom}</h3>
            <div className="grid grid-cols-1 gap-x-6 px-4 pb-2 @min-[480px]/personal:grid-cols-2 @min-[680px]/personal:grid-cols-3">
              {custom.map((item) => (
                <PersonalRow key={item.key} itemKey={item.key} label={item.label} item={item} />
              ))}
            </div>
          </Card>
        ) : null}
      </div>

      <ScanDialog open={scanOpen} onOpenChange={setScanOpen} />
    </div>
  );
}

function GroupCard({
  group,
  defs,
  byKey,
}: {
  group: PersonalFieldGroup;
  defs: readonly PersonalFieldDef[];
  byKey: Map<string, PersonalDataItem>;
}) {
  const t = useT(vaultDict);
  const lang = useLang();
  const [adding, setAdding] = useState<string | null>(null);
  const filled = defs.filter((d) => byKey.has(d.key) || d.key === adding);
  const missing = defs.filter((d) => !byKey.has(d.key) && d.key !== adding);

  return (
    <Card className="overflow-hidden" data-testid={`personal-group-${group}`}>
      <h3 className="px-4 py-3.5 text-[13px] font-semibold text-fg">{t.personal.groups[group]}</h3>
      {filled.length ? (
        <div className="grid grid-cols-1 gap-x-6 px-4 pb-2 @min-[480px]/personal:grid-cols-2 @min-[680px]/personal:grid-cols-3">
          {filled.map((def) => (
            <PersonalRow
              key={def.key}
              itemKey={def.key}
              label={personalLabel(def, lang)}
              item={byKey.get(def.key)}
              def={def}
              startEditing={def.key === adding}
              onDoneAdding={() => setAdding(null)}
            />
          ))}
        </div>
      ) : null}
      {missing.length ? (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-1 pb-3">
          <span className="mr-1 text-[12.5px] text-fg-subtle">{t.personal.addField}:</span>
          {missing.map((def) => (
            <button
              key={def.key}
              type="button"
              onClick={() => setAdding(def.key)}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-line-strong px-2.5 text-[12.5px] text-fg-muted hover:border-accent-line hover:bg-accent-soft hover:text-accent-text"
            >
              <Plus size={12} aria-hidden />
              {personalLabel(def, lang)}
            </button>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function PersonalRow({
  itemKey,
  label,
  item,
  def,
  startEditing,
  onDoneAdding,
}: {
  itemKey: string;
  label: string;
  item?: PersonalDataItem;
  def?: PersonalFieldDef;
  startEditing?: boolean;
  onDoneAdding?: () => void;
}) {
  const t = useT(vaultDict);
  const tc = useT(common);
  const lang = useLang();
  const [editing, setEditing] = useState(Boolean(startEditing));
  const [draft, setDraft] = useState(item?.value ?? '');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const stop = () => {
    setEditing(false);
    onDoneAdding?.();
  };

  const commit = async () => {
    const value = draft.trim();
    if (!value || value === item?.value) {
      stop();
      return;
    }
    setBusy(true);
    try {
      await save(itemKey, value, def ? undefined : label);
      toast.success(t.personal.updated);
      stop();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      const overview = await api.invoke('vault.deletePersonal', [itemKey]);
      useVaultStore.getState().set(overview);
      toast.success(t.personal.deleted);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(item?.value ?? '');
      stop();
    }
  };

  const renewable = item ? renewableDocument(itemKey, item.value) : null;
  const expiryHint = renewable ? t.personal.expiresIn(renewable.days) : null;
  const renew = useRenew();
  const categories = def?.input === 'licenceCategories';
  const labelContent = (
    <span
      className={cn(
        'col-start-1 row-start-1 text-[13px]',
        expiryHint ? 'text-st-attention-fg' : 'text-fg-muted',
        // The category table's own column headers name it.
        categories && 'sr-only',
      )}
    >
      {label}
    </span>
  );
  const valueContent = categories ? (
    <div className="col-span-2 col-start-1 row-span-2 row-start-1 min-w-0">
      {item ? <LicenceCategoryTable value={item.value} /> : null}
    </div>
  ) : renewable && item ? (
    <button
      type="button"
      onClick={() => void renew(renewable, item.value)}
      className="col-span-2 col-start-1 row-start-2 min-w-0 justify-self-start break-words rounded-sm text-left text-[14px] font-medium text-st-attention-fg transition-colors duration-150 hover:text-accent-text"
      data-testid={`renew-${renewable.group}`}
    >
      {displayPersonal(itemKey, item.value, lang)}
    </button>
  ) : (
    <span className="selectable col-span-2 col-start-1 row-start-2 min-w-0 break-words text-[14px] font-medium text-fg">
      {item ? displayPersonal(itemKey, item.value, lang) : ''}
    </span>
  );

  return (
    <div
      className={cn(
        'group grid min-w-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[minmax(28px,auto)_auto] items-center gap-x-2 gap-y-1 py-2',
        categories && 'col-span-full',
      )}
      data-testid={`personal-row-${itemKey}`}
    >
      {expiryHint && !editing ? (
        <Tooltip content={expiryHint}>{labelContent}</Tooltip>
      ) : (
        labelContent
      )}
      {editing && categories ? (
        <LicenceCategoryEditor
          label={label}
          value={draft}
          busy={busy}
          onChange={setDraft}
          onKeyDown={onKeyDown}
          onSave={() => void commit()}
          onCancel={() => {
            setDraft(item?.value ?? '');
            stop();
          }}
        />
      ) : editing ? (
        <div className="col-span-2 col-start-1 row-start-2 flex min-w-0 items-center gap-2">
          {def?.input === 'select' ? (
            <Select
              aria-label={label}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              className="h-9"
              autoFocus
            >
              <option value="" disabled>
                {t.personal.chooseOption}
              </option>
              {def.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label[lang]}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              aria-label={label}
              type={
                def?.input === 'date'
                  ? 'date'
                  : def?.input === 'email'
                    ? 'email'
                    : def?.input === 'phone'
                      ? 'tel'
                      : 'text'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              className="h-9"
              autoFocus
            />
          )}
          <IconButton
            icon={Check}
            label={tc.save}
            variant="primary"
            size="md"
            onClick={() => void commit()}
            disabled={busy}
          />
          <IconButton
            icon={X}
            label={tc.cancel}
            onClick={() => {
              setDraft(item?.value ?? '');
              stop();
            }}
          />
        </div>
      ) : renewable ? (
        <Tooltip content={t.personal.renew(renewable.group)}>{valueContent}</Tooltip>
      ) : (
        valueContent
      )}
      {!editing ? (
        <span className="col-start-2 row-span-2 row-start-1 flex items-center gap-1 self-center">
          <span className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
            <IconButton
              icon={Pencil}
              size="sm"
              label={t.personal.edit(label)}
              onClick={() => setEditing(true)}
            />
            <IconButton
              icon={Trash}
              size="sm"
              label={t.personal.remove(label)}
              onClick={() => setConfirm(true)}
            />
          </span>
        </span>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t.personal.deleteTitle(label)}
        description={t.personal.deleteBody}
        confirmLabel={tc.delete}
        cancelLabel={tc.cancel}
        onConfirm={remove}
      />
    </div>
  );
}
