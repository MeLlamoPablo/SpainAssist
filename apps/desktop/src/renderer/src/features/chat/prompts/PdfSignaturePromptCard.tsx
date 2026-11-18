import type { PdfSignaturePrompt, PromptItem, SignatureBox } from '@sa/shared';
import signatureFontUrl from '@sa/signer/assets/great-vibes-latin.ttf?url';
import { Check, FingerprintPattern, Maximize2, Signature } from 'lucide-react';
import { Dialog } from 'radix-ui';
import {
  Fragment,
  type PointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'unpdf/pdfjs';
import { Button } from '../../../components/ui/button';
import { useT } from '../../../i18n';
import { api, errorMessage } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { toast } from '../../../store/toast';
import { chatDict } from '../i18n';
import { Markdown } from '../Markdown';
import { PromptShell } from './PromptShell';
import {
  centredAt,
  clampBox,
  previewLayout,
  type Rect,
  type ScreenBox,
  toPdf,
  toScreen,
  type ViewportLike,
} from './pdfSignatureLogic';

/** The script font of the handwritten signature, the one the signer draws with. */
const SIGNATURE_FONT = 'SA Signature';
let fontLoading: Promise<void> | undefined;
function loadSignatureFont(): Promise<void> {
  fontLoading ??= (async () => {
    const face = new FontFace(SIGNATURE_FONT, `url(${signatureFontUrl})`);
    document.fonts.add(await face.load());
  })().catch(() => undefined);
  return fontLoading;
}

const widths = new Map<string, number>();
let measurer: CanvasRenderingContext2D | null | undefined;

/** Width of `text` at 1 pt in `font` (a CSS font family), measured once per font and text. */
function textWidth(text: string, font: string): number {
  const key = `${font}\n${text}`;
  const known = widths.get(key);
  if (known !== undefined) return known;
  measurer ??= document.createElement('canvas').getContext('2d');
  if (!measurer) return text.length * 0.5;
  measurer.font = `100px ${font}`;
  const width = measurer.measureText(text).width / 100;
  widths.set(key, width);
  return width;
}

async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const { getDocumentProxy } = await import('unpdf');
  // pdf.js runs in this thread: the renderer's CSP allows no workers (and this build no eval).
  return getDocumentProxy(bytes);
}

/**
 * A visible PDF signature: a preview of the signature's page, and the document in full screen,
 * where in `choose` mode the user clicks where to sign, drags the box and resizes it from its
 * corner; in `fixed` mode the site chose it. With `approval: 'here'` this is the signature's
 * confirmation.
 */
export function PdfSignaturePromptCard({
  item,
  prompt,
  embedded,
}: {
  item: PromptItem;
  prompt: PdfSignaturePrompt;
  embedded?: boolean;
}) {
  const t = useT(chatDict);
  const pending = item.status === 'pending';
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [box, setBox] = useState<SignatureBox | null>(prompt.initial ?? null);
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const pages = usePages(doc);
  const editable = prompt.mode === 'choose';

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let opened: PDFDocumentProxy | undefined;
    void (async () => {
      try {
        const bytes = await api.invoke('chat.promptDocument', item.id);
        if (!bytes) throw new Error('No document');
        opened = await openPdf(new Uint8Array(bytes));
        if (cancelled) void opened.cleanup();
        else setDoc(opened);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      void opened?.cleanup();
    };
  }, [item.id, pending]);

  const respond = async (approved: boolean) => {
    setBusy(approved ? 'yes' : 'no');
    try {
      await api.invoke('chat.respond', item.id, {
        kind: 'pdf_signature',
        approved,
        ...(approved && editable ? { placement: box } : {}),
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const answer = item.response?.kind === 'pdf_signature' ? item.response : undefined;
  const here = prompt.approval === 'here';

  return (
    <PromptShell
      item={item}
      icon={Signature}
      kicker={`${t.prompt.pdfSignatureKicker} · ${t.prompt.needsYou.toLowerCase()}`}
      title={prompt.title}
      embedded={embedded}
      answeredSummary={
        answer ? (
          <span
            className={cn('font-medium', answer.approved ? 'text-st-done-fg' : 'text-fg-muted')}
          >
            {answer.approved
              ? here
                ? `${t.prompt.signed}: ${prompt.documentName}`
                : t.prompt.placed
              : t.prompt.notSigned}
          </span>
        ) : null
      }
    >
      <Markdown text={prompt.message} className="text-[14px] text-fg" />

      <PagePreview
        pages={pages}
        failed={failed}
        box={box}
        prompt={prompt}
        height={embedded ? 260 : 300}
        onOpen={() => setFullScreen(true)}
      />
      <PdfFullScreen
        open={fullScreen}
        onClose={() => setFullScreen(false)}
        pages={pages}
        box={box}
        editable={editable}
        onChange={setBox}
        prompt={prompt}
      />

      {prompt.details?.length ? (
        <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[13.5px]">
          {prompt.details.map((d) => (
            <Fragment key={d.label}>
              <dt className="text-fg-subtle">{d.label}</dt>
              <dd className="selectable min-w-0 font-medium break-words text-fg">{d.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        {here && prompt.biometric ? (
          <span className="flex items-center gap-2 text-[12.5px] text-fg-muted">
            <FingerprintPattern size={16} className="text-accent-text" aria-hidden />
            {t.prompt.biometric}
          </span>
        ) : (
          <span />
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => void respond(false)}
            loading={busy === 'no'}
            disabled={busy !== null}
          >
            {prompt.rejectLabel ?? t.prompt.reject}
          </Button>
          <Button
            variant="primary"
            icon={Check}
            onClick={() => void respond(true)}
            loading={busy === 'yes'}
            disabled={busy !== null || (editable && !box && !prompt.optional)}
            data-testid="pdf-signature-approve"
          >
            {prompt.confirmLabel ?? t.prompt.approve}
          </Button>
        </div>
      </div>
    </PromptShell>
  );
}

interface PageInfo {
  page: PDFPageProxy;
  number: number;
}

/** The document's pages, loaded once for the preview and the full-screen view. */
function usePages(doc: PDFDocumentProxy | null): PageInfo[] {
  const [pages, setPages] = useState<PageInfo[]>([]);
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      const list: PageInfo[] = [];
      for (let n = 1; n <= doc.numPages; n++) list.push({ page: await doc.getPage(n), number: n });
      if (!cancelled) setPages(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);
  return pages;
}

/** The width of an element, followed as it resizes. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * The card's look at the document: the signature's page, at the card's width, framed around the
 * signature. A click (or the maximize button that shows on hover) opens the full-screen view.
 */
function PagePreview({
  pages,
  failed,
  box,
  prompt,
  height,
  onOpen,
}: {
  pages: PageInfo[];
  failed: boolean;
  box: SignatureBox | null;
  prompt: PdfSignaturePrompt;
  height: number;
  onOpen(): void;
}) {
  const t = useT(chatDict);
  const frame = useRef<HTMLButtonElement>(null);
  const width = useWidth(frame);
  const pageNumber = box?.page ?? prompt.initial?.page ?? 1;
  const info = pages.find((p) => p.number === pageNumber) ?? pages[0];
  const pageWidth = Math.max(0, width - 24);
  // Scroll the page so the signature sits a little below the middle of the frame.
  let offset = 0;
  if (info && pageWidth > 0) {
    const base = info.page.getViewport({ scale: 1 });
    const viewport = info.page.getViewport({
      scale: pageWidth / base.width,
    }) as unknown as ViewportLike;
    if (box) {
      const screen = toScreen(box.rect, viewport);
      offset = screen.top + screen.height / 2 - (height - 24) * 0.6;
    }
    offset = Math.min(Math.max(0, offset), Math.max(0, viewport.height - (height - 24)));
  }
  return (
    <button
      ref={frame}
      type="button"
      onClick={onOpen}
      disabled={!info}
      aria-label={t.prompt.pdfExpand}
      className="group relative mt-4 block w-full overflow-hidden rounded-xl border border-line bg-surface-2 text-left focus-visible:outline-2 focus-visible:outline-accent enabled:cursor-zoom-in"
      style={{ height }}
      data-testid="pdf-preview"
    >
      {failed ? (
        <p className="flex h-full items-center justify-center text-[13px] text-fg-muted">
          {t.prompt.pdfFailed}
        </p>
      ) : !info || pageWidth === 0 ? (
        <p className="flex h-full items-center justify-center text-[13px] text-fg-muted">
          {t.prompt.pdfLoading}
        </p>
      ) : (
        <div
          className="pointer-events-none px-3 pt-3"
          style={{ transform: `translateY(${-offset}px)` }}
        >
          <PdfPage
            info={info}
            width={pageWidth}
            box={box?.page === info.number ? box.rect : null}
            currentBox={box}
            editable={false}
            onPlace={() => undefined}
            preview={prompt}
          />
        </div>
      )}
      {pages.length > 1 ? (
        <span className="pointer-events-none absolute top-3 right-5 rounded-full bg-surface/90 px-2.5 py-1 text-[11.5px] font-medium text-fg-muted shadow-raised">
          {t.prompt.pdfPage(info?.number ?? 1, pages.length)}
        </span>
      ) : null}
      {info ? (
        <span
          className="pointer-events-none absolute right-3 bottom-3 flex size-8 items-center justify-center rounded-lg bg-surface/95 text-fg opacity-0 shadow-raised transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden
        >
          <Maximize2 size={15} />
        </span>
      ) : null}
    </button>
  );
}

/** Scrolls the full-screen view to a page. */
function scrollToPage(scroller: HTMLElement | null, page: number, smooth = true): void {
  const el = scroller?.querySelector<HTMLElement>(`[data-page="${page}"]`);
  if (!el || !scroller) return;
  scroller.scrollTo({ top: el.offsetTop - 24, behavior: smooth ? 'smooth' : 'auto' });
}

/**
 * The document in full screen: the pages on the left to jump between them, and the pages
 * themselves, where the user clicks to place the signature, drags it or resizes it (`choose`).
 */
function PdfFullScreen({
  open,
  onClose,
  pages,
  box,
  editable,
  onChange,
  prompt,
}: {
  open: boolean;
  onClose(): void;
  pages: PageInfo[];
  box: SignatureBox | null;
  editable: boolean;
  onChange(box: SignatureBox | null): void;
  prompt: PdfSignaturePrompt;
}) {
  const t = useT(chatDict);
  const scroller = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(box?.page ?? 1);
  const [width, setWidth] = useState(0);

  // The scroller exists only while the dialog is open: measure it then.
  const measure = (el: HTMLDivElement | null) => {
    scroller.current = el;
    if (el) setWidth(el.clientWidth);
  };
  useEffect(() => {
    if (!open) return;
    const onResize = () => setWidth(scroller.current?.clientWidth ?? 0);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  // Open on the signature's page (once per opening, when the pages have a width).
  const startPage = box?.page ?? 1;
  const opened = useRef(false);
  useEffect(() => {
    if (!open) {
      opened.current = false;
      return;
    }
    if (opened.current || width === 0) return;
    opened.current = true;
    setCurrent(startPage);
    requestAnimationFrame(() => scrollToPage(scroller.current, startPage, false));
  }, [open, width, startPage]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const middle = el.scrollTop + el.clientHeight / 2;
    for (const child of el.querySelectorAll<HTMLElement>('[data-page]')) {
      if (child.offsetTop <= middle && child.offsetTop + child.offsetHeight >= middle) {
        setCurrent(Number(child.dataset.page));
        break;
      }
    }
  };

  const pageWidth = Math.min(Math.max(0, width - 64), 880);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <Dialog.Content
          className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop focus:outline-none data-[state=open]:animate-pop-in"
          data-testid="pdf-fullscreen"
        >
          <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
            <Dialog.Title className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg">
              {prompt.documentName}
            </Dialog.Title>
            <Dialog.Description className="sr-only">{prompt.title}</Dialog.Description>
            {pages.length > 1 ? (
              <span className="shrink-0 text-[12.5px] text-fg-muted">
                {t.prompt.pdfPage(current, pages.length)}
              </span>
            ) : null}
            {editable && prompt.optional ? (
              <Button
                variant="secondary"
                onClick={() => onChange(box ? null : (prompt.initial ?? null))}
              >
                {box ? t.prompt.pdfNoVisible : t.prompt.pdfAddVisible}
              </Button>
            ) : null}
            <Dialog.Close asChild>
              <Button variant="primary" icon={Check} data-testid="pdf-fullscreen-done">
                {t.prompt.pdfDone}
              </Button>
            </Dialog.Close>
          </header>
          <div className="flex min-h-0 flex-1">
            {pages.length > 1 ? (
              <nav
                aria-label={t.prompt.pdfPages}
                className="w-[168px] shrink-0 overflow-y-auto border-r border-line bg-surface-2 px-4 py-4"
              >
                <ol className="flex flex-col gap-4">
                  {pages.map((p) => (
                    <li key={p.number}>
                      <button
                        type="button"
                        onClick={() => {
                          setCurrent(p.number);
                          scrollToPage(scroller.current, p.number);
                        }}
                        aria-current={current === p.number ? 'page' : undefined}
                        className="group flex w-full flex-col items-center gap-1.5"
                        data-testid="pdf-thumb"
                      >
                        <span
                          className={cn(
                            'pointer-events-none block rounded-sm ring-offset-2 ring-offset-surface-2',
                            current === p.number
                              ? 'ring-2 ring-accent'
                              : 'group-hover:ring-1 group-hover:ring-line-strong',
                          )}
                        >
                          <PdfPage
                            info={p}
                            width={120}
                            box={box?.page === p.number ? box.rect : null}
                            currentBox={box}
                            editable={false}
                            onPlace={() => undefined}
                            preview={prompt}
                          />
                        </span>
                        <span
                          className={cn(
                            'text-[12px] font-medium',
                            current === p.number ? 'text-fg' : 'text-fg-muted',
                          )}
                        >
                          {p.number}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </nav>
            ) : null}
            <div
              ref={measure}
              onScroll={onScroll}
              className="min-w-0 flex-1 overflow-y-auto bg-surface-2 px-8 py-6"
              data-testid="pdf-pages"
            >
              {pageWidth > 0 ? (
                <div className="flex flex-col items-center gap-6">
                  {pages.map((p) => (
                    <PdfPage
                      key={p.number}
                      info={p}
                      width={pageWidth}
                      box={box?.page === p.number ? box.rect : null}
                      editable={editable}
                      onPlace={(rect) => onChange({ page: p.number, rect })}
                      currentBox={box}
                      preview={prompt}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PdfPage({
  info,
  width,
  box,
  currentBox,
  editable,
  onPlace,
  preview,
}: {
  info: PageInfo;
  width: number;
  box: Rect | null;
  currentBox: SignatureBox | null;
  editable: boolean;
  onPlace(rect: Rect): void;
  preview: PdfSignaturePrompt;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const viewport = useMemo(() => {
    const base = info.page.getViewport({ scale: 1 });
    return info.page.getViewport({ scale: width / base.width }) as unknown as ViewportLike;
  }, [info.page, width]);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setVisible(true);
      },
      { rootMargin: '400px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!visible || !el) return;
    const ratio = window.devicePixelRatio || 1;
    const vp = info.page.getViewport({
      scale: (width / info.page.getViewport({ scale: 1 }).width) * ratio,
    });
    el.width = Math.floor(vp.width);
    el.height = Math.floor(vp.height);
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const task = info.page.render({ canvasContext: ctx, viewport: vp, canvas: el });
    task.promise.catch(() => undefined);
    return () => task.cancel();
  }, [visible, info.page, width]);

  // A click on the page puts the signature there (same size as now, or the default).
  const place = (e: PointerEvent<HTMLDivElement>) => {
    if (!editable || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const size = currentBox
      ? toScreen(currentBox.rect, viewport)
      : toScreen(preview.initial?.rect ?? [0, 0, 180, 64], viewport);
    const next = clampBox(centredAt(size, e.clientX - rect.left, e.clientY - rect.top), viewport);
    onPlace(toPdf(next, viewport));
  };

  return (
    <div
      ref={holder}
      data-page={info.number}
      className={cn(
        'relative mx-auto overflow-hidden rounded-sm bg-white shadow-raised',
        editable && 'cursor-crosshair',
      )}
      style={{ width: viewport.width, height: viewport.height }}
      onPointerDown={place}
    >
      <canvas ref={canvas} className="pointer-events-none absolute inset-0 size-full" aria-hidden />
      {box ? (
        <SignatureOverlay
          rect={box}
          viewport={viewport}
          editable={editable}
          onChange={onPlace}
          preview={preview}
        />
      ) : null}
    </div>
  );
}

function SignatureOverlay({
  rect,
  viewport,
  editable,
  onChange,
  preview,
}: {
  rect: Rect;
  viewport: ViewportLike;
  editable: boolean;
  onChange(rect: Rect): void;
  preview: PdfSignaturePrompt;
}) {
  const t = useT(chatDict);
  const screen = toScreen(rect, viewport);
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; start: ScreenBox } | null>(
    null,
  );

  const start = (mode: 'move' | 'resize') => (e: PointerEvent<HTMLElement>) => {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, start: screen };
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const next =
      d.mode === 'move'
        ? { ...d.start, left: d.start.left + dx, top: d.start.top + dy }
        : { ...d.start, width: d.start.width + dx, height: d.start.height + dy };
    onChange(toPdf(clampBox(next, viewport), viewport));
  };
  const end = () => {
    drag.current = null;
  };

  return (
    <div
      role="img"
      aria-label={editable ? t.prompt.pdfSignatureBox : t.prompt.pdfFixedHint}
      className={cn(
        'absolute rounded-[3px] border-[1.5px] bg-accent/[0.06]',
        editable
          ? 'cursor-grab border-dashed border-accent active:cursor-grabbing'
          : 'border-accent/70',
      )}
      style={{ left: screen.left, top: screen.top, width: screen.width, height: screen.height }}
      onPointerDown={start('move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      data-testid="pdf-signature-box"
    >
      <SignaturePreview
        prompt={preview}
        width={screen.width / viewport.scale}
        height={screen.height / viewport.scale}
      />
      {editable ? (
        <span
          role="presentation"
          title={t.prompt.pdfResize}
          className="absolute -right-[5px] -bottom-[5px] size-2.5 cursor-nwse-resize rounded-[2px] border-[1.5px] border-accent bg-surface"
          onPointerDown={start('resize')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      ) : null}
    </div>
  );
}

/** What the signature will look like, drawn in the box's own points. */
function SignaturePreview({
  prompt,
  width: w,
  height: h,
}: {
  prompt: PdfSignaturePrompt;
  width: number;
  height: number;
}) {
  const t = useT(chatDict);
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    void loadSignatureFont().then(() => setFontReady(true));
  }, []);
  const caption = [
    t.prompt.pdfSignedBy(prompt.signer.name),
    [prompt.signer.holderId ? `NIF ${prompt.signer.holderId}` : '', signatureDate(new Date())]
      .filter(Boolean)
      .join(' · '),
  ];
  // Measured until the script font loads: its width is only a guess before.
  const layout = previewLayout(
    w,
    h,
    fontReady
      ? textWidth(prompt.signer.name, `"${SIGNATURE_FONT}"`)
      : prompt.signer.name.length * 0.45,
    Math.max(...caption.map((line) => textWidth(line, 'Helvetica, Arial, sans-serif'))),
  );

  if (prompt.appearance === 'text') {
    return (
      <span className="flex size-full items-center justify-center gap-1.5 px-1 text-center text-[11px] font-medium text-accent-text">
        <Signature size={13} aria-hidden />
        {t.prompt.pdfSiteText}
      </span>
    );
  }
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="pointer-events-none size-full"
      preserveAspectRatio="none"
      aria-hidden
    >
      <g transform={`translate(0 ${h}) scale(1 -1)`}>
        <line
          x1={layout.pad}
          x2={w - layout.pad}
          y1={layout.ruleY}
          y2={layout.ruleY}
          stroke="rgb(184 189 199)"
          strokeWidth={Math.max(0.4, layout.captionSize * 0.08)}
        />
      </g>
      <text
        x={w / 2}
        y={h - layout.nameBaseline}
        textAnchor="middle"
        fontFamily={`"${SIGNATURE_FONT}", cursive`}
        fontSize={layout.nameSize}
        fill="rgb(23 51 120)"
      >
        {prompt.signer.name}
      </text>
      {caption.map((line, i) => (
        <text
          key={line}
          x={layout.pad}
          y={
            h - (layout.pad + (caption.length - 1 - i) * layout.leading + layout.captionSize * 0.2)
          }
          fontFamily="Helvetica, Arial, sans-serif"
          fontSize={layout.captionSize}
          fill="rgb(69 74 84)"
        >
          {line}
        </text>
      ))}
    </svg>
  );
}

/** As the signer writes it: 18/11/2026 20:45. */
function signatureDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
