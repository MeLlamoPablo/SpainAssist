import type { DocumentMeta, DocumentSignature, VaultOverview } from '@sa/shared';
import {
  Download,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Signature,
  SquareArrowOutUpRight,
  Trash,
  Upload,
} from 'lucide-react';
import { HoverCard } from 'radix-ui';
import { useState } from 'react';
import { Button, IconButton } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Card, EmptyState } from '../../components/ui/misc';
import { useLang, useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api, errorMessage } from '../../lib/api';
import { pickFiles, uploadToVault } from '../../lib/files';
import { formatBytes, formatDate, formatDateTime } from '../../lib/format';
import { useAppStore } from '../../store/app';
import { useProcedureStore } from '../../store/procedures';
import { toast } from '../../store/toast';
import { useVaultStore } from '../../store/vault';
import { openDocument, useDownloadDocument } from './document-actions';
import { vaultDict } from './i18n';

function DocIcon({ doc }: { doc: DocumentMeta }) {
  const Icon = doc.mimeType.startsWith('image/') ? ImageIcon : FileText;
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
  const { download, downloading } = useDownloadDocument(doc.id);

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
          <span>{formatBytes(doc.size, lang)}</span>
          <span aria-hidden>·</span>
          <span>{formatDate(doc.createdAt, lang)}</span>
          {doc.signedAt ? (
            <>
              <span aria-hidden>·</span>
              <SignedMark doc={doc} />
            </>
          ) : null}
          {procedure ? (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                title={procedure.title}
                onClick={() => focusProcedure(procedure.id)}
                className="min-w-0 truncate transition-colors duration-150 hover:text-fg hover:underline"
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
          onClick={download}
        />
        <IconButton
          icon={SquareArrowOutUpRight}
          label={t.documents.open}
          onClick={() => openDocument(doc.id)}
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

/** "Firmado", and on hover who signed the document, when and with which certificate. */
function SignedMark({ doc }: { doc: DocumentMeta }) {
  const t = useT(vaultDict);
  const lang = useLang();
  const [signatures, setSignatures] = useState<DocumentSignature[] | null>(null);
  // Read again after the document is signed once more.
  const [readFor, setReadFor] = useState<string>();
  const version = `${doc.id}@${doc.signedAt}`;

  const read = (open: boolean) => {
    if (!open || readFor === version) return;
    setReadFor(version);
    setSignatures(null);
    api.invoke('vault.documentSignatures', doc.id).then(setSignatures, () => setSignatures([]));
  };

  const certificate = (s: DocumentSignature) =>
    s.dnie
      ? t.documents.certificateDnie
      : /FNMT/i.test(s.issuer)
        ? t.documents.certificateFnmt
        : t.documents.certificateOther(s.issuer);

  return (
    <HoverCard.Root openDelay={150} closeDelay={120} onOpenChange={read}>
      <HoverCard.Trigger asChild>
        <button
          type="button"
          className="flex cursor-default items-center gap-1 font-medium text-st-done-fg"
          data-testid="document-signed"
        >
          <Signature size={12} aria-hidden />
          {t.documents.signed}
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className="z-50 w-80 animate-pop-in rounded-xl border border-line bg-surface p-1.5 shadow-pop"
          data-testid="document-signatures"
        >
          {signatures === null || signatures.length === 0 ? (
            <p className="px-2.5 py-2 text-[12.5px] text-fg-subtle">
              {signatures === null ? t.documents.signaturesLoading : t.documents.signaturesNone}
            </p>
          ) : (
            <>
              <p className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-medium text-fg-subtle">
                {t.documents.signatures(signatures.length)}
              </p>
              <ul>
                {signatures.map((s) => (
                  <li
                    key={`${s.signedAt}-${s.name}`}
                    className="flex items-start gap-3 rounded-lg px-2.5 py-2"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-st-done-bg text-st-done-fg">
                      <Signature size={15} aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
                          {s.name}
                        </p>
                        {s.signedAt ? (
                          <span className="shrink-0 text-[11.5px] tabular-nums text-fg-subtle">
                            {formatDateTime(s.signedAt, lang)}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-fg-subtle">{certificate(s)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
