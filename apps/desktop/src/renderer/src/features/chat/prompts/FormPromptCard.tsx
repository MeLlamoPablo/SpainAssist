import {
  APPOINTMENT_MORE,
  type FormField,
  type FormPrompt,
  type FormValue,
  type PersonalSaveIssue,
  type PromptItem,
  visibleFormFields,
} from '@sa/shared';
import {
  Check,
  CircleCheck,
  FileText,
  Image as ImageIcon,
  MessageSquareText,
  ScanLine,
  Upload,
} from 'lucide-react';
import { Popover, ToggleGroup } from 'radix-ui';
import { type DragEvent, type FormEvent, useCallback, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Checkbox, SegmentedControl } from '../../../components/ui/controls';
import { Field, Input, PasswordInput, Select, Textarea } from '../../../components/ui/field';
import { ProvinceSelect } from '../../../components/ui/province-select';
import { useLang, useT } from '../../../i18n';
import { common } from '../../../i18n/common';
import { api, errorMessage } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { pickFiles, uploadToVault } from '../../../lib/files';
import { toast } from '../../../store/toast';
import { useDocuments, useVaultStore } from '../../../store/vault';
import { ScanDialog } from '../../vault/ScanDialog';
import { scanDict } from '../../vault/scanI18n';
import { chatDict } from '../i18n';
import { Markdown } from '../Markdown';
import { AppointmentPicker } from './AppointmentPicker';
import {
  buildResponse,
  displayValue,
  documentScanChoice,
  type FieldError,
  fillDocumentFields,
  initialValues,
  validate,
} from './formLogic';
import { MapOptionsPicker } from './MapOptionsPicker';
import { PromptShell } from './PromptShell';

export function FormPromptCard({
  item,
  prompt,
  procedureId,
  embedded,
}: {
  item: PromptItem;
  prompt: FormPrompt;
  /** The procedure whose agent asks (undefined: the assistant asks). */
  procedureId?: string;
  /** Shown on the procedure's card. */
  embedded?: boolean;
}) {
  const t = useT(chatDict);
  const lang = useLang();
  const scanText = useT(scanDict);
  const [scanOpen, setScanOpen] = useState(false);
  const personal = useVaultStore((s) => s.overview?.personal);
  const documents = useVaultStore((s) => s.overview?.documents);
  const [{ values, savedCount, vaultErrors }, setFormState] = useState(() => ({
    values: initialValues(prompt.fields, personal ?? []),
    /** How many scanned details were saved to Mis datos (not only the ones this form uses). */
    savedCount: null as number | null,
    /** Scanned fields the vault refused; the agent hears about them with the answers. */
    vaultErrors: [] as PersonalSaveIssue[],
  }));
  const [errors, setErrors] = useState<Record<string, FieldError>>({});
  const [busy, setBusy] = useState(false);
  const [mapReady, setMapReady] = useState<Record<string, boolean>>({});
  const setMapReadyField = useCallback(
    (key: string, ready: boolean) =>
      setMapReady((prev) => (prev[key] === ready ? prev : { ...prev, [key]: ready })),
    [],
  );
  const mapsReady = visibleFormFields(prompt.fields, values).every(
    (f) => f.type !== 'map-options' || mapReady[f.key],
  );

  const scanChoice = documentScanChoice(prompt.fields, values);

  const docName = (id: string) => documents?.find((d) => d.id === id)?.name;

  const answered =
    item.response?.kind === 'form' && item.response.values ? (
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1">
        {visibleFormFields(prompt.fields, item.response.values).map((f) => {
          const shown = displayValue(
            f,
            item.response?.kind === 'form' ? item.response.values?.[f.key] : undefined,
            {
              yes: t.prompt.yes,
              no: t.prompt.no,
              hidden: t.prompt.hiddenValue,
              moreAppointments: t.prompt.appointmentMoreAsked,
            },
            docName,
            lang,
          );
          if (shown === null) return null;
          return (
            <div key={f.key} className="contents">
              <dt className="truncate text-fg-subtle">{f.label}</dt>
              <dd className="selectable truncate text-fg">{shown}</dd>
            </div>
          );
        })}
      </dl>
    ) : null;

  const respond = async (answers: typeof values) => {
    setBusy(true);
    try {
      const response = buildResponse(prompt.fields, answers);
      await api.invoke(
        'chat.respond',
        item.id,
        vaultErrors.length ? { ...response, vaultErrors } : response,
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!mapsReady) return;
    const errs = validate(prompt.fields, values);
    setErrors(errs);
    if (Object.keys(errs).length) {
      const first = prompt.fields.find((f) => errs[f.key]);
      if (first) document.getElementById(`field-${item.id}-${first.key}`)?.focus();
      return;
    }
    await respond(values);
  };

  /** None of the slots suits the user: answer now (other answers as they are) to get others. */
  const requestMore = (key: string) => void respond({ ...values, [key]: APPOINTMENT_MORE });

  const set = (key: string, value: FormValue) => {
    setFormState((prev) => ({ ...prev, values: { ...prev.values, [key]: value } }));
    if (errors[key]) setErrors(({ [key]: _gone, ...rest }) => rest);
  };

  const errorText = (e: FieldError | undefined) =>
    e === 'required'
      ? t.prompt.requiredError
      : e === 'email'
        ? t.prompt.emailError
        : e === 'phone'
          ? t.prompt.phoneError
          : e === 'number'
            ? t.prompt.numberError
            : null;

  return (
    <PromptShell
      item={item}
      icon={MessageSquareText}
      kicker={t.prompt.needsYou}
      title={prompt.title}
      embedded={embedded}
      answeredSummary={answered}
    >
      <form
        onSubmit={(e) => void onSubmit(e)}
        noValidate
        className={
          embedded && !prompt.fields.some((f) => f.type === 'map-options')
            ? 'max-w-[680px]'
            : undefined
        }
      >
        {prompt.message ? (
          <Markdown text={prompt.message} className="mb-4 text-[14px] text-fg-muted" />
        ) : null}
        {(scanChoice || savedCount !== null) && (
          <div className="mb-4 flex flex-col items-center gap-4">
            {savedCount !== null ? (
              <p
                role="status"
                className="flex items-center gap-2 text-[14.5px] font-semibold text-st-done-fg"
                data-testid="form-scan-saved"
              >
                <CircleCheck size={18} aria-hidden />
                {scanText.savedCount(savedCount)}
              </p>
            ) : scanChoice ? (
              <Button
                icon={ScanLine}
                disabled={busy}
                onClick={() => setScanOpen(true)}
                data-testid="form-scan-document"
              >
                {scanText[scanChoice]}
              </Button>
            ) : null}
            <div className="flex w-full items-center gap-3 text-[13px] text-fg-subtle">
              <span className="h-px flex-1 bg-line" aria-hidden />
              <span>{scanText.manualEntry}</span>
              <span className="h-px flex-1 bg-line" aria-hidden />
            </div>
          </div>
        )}
        <div className="@container">
          <div className="grid grid-cols-1 gap-x-4 gap-y-4 @min-[360px]:grid-cols-2">
            {visibleFormFields(prompt.fields, values).map((field) => (
              <FieldControl
                key={field.key}
                field={field}
                formId={item.id}
                value={values[field.key]}
                error={errorText(errors[field.key])}
                onChange={(v) => set(field.key, v)}
                procedureId={procedureId}
                onMapReadyChange={setMapReadyField}
                onRequestMore={() => requestMore(field.key)}
                busy={busy}
              />
            ))}
          </div>
        </div>

        {mapsReady && (
          <div className={cn('mt-5 flex items-center gap-2', !embedded && 'justify-end')}>
            <Button type="submit" variant="primary" icon={Check} loading={busy} disabled={busy}>
              {prompt.submitLabel ?? t.prompt.submit}
            </Button>
          </div>
        )}
      </form>
      <ScanDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        onSaved={(scanned, rejected) => {
          setFormState((current) => {
            const rejectedKeys = new Set(rejected.map((issue) => issue.key));
            // A later scan replaces what an earlier one reported for the same fields.
            const rescanned = new Set(scanned.map((entry) => entry.key));
            return {
              values: fillDocumentFields(prompt.fields, current.values, scanned),
              savedCount: [...rescanned].filter((key) => !rejectedKeys.has(key)).length,
              vaultErrors: [
                ...current.vaultErrors.filter((issue) => !rescanned.has(issue.key)),
                ...rejected,
              ],
            };
          });
          setErrors({});
        }}
      />
    </PromptShell>
  );
}

/** Short answers (dates, phones, numbers, codes) sit two per row; everything else is full width. */
function wide(field: FormField): boolean {
  const short =
    field.type === 'date' ||
    field.type === 'phone' ||
    field.type === 'number' ||
    field.type === 'secret';
  return !short || field.label.length > 38;
}

function FieldControl({
  field,
  formId,
  value,
  error,
  onChange,
  procedureId,
  onMapReadyChange,
  onRequestMore,
  busy,
}: {
  field: FormField;
  formId: string;
  value: FormValue | undefined;
  error: string | null;
  onChange: (value: FormValue) => void;
  procedureId?: string;
  onMapReadyChange: (key: string, ready: boolean) => void;
  onRequestMore: () => void;
  busy: boolean;
}) {
  const t = useT(chatDict);
  const readyChange = useCallback(
    (ready: boolean) => onMapReadyChange(field.key, ready),
    [field.key, onMapReadyChange],
  );
  const tc = useT(common);
  const inputId = `field-${formId}-${field.key}`;
  const str = typeof value === 'string' ? value : '';
  const span = wide(field) ? '@min-[360px]:col-span-2' : '';

  if (field.type === 'boolean') {
    const question = field.label.trim().endsWith('?');
    if (question) {
      return (
        <div className={cn('flex items-center justify-between gap-4', span)}>
          <span className="text-[13.5px] font-medium text-fg">{field.label}</span>
          <SegmentedControl
            label={field.label}
            value={value === true ? 'yes' : 'no'}
            onValueChange={(v) => onChange(v === 'yes')}
            options={[
              { value: 'yes', label: t.prompt.yes },
              { value: 'no', label: t.prompt.no },
            ]}
          />
        </div>
      );
    }
    return (
      <Checkbox
        className={span}
        checked={value === true}
        onCheckedChange={onChange}
        label={field.label}
        description={field.help}
      />
    );
  }

  return (
    <Field
      id={inputId}
      label={field.label}
      help={field.type === 'secret' ? (field.help ?? t.prompt.secretHint) : field.help}
      error={error}
      required={field.required}
      optionalLabel={tc.optional}
      className={span}
    >
      {({ describedBy, invalid }) => {
        const common = {
          id: inputId,
          'aria-describedby': describedBy,
          'aria-invalid': invalid || undefined,
          'aria-required': field.required || undefined,
        };
        switch (field.type) {
          case 'map-options':
            return (
              <MapOptionsPicker
                promptId={formId}
                field={field}
                value={str}
                onChange={onChange}
                inputId={inputId}
                describedBy={describedBy}
                invalid={invalid}
                onReadyChange={readyChange}
              />
            );
          case 'appointment':
            return (
              <AppointmentPicker
                field={field}
                value={str === APPOINTMENT_MORE ? '' : str}
                onChange={onChange}
                onRequestMore={onRequestMore}
                busy={busy}
                inputId={inputId}
                describedBy={describedBy}
                invalid={invalid}
              />
            );
          case 'textarea':
            return (
              <Textarea
                {...common}
                autosize
                minRows={3}
                maxRows={8}
                value={str}
                placeholder={field.placeholder}
                onChange={(e) => onChange(e.target.value)}
              />
            );
          case 'select': {
            const options = field.options ?? [];
            const chips =
              options.length > 0 &&
              options.length <= 3 &&
              options.every((o) => o.label.length <= 22);
            if (chips) {
              return (
                <ToggleGroup.Root
                  type="single"
                  value={str}
                  onValueChange={(v) => v && onChange(v)}
                  aria-label={field.label}
                  className="flex flex-wrap gap-2"
                  {...common}
                >
                  {options.map((o) => (
                    <ToggleGroup.Item key={o.value} value={o.value} className={chipClass}>
                      {o.label}
                    </ToggleGroup.Item>
                  ))}
                </ToggleGroup.Root>
              );
            }
            return (
              <Select {...common} value={str} onChange={(e) => onChange(e.target.value)}>
                {str === '' ? <option value="">{t.prompt.chooseOne}</option> : null}
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            );
          }
          case 'province':
            return (
              <ProvinceSelect
                {...common}
                aria-label={field.label}
                value={str}
                onValueChange={onChange}
              />
            );
          case 'multiselect': {
            const list = Array.isArray(value) ? value : [];
            return (
              <ToggleGroup.Root
                type="multiple"
                value={list}
                onValueChange={(v) => onChange(v)}
                aria-label={field.label}
                className="flex flex-wrap gap-2"
                {...common}
              >
                {(field.options ?? []).map((o) => (
                  <ToggleGroup.Item key={o.value} value={o.value} className={chipClass}>
                    <Check size={14} className="hidden in-data-[state=on]:inline" aria-hidden />
                    {o.label}
                  </ToggleGroup.Item>
                ))}
              </ToggleGroup.Root>
            );
          }
          case 'document':
            return (
              <DocumentPicker
                inputId={inputId}
                value={str}
                onChange={onChange}
                procedureId={procedureId}
                describedBy={describedBy}
              />
            );
          case 'secret':
            return (
              <PasswordInput
                {...common}
                value={str}
                placeholder={field.placeholder}
                onChange={(e) => onChange(e.target.value)}
                revealLabel={t.prompt.reveal}
                hideLabel={t.prompt.hide}
                className="font-mono tracking-wider"
              />
            );
          default:
            return (
              <Input
                {...common}
                type={
                  field.type === 'email'
                    ? 'email'
                    : field.type === 'phone'
                      ? 'tel'
                      : field.type === 'date'
                        ? 'date'
                        : 'text'
                }
                inputMode={field.type === 'number' ? 'decimal' : undefined}
                autoComplete={
                  field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'off'
                }
                value={str}
                placeholder={field.placeholder}
                onChange={(e) => onChange(e.target.value)}
                className={
                  field.type === 'number' || field.type === 'date' ? 'max-w-56' : undefined
                }
              />
            );
        }
      }}
    </Field>
  );
}

const chipClass =
  'inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong/70 bg-surface px-3.5 text-[13.5px] font-medium text-fg-muted shadow-xs transition-colors duration-150 hover:border-line-strong hover:text-fg data-[state=on]:border-accent data-[state=on]:bg-accent-soft data-[state=on]:text-accent-text';

function DocumentPicker({
  inputId,
  value,
  onChange,
  procedureId,
  describedBy,
}: {
  inputId: string;
  value: string;
  onChange: (id: string) => void;
  procedureId?: string;
  describedBy?: string;
}) {
  const t = useT(chatDict);
  const documents = useDocuments();
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const chosen = documents.find((d) => d.id === value);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const doc = await uploadToVault(file, { procedureId });
      onChange(doc.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (uploading) return;
    const files = [...e.dataTransfer.files];
    const file = files.find((f) => f.type.startsWith('image/') || f.type === 'application/pdf');
    if (file) void upload(file);
    else if (files.length > 0) toast.error(t.prompt.unsupportedDocument);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping is a pointer shortcut; the buttons stay the keyboard path
    <div
      id={inputId}
      tabIndex={-1}
      aria-describedby={describedBy}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // Moving onto a child also fires dragleave: reset only when the pointer leaves the box.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      data-testid="form-document-dropzone"
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-2 transition-colors duration-150',
        dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface-2/60',
      )}
    >
      {dragging ? (
        <span className="flex-1 px-1.5 text-[13px] font-medium text-accent-text">
          {t.prompt.dropDocument}
        </span>
      ) : chosen ? (
        <span className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md bg-surface px-2.5 py-1.5 shadow-xs ring-1 ring-line">
          {chosen.mimeType.startsWith('image/') ? (
            <ImageIcon size={16} className="shrink-0 text-accent-text" aria-hidden />
          ) : (
            <FileText size={16} className="shrink-0 text-accent-text" aria-hidden />
          )}
          <span className="truncate text-[13.5px] font-medium text-fg">{chosen.name}</span>
        </span>
      ) : (
        <span className="flex-1 px-1.5 text-[13px] text-fg-subtle">{t.prompt.noDocument}</span>
      )}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button size="sm" variant="secondary" icon={FileText}>
            {chosen ? t.prompt.changeDocument : t.prompt.pickDocument}
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            className="z-50 max-h-72 w-80 animate-pop-in overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-pop"
          >
            {documents.length === 0 ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-muted">{t.composer.noDocuments}</p>
            ) : (
              documents.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => {
                    onChange(doc.id);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] hover:bg-surface-3',
                    doc.id === value ? 'font-semibold text-accent-text' : 'text-fg',
                  )}
                >
                  <FileText size={15} className="shrink-0 text-fg-subtle" aria-hidden />
                  <span className="truncate">{doc.name}</span>
                  {doc.id === value ? (
                    <Check size={14} className="ml-auto shrink-0" aria-hidden />
                  ) : null}
                </button>
              ))
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <Button
        size="sm"
        variant="ghost"
        icon={Upload}
        loading={uploading}
        onClick={async () => upload((await pickFiles('image/*,application/pdf'))[0])}
      >
        {t.prompt.uploadDocument}
      </Button>
    </div>
  );
}
