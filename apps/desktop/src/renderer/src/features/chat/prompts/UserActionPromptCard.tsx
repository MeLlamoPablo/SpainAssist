import type { PromptItem, UserActionKind, UserActionPrompt } from '@sa/shared';
import {
  Check,
  type LucideIcon,
  MapPin,
  Monitor,
  MousePointerClick,
  Puzzle,
  QrCode,
  Smartphone,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Textarea } from '../../../components/ui/field';
import { Skeleton } from '../../../components/ui/misc';
import { useT } from '../../../i18n';
import { common } from '../../../i18n/common';
import { api, errorMessage } from '../../../lib/api';
import { useMedia } from '../../../lib/media';
import { toast } from '../../../store/toast';
import { chatDict } from '../i18n';
import { Lightbox } from '../Lightbox';
import { Markdown } from '../Markdown';
import { PromptShell } from './PromptShell';

const ICON: Record<UserActionKind, LucideIcon> = {
  captcha: Puzzle,
  qr_scan: QrCode,
  phone_approval: Smartphone,
  manual_step: MousePointerClick,
  offline: MapPin,
};

export function UserActionPromptCard({
  item,
  prompt,
  procedureId,
  embedded,
}: {
  item: PromptItem;
  prompt: UserActionPrompt;
  /** The procedure whose agent asks (undefined: the assistant asks). */
  procedureId?: string;
  /** Shown on the procedure's card. */
  embedded?: boolean;
}) {
  const t = useT(chatDict);
  const tc = useT(common);
  const [busy, setBusy] = useState<'done' | 'cannot' | null>(null);
  const [cannotOpen, setCannotOpen] = useState(false);
  const [note, setNote] = useState('');
  const [lightbox, setLightbox] = useState(false);
  const media = useMedia(prompt.imageId);

  const respond = async (done: boolean) => {
    setBusy(done ? 'done' : 'cannot');
    try {
      await api.invoke('chat.respond', item.id, {
        kind: 'user_action',
        done,
        note: !done && note.trim() ? note.trim() : undefined,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const response = item.response?.kind === 'user_action' ? item.response : undefined;

  return (
    <PromptShell
      item={item}
      icon={ICON[prompt.actionKind]}
      kicker={`${t.prompt.actionKind[prompt.actionKind]} · ${t.prompt.needsYou.toLowerCase()}`}
      title={prompt.title}
      embedded={embedded}
      answeredSummary={
        response ? (
          <span>
            <span className="font-medium">
              {response.done ? t.prompt.didIt : t.prompt.couldNot}
            </span>
            {response.note ? <span className="text-fg-subtle"> · {response.note}</span> : null}
          </span>
        ) : null
      }
    >
      <div className="flex flex-col gap-4 @min-[700px]:flex-row">
        <Markdown text={prompt.message} className="min-w-0 flex-1 text-[14px]" />
        {prompt.imageId ? (
          <button
            type="button"
            onClick={() => setLightbox(true)}
            className="group relative w-full shrink-0 overflow-hidden rounded-xl border border-line bg-surface-2 @min-[700px]:w-56"
            aria-label={t.prompt.imageAlt}
          >
            {media.url ? (
              <img src={media.url} alt={t.prompt.imageAlt} className="block w-full object-cover" />
            ) : (
              <Skeleton className="aspect-[16/10] h-auto w-full rounded-none" />
            )}
          </button>
        ) : null}
      </div>

      {cannotOpen ? (
        <div className="mt-4 rounded-xl bg-surface-2 p-3 ring-1 ring-line ring-inset">
          <label htmlFor={`note-${item.id}`} className="text-[13px] font-medium text-fg">
            {t.prompt.cannotTitle}
          </label>
          <Textarea
            id={`note-${item.id}`}
            autosize
            minRows={2}
            maxRows={5}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t.prompt.cannotPlaceholder}
            className="mt-1.5"
            autoFocus
          />
          <div className="mt-2.5 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setCannotOpen(false)}>
              {tc.cancel}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'cannot'}
              onClick={() => void respond(false)}
            >
              {t.prompt.send}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {prompt.showBrowser ? (
          <Button
            variant="secondary"
            icon={Monitor}
            onClick={() => procedureId && void api.invoke('browser.show', procedureId)}
          >
            {t.prompt.showBrowser}
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {!cannotOpen ? (
            <Button variant="ghost" onClick={() => setCannotOpen(true)} disabled={busy !== null}>
              {t.prompt.cannot}
            </Button>
          ) : null}
          <Button
            variant="primary"
            icon={Check}
            loading={busy === 'done'}
            disabled={busy !== null}
            onClick={() => void respond(true)}
          >
            {prompt.doneLabel ?? t.prompt.done}
          </Button>
        </div>
      </div>
      <Lightbox
        mediaId={lightbox ? (prompt.imageId ?? null) : null}
        caption={prompt.title}
        onClose={() => setLightbox(false)}
      />
    </PromptShell>
  );
}
