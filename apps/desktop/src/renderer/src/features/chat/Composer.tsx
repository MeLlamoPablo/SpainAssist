import type { Attachment, DocumentMeta } from '@sa/shared';
import { ArrowUp, FileText, Image as ImageIcon, Paperclip, Square, Upload, X } from 'lucide-react';
import { Popover } from 'radix-ui';
import { type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { IconButton } from '../../components/ui/button';
import { Textarea } from '../../components/ui/field';
import { Spinner } from '../../components/ui/misc';
import { Tooltip } from '../../components/ui/tooltip';
import { useT } from '../../i18n';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { pickFiles, uploadToVault } from '../../lib/files';
import { toast } from '../../store/toast';
import { useDocuments, useVaultStore } from '../../store/vault';
import { chatDict } from './i18n';

/** What the composer accepts, for the file picker and for dropped files. */
const ACCEPT = 'image/*,application/pdf,.doc,.docx,.odt,.txt';
const ACCEPTED_EXTENSIONS = /\.(pdf|docx?|odt|txt)$/i;

function isAttachable(file: File): boolean {
  return (
    file.type.startsWith('image/') ||
    file.type === 'application/pdf' ||
    ACCEPTED_EXTENSIONS.test(file.name)
  );
}

/** Only drags that carry files (not selected text or links) turn the composer into a dropzone. */
function carriesFiles(e: DragEvent): boolean {
  return e.dataTransfer.types.includes('Files');
}

export interface ComposerProps {
  variant: 'hero' | 'chat';
  placeholder: string;
  onSubmit: (text: string, attachments: Attachment[]) => Promise<void> | void;
  working?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  disabledHint?: string;
  /** Changes to this number focus the textarea. */
  focusTick?: number;
  autoFocus?: boolean;
  procedureId?: string;
  /** Optional text to prefill (e.g. suggestion chips). */
  draft?: { text: string; tick: number };
}

export function Composer({
  variant,
  placeholder,
  onSubmit,
  working,
  onStop,
  disabled,
  disabledHint,
  focusTick,
  autoFocus,
  procedureId,
  draft,
}: ComposerProps) {
  const t = useT(chatDict);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const hero = variant === 'hero';

  useEffect(() => {
    if (focusTick !== undefined) ref.current?.focus();
  }, [focusTick]);

  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [draft]);

  const canSend = !disabled && !sending && text.trim().length > 0;

  const submit = async () => {
    if (!canSend) return;
    const value = text.trim();
    setSending(true);
    try {
      await onSubmit(value, attachments);
      setText('');
      setAttachments([]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const addAttachment = (doc: DocumentMeta) =>
    setAttachments((prev) =>
      prev.some((a) => a.documentId === doc.id)
        ? prev
        : [...prev, { documentId: doc.id, name: doc.name, mimeType: doc.mimeType }],
    );

  /** Saves the files to the vault and attaches them. */
  const uploadFiles = async (files: File[]) => {
    setUploading(true);
    try {
      for (const file of files) addAttachment(await uploadToVault(file, { procedureId }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const canDrop = !disabled && !uploading;

  const onDragOver = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = canDrop ? 'copy' : 'none';
    if (canDrop) setDragging(true);
  };

  const onDrop = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    if (!canDrop) return;
    const files = [...e.dataTransfer.files];
    const accepted = files.filter(isAttachable);
    if (accepted.length < files.length) toast.error(t.composer.unsupportedFile);
    if (accepted.length) void uploadFiles(accepted);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping is a pointer shortcut; the attach button stays the keyboard path
    <div
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        // Moving onto a child also fires dragleave: reset only when the pointer leaves the box.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      data-testid="composer"
      className={cn(
        'group/composer relative rounded-2xl border border-line-strong/70 bg-surface shadow-raised transition-[border-color,box-shadow] duration-150 focus-within:border-accent/55 focus-within:ring-4 focus-within:ring-ring/15',
        disabled && 'opacity-80',
      )}
    >
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft/95 text-[14px] font-medium text-accent-text">
          {t.composer.dropFiles}
        </div>
      ) : null}
      {attachments.length ? (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {attachments.map((a) => (
            <span
              key={a.documentId}
              className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-lg bg-surface-3 pr-1 pl-2 text-[12.5px] font-medium text-fg-muted"
            >
              {a.mimeType.startsWith('image/') ? (
                <ImageIcon size={13} aria-hidden />
              ) : (
                <FileText size={13} aria-hidden />
              )}
              <span className="truncate">{a.name}</span>
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((x) => x !== a))}
                aria-label={t.composer.removeAttachment(a.name)}
                className="flex size-5 items-center justify-center rounded text-fg-subtle hover:bg-line hover:text-fg"
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <Textarea
        ref={ref}
        autosize
        minRows={hero ? 2 : 1}
        maxRows={hero ? 8 : 10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={disabled && disabledHint ? disabledHint : placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={placeholder}
        className={cn(
          'border-0 bg-transparent shadow-none hover:border-0 focus:border-0 focus:ring-0 disabled:bg-transparent',
          hero ? 'px-5 pt-4 text-[16px] leading-[1.55]' : 'px-4 pt-3 text-[15px]',
        )}
      />
      <div
        className={cn('flex items-center justify-between gap-2', hero ? 'px-3 pb-3' : 'px-2 pb-2')}
      >
        <AttachButton
          disabled={disabled}
          uploading={uploading}
          onPick={addAttachment}
          onUpload={(file) => void uploadFiles([file])}
          selected={attachments.map((a) => a.documentId)}
        />
        <div className="flex items-center gap-3">
          {hero ? (
            <span className="hidden text-[12px] text-fg-faint @min-[560px]:inline">
              {t.composer.hint}
            </span>
          ) : null}
          {working && onStop ? (
            <Tooltip content={t.composer.stop}>
              <button
                type="button"
                onClick={onStop}
                aria-label={t.composer.stop}
                className="flex size-9 items-center justify-center rounded-full bg-fg text-surface transition-transform duration-150 hover:scale-105"
                data-testid="composer-stop"
              >
                <Square size={13} fill="currentColor" aria-hidden />
              </button>
            </Tooltip>
          ) : (
            <Tooltip content={t.composer.send}>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSend}
                aria-label={t.composer.send}
                data-testid="composer-send"
                className={cn(
                  'flex size-9 items-center justify-center rounded-full transition-[background-color,transform] duration-150',
                  canSend
                    ? 'bg-accent text-accent-fg hover:scale-105 hover:bg-accent-hover'
                    : 'bg-surface-3 text-fg-faint',
                )}
              >
                {sending ? (
                  <Spinner size={16} />
                ) : (
                  <ArrowUp size={18} strokeWidth={2.4} aria-hidden />
                )}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

function AttachButton({
  onPick,
  onUpload,
  disabled,
  uploading,
  selected,
}: {
  onPick: (doc: DocumentMeta) => void;
  onUpload: (file: File) => void;
  disabled?: boolean;
  uploading: boolean;
  selected: string[];
}) {
  const t = useT(chatDict);
  const documents = useDocuments();
  const vaultLoaded = useVaultStore((s) => s.overview !== null);
  const [open, setOpen] = useState(false);

  const upload = async () => {
    setOpen(false);
    const [file] = await pickFiles(ACCEPT);
    if (file) onUpload(file);
  };

  if (documents.length === 0) {
    return (
      <IconButton
        icon={uploading ? Upload : Paperclip}
        label={t.composer.attach}
        disabled={disabled || uploading || !vaultLoaded}
        tooltipSide="top"
        onClick={() => void upload()}
      />
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <IconButton
          icon={uploading ? Upload : Paperclip}
          label={t.composer.attach}
          disabled={disabled || uploading || !vaultLoaded}
          tooltipSide="top"
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className="z-50 w-80 animate-pop-in rounded-xl border border-line bg-surface p-1.5 shadow-pop"
        >
          <div className="max-h-60 overflow-y-auto">
            {documents.map((doc) => {
              const isSelected = selected.includes(doc.id);
              return (
                <button
                  key={doc.id}
                  type="button"
                  disabled={isSelected}
                  onClick={() => {
                    onPick(doc);
                    setOpen(false);
                  }}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-fg hover:bg-surface-3 disabled:opacity-40"
                >
                  {doc.mimeType.startsWith('image/') ? (
                    <ImageIcon size={15} className="shrink-0 text-fg-subtle" aria-hidden />
                  ) : (
                    <FileText size={15} className="shrink-0 text-fg-subtle" aria-hidden />
                  )}
                  <span className="truncate">{doc.name}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-1 border-t border-line pt-1">
            <button
              type="button"
              onClick={() => void upload()}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium text-accent-text hover:bg-accent-soft"
            >
              <Upload size={15} aria-hidden />
              {t.composer.upload}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
