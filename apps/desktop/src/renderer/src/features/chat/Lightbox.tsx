import { ImageOff, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { Spinner } from '../../components/ui/misc';
import { useT } from '../../i18n';
import { useMedia } from '../../lib/media';
import { chatDict } from './i18n';

export function Lightbox({
  mediaId,
  caption,
  onClose,
}: {
  mediaId: string | null;
  caption?: string;
  onClose: () => void;
}) {
  const t = useT(chatDict);
  const { url, loading } = useMedia(mediaId ?? undefined);
  return (
    <Dialog.Root open={mediaId !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-(--sa-black)/70 backdrop-blur-sm data-[state=open]:animate-fade-in" />
        <Dialog.Content className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 p-10 focus:outline-none data-[state=open]:animate-fade-in">
          <Dialog.Title className="sr-only">{t.lightbox.title}</Dialog.Title>
          <Dialog.Description className="sr-only">{caption ?? t.lightbox.title}</Dialog.Description>
          <Dialog.Close
            aria-label={t.lightbox.close}
            className="absolute top-5 right-5 flex size-9 items-center justify-center rounded-full bg-(--sa-white)/10 text-(--sa-white) hover:bg-(--sa-white)/20"
          >
            <X size={18} aria-hidden />
          </Dialog.Close>
          {loading ? (
            <Spinner size={28} className="text-(--sa-white)" />
          ) : url ? (
            <img
              src={url}
              alt={caption ?? t.lightbox.title}
              className="max-h-[calc(100vh-140px)] max-w-full rounded-lg bg-(--sa-white) shadow-pop"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-(--sa-white)/80">
              <ImageOff size={28} aria-hidden />
              <p className="text-sm">{t.lightbox.unavailable}</p>
            </div>
          )}
          {caption ? (
            <p className="max-w-xl text-center text-[13px] text-(--sa-white)/80">{caption}</p>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
