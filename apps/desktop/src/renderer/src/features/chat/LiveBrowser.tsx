import type { BrowserLiveInput } from '@sa/shared';
import { Check, MonitorX, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/misc';
import { useT } from '../../i18n';
import { api } from '../../lib/api';
import { chatDict } from './i18n';

type Frame = { url: string; width: number; height: number };
type Status = 'connecting' | 'live' | 'notOpen' | 'ended';

/** Keys sent as presses (their effect); single printable characters are sent as text. */
const MODIFIERS: [keyof KeyboardEvent, string][] = [
  ['ctrlKey', 'Control'],
  ['metaKey', 'Meta'],
  ['altKey', 'Alt'],
];

/**
 * Live view of a procedure's headless browser, almost full screen: its frames as they render,
 * and the user's clicks, scrolls and keys sent to the page (`browser.live.*`). A procedure moved
 * to a headed browser brings its real window to the front instead, and this closes.
 */
export function LiveBrowser({
  procedureId,
  open,
  onClose,
  doneLabel,
  onDone,
}: {
  procedureId: string;
  open: boolean;
  onClose: () => void;
  doneLabel: string;
  /** "Ya está": answers the request the browser was opened for. */
  onDone?: () => void;
}) {
  const t = useT(chatDict);
  const [status, setStatus] = useState<Status>('connecting');
  const [frame, setFrame] = useState<Frame | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  /** Inputs go one after the other, in the order the user made them. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pressed = useRef(false);
  const moving = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setStatus('connecting');
    setFrame(null);
    const off = api.on((event) => {
      if (!active || !('procedureId' in event) || event.procedureId !== procedureId) return;
      if (event.type === 'browser.frame') {
        setFrame({
          url: `data:image/jpeg;base64,${event.jpeg}`,
          width: event.width,
          height: event.height,
        });
        setStatus('live');
      } else if (event.type === 'browser.liveEnded') {
        setStatus('ended');
      }
    });
    api
      .invoke('browser.live.start', procedureId)
      .then((mode) => {
        if (!active) return;
        if (mode === 'window') onClose();
        else if (mode === null) setStatus('notOpen');
      })
      .catch(() => active && setStatus('notOpen'));
    return () => {
      active = false;
      off();
      void api.invoke('browser.live.stop', procedureId).catch(() => {});
    };
  }, [open, procedureId, onClose]);

  useEffect(() => {
    if (status === 'live') surface.current?.focus();
  }, [status]);

  const send = useCallback(
    (input: BrowserLiveInput) => {
      queue.current = queue.current
        .then(() => api.invoke('browser.live.input', procedureId, input))
        .catch(() => {});
    },
    [procedureId],
  );

  /** The pointer's position in the page's CSS pixels (the image is scaled to fit). */
  const at = (e: { clientX: number; clientY: number }) => {
    const rect = image.current?.getBoundingClientRect();
    if (!rect || !frame || rect.width === 0 || rect.height === 0) return null;
    const x = ((e.clientX - rect.left) / rect.width) * frame.width;
    const y = ((e.clientY - rect.top) / rect.height) * frame.height;
    if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
    return { x: Math.round(x), y: Math.round(y) };
  };

  const button = (b: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');

  const onPointerDown = (e: PointerEvent) => {
    const p = at(e);
    if (!p) return;
    e.preventDefault();
    surface.current?.focus();
    pressed.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    send({ type: 'mouseDown', ...p, button: button(e.button) });
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!pressed.current) return;
    pressed.current = false;
    const p = at(e);
    if (p) send({ type: 'mouseUp', ...p, button: button(e.button) });
  };
  // Moves only matter while a button is down (sliders, drags), one per frame at most.
  const onPointerMove = (e: PointerEvent) => {
    if (!pressed.current || moving.current !== null) return;
    const p = at(e);
    if (!p) return;
    moving.current = requestAnimationFrame(() => {
      moving.current = null;
      send({ type: 'mouseMove', ...p });
    });
  };
  const onWheel = (e: WheelEvent) => {
    const p = at(e);
    if (p) send({ type: 'wheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.nativeEvent.isComposing) return;
    const mods = MODIFIERS.filter(([flag]) => e[flag]).map(([, name]) => name);
    // Pasting arrives as a paste event (its text), not as keys.
    if (mods.length && e.key.toLowerCase() === 'v') return;
    e.preventDefault();
    if (e.key.length === 1 && mods.length === 0) send({ type: 'text', text: e.key });
    else if (!['Control', 'Meta', 'Alt', 'Shift'].includes(e.key))
      send({ type: 'key', key: [...mods, e.key].join('+') });
  };

  const hint = t.live.hint(doneLabel);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <Dialog.Content className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop focus:outline-none data-[state=open]:animate-pop-in">
          <div className="flex items-center gap-4 border-b border-line px-5 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[15px] font-semibold text-fg">
                {t.live.title}
              </Dialog.Title>
              <Dialog.Description className="truncate text-[13px] text-fg-muted">
                {hint}
              </Dialog.Description>
            </div>
            {onDone ? (
              <Button variant="primary" icon={Check} onClick={onDone}>
                {doneLabel}
              </Button>
            ) : null}
            <Dialog.Close
              aria-label={t.live.close}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-subtle hover:bg-surface-3 hover:text-fg"
            >
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <div
            ref={surface}
            role="application"
            aria-label={t.live.pageAlt}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the page takes the keyboard while this is focused
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              if (text) send({ type: 'text', text: text.slice(0, 1000) });
            }}
            className="flex min-h-0 flex-1 items-center justify-center bg-surface-3 p-4 focus:outline-none"
          >
            {frame && status === 'live' ? (
              <img
                ref={image}
                src={frame.url}
                alt={t.live.pageAlt}
                draggable={false}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onPointerMove={onPointerMove}
                onWheel={onWheel}
                onContextMenu={(e) => e.preventDefault()}
                className="max-h-full max-w-full rounded-lg bg-(--sa-white) object-contain shadow-pop select-none"
              />
            ) : status === 'connecting' ? (
              <div className="flex flex-col items-center gap-3 text-fg-muted">
                <Spinner size={24} />
                <p className="text-sm">{t.live.connecting}</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-fg-muted">
                <MonitorX size={26} aria-hidden />
                <p className="text-sm">{status === 'notOpen' ? t.live.notOpen : t.live.ended}</p>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
