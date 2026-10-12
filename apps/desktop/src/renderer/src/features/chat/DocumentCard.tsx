import type { DocumentMeta } from '@sa/shared';
import { Download, FileText, FileX, Image as ImageIcon } from 'lucide-react';
import { IconButton } from '../../components/ui/button';
import { useLang, useT } from '../../i18n';
import { formatBytes } from '../../lib/format';
import { useProcedureStore } from '../../store/procedures';
import { useVaultStore } from '../../store/vault';
import { openDocument, useDownloadDocument } from '../vault/document-actions';
import { fileTypeLabel } from './document-links';
import { chatDict } from './i18n';

/**
 * A saved document. Undefined while the vault has not loaded yet; null if there is no such
 * document (unknown or deleted). Chat text holds only the id: everything else comes from here.
 */
export function useSavedDocument(id: string): DocumentMeta | null | undefined {
  return useVaultStore((s) =>
    s.overview ? (s.overview.documents.find((d) => d.id === id) ?? null) : undefined,
  );
}

/** A saved document the assistant shows in its message (`sa:document/<id>` on its own line). */
export function DocumentCard({ id }: { id: string }) {
  const doc = useSavedDocument(id);
  if (doc === undefined) return <div className="h-[64px] rounded-xl border border-line" />;
  if (doc === null) return <MissingDocument />;
  return <SavedDocumentCard doc={doc} />;
}

function SavedDocumentCard({ doc }: { doc: DocumentMeta }) {
  const t = useT(chatDict);
  const lang = useLang();
  const procedure = useProcedureStore((s) =>
    doc.procedureId ? s.byId[doc.procedureId] : undefined,
  );
  const { download, downloading } = useDownloadDocument(doc.id);
  const Icon = doc.mimeType.startsWith('image/') ? ImageIcon : FileText;
  const meta = [
    fileTypeLabel(doc.mimeType, doc.name),
    formatBytes(doc.size, lang),
    procedure?.title,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      className="flex items-center gap-1 rounded-xl border border-line bg-surface p-1.5 pr-2 leading-normal shadow-raised transition-colors duration-150 hover:border-line-strong"
      data-testid="document-card"
    >
      <button
        type="button"
        onClick={() => openDocument(doc.id)}
        title={t.document.open(doc.name)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1.5 text-left"
      >
        <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] bg-st-done-bg text-st-done-fg">
          <Icon size={18} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-fg">{doc.name}</span>
          {meta ? (
            <span className="mt-0.5 block truncate text-[12px] text-fg-subtle">{meta}</span>
          ) : null}
        </span>
      </button>
      <IconButton
        icon={Download}
        label={t.document.download}
        disabled={downloading}
        onClick={download}
      />
    </div>
  );
}

function MissingDocument() {
  const t = useT(chatDict);
  return (
    <div
      className="flex items-center gap-2.5 rounded-xl border border-dashed border-line px-3.5 py-3 text-[13px] leading-normal text-fg-subtle"
      data-testid="document-missing"
    >
      <FileX size={16} aria-hidden />
      {t.document.unavailable}
    </div>
  );
}
