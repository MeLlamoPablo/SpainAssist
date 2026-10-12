import type { DocumentMeta, VaultOverview } from '@sa/shared';
import {
  Download,
  FileText,
  FolderOpen,
  IdCard,
  Image as ImageIcon,
  Receipt,
  SquareArrowOutUpRight,
  Trash,
  Upload,
} from 'lucide-react';
import { useState } from 'react';
import { Button, IconButton } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Card, EmptyState } from '../../components/ui/misc';
import { useLang, useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api, errorMessage } from '../../lib/api';
import { pickFiles, uploadToVault } from '../../lib/files';
import { formatBytes, formatDate } from '../../lib/format';
import { useAppStore } from '../../store/app';
import { useProcedureStore } from '../../store/procedures';
import { toast } from '../../store/toast';
import { useVaultStore } from '../../store/vault';
import { vaultDict } from './i18n';

function DocIcon({ doc }: { doc: DocumentMeta }) {
  const Icon =
    doc.kind === 'id_document'
      ? IdCard
      : doc.kind === 'receipt'
        ? Receipt
        : doc.mimeType.startsWith('image/')
          ? ImageIcon
          : FileText;
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
      <Icon size={18} aria-hidden />
    </span>
  );
}

export function DocumentsSection({ overview }: { overview: VaultOverview }) {
  const t = useT(vaultDict);
  const [uploading, setUploading] = useState(false);

  const upload = async () => {
    const files = await pickFiles('image/*,application/pdf,.doc,.docx,.odt,.txt', true);
    if (!files.length) return;
    setUploading(true);
    try {
      for (const file of files) await uploadToVault(file);
      useVaultStore.getState().set(await api.invoke('vault.overview'));
      toast.success(t.documents.uploaded);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const uploadButton = (
    <Button variant="secondary" icon={Upload} loading={uploading} onClick={() => void upload()}>
      {t.documents.upload}
    </Button>
  );

  return (
    <div>
      {overview.documents.length === 0 ? (
        <Card>
          <EmptyState icon={FolderOpen} title={t.documents.empty} action={uploadButton}>
            {t.documents.emptyHint}
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="mb-5 flex justify-end">{uploadButton}</div>
          <Card className="divide-y divide-line">
            {overview.documents.map((doc) => (
              <DocumentRow key={doc.id} doc={doc} />
            ))}
          </Card>
        </>
      )}
    </div>
  );
}

function DocumentRow({ doc }: { doc: DocumentMeta }) {
  const t = useT(vaultDict);
  const tc = useT(common);
  const lang = useLang();
  const focusProcedure = useAppStore((s) => s.focusProcedure);
  const procedure = useProcedureStore((s) =>
    doc.procedureId ? s.byId[doc.procedureId] : undefined,
  );
  const [confirm, setConfirm] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      const name = await api.invoke('vault.downloadDocument', doc.id);
      toast.success(t.documents.downloaded(name));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  const remove = async () => {
    try {
      useVaultStore.getState().set(await api.invoke('vault.deleteDocument', doc.id));
      toast.success(t.documents.deleted);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="group flex items-center gap-3.5 px-4 py-3" data-testid="document-row">
      <DocIcon doc={doc} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium text-fg">{doc.name}</p>
        {/* One line: a long procedure title truncates instead of wrapping after a "·". */}
        <p className="mt-0.5 flex items-center gap-x-1.5 whitespace-nowrap text-[12.5px] text-fg-subtle">
          <span>{tc.documentKind[doc.kind]}</span>
          <span aria-hidden>·</span>
          <span>{formatBytes(doc.size, lang)}</span>
          <span aria-hidden>·</span>
          <span>{formatDate(doc.createdAt, lang)}</span>
          {procedure ? (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                title={procedure.title}
                onClick={() => focusProcedure(procedure.id)}
                className="min-w-0 truncate font-medium text-accent-text hover:underline"
              >
                {procedure.title}
              </button>
            </>
          ) : null}
        </p>
      </div>
      <div className="flex items-center gap-0.5">
        <IconButton
          icon={Download}
          label={t.documents.download}
          disabled={downloading}
          onClick={() => void download()}
        />
        <IconButton
          icon={SquareArrowOutUpRight}
          label={t.documents.open}
          onClick={() =>
            void api.invoke('vault.openDocument', doc.id).catch((e) => toast.error(errorMessage(e)))
          }
        />
        <IconButton icon={Trash} label={t.documents.remove} onClick={() => setConfirm(true)} />
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t.documents.deleteTitle(doc.name)}
        description={t.documents.deleteBody}
        confirmLabel={tc.delete}
        cancelLabel={tc.cancel}
        onConfirm={remove}
      />
    </div>
  );
}
