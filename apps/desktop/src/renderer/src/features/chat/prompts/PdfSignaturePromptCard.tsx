import type { PdfSignaturePrompt, PromptItem, SignatureBox } from '@sa/shared';
import signatureFontUrl from '@sa/signer/assets/great-vibes-latin.ttf?url';
import { Check, FingerprintPattern, Signature } from 'lucide-react';
import { Fragment, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
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
 * A visible PDF signature: the document's pages with the signature's box. In `choose` mode the
 * user clicks where to sign, drags the box and resizes it from its corner; in `fixed` mode the
 * site chose it. With `approval: 'here'` this is the signature's confirmation.
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

      <div className="mt-4">
        <PdfPages
          doc={doc}
          failed={failed}
          box={box}
          editable={editable}
          onChange={setBox}
          preview={prompt}
          height={embedded ? 340 : 440}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-fg-muted">
          <span>
            {box
              ? editable
                ? t.prompt.pdfPlaceHint
                : t.prompt.pdfFixedHint
              : t.prompt.pdfNoVisibleHint}
          </span>
          {editable && prompt.optional ? (
            <button
              type="button"
              className="font-medium text-accent-text hover:underline"
              onClick={() => setBox(box ? null : (prompt.initial ?? null))}
            >
              {box ? t.prompt.pdfNoVisible : t.prompt.pdfAddVisible}
            </button>
          ) : null}
        </div>
      </div>

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

function PdfPages({
  doc,
  failed,
  box,
  editable,
  onChange,
  preview,
  height,
}: {
  doc: PDFDocumentProxy | null;
  failed: boolean;
  box: SignatureBox | null;
  editable: boolean;
  onChange(box: SignatureBox | null): void;
  preview: PdfSignaturePrompt;
  height: number;
}) {
  const t = useT(chatDict);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [current, setCurrent] = useState(1);
  const scrolledTo = useRef(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

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

  // Start where the signature is.
  useEffect(() => {
    if (scrolledTo.current || !box || pages.length === 0 || width === 0) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${box.page}"]`);
    if (!el || !scroller.current) return;
    scrolledTo.current = true;
    scroller.current.scrollTop = Math.max(0, el.offsetTop - 12);
  }, [box, pages, width]);

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

  const pageWidth = Math.max(0, width - 24);
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-surface-2">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="overflow-y-auto px-3 py-3"
        style={{ height }}
        data-testid="pdf-pages"
      >
        {failed ? (
          <p className="flex h-full items-center justify-center text-[13px] text-fg-muted">
            {t.prompt.pdfFailed}
          </p>
        ) : pages.length === 0 || pageWidth === 0 ? (
          <p className="flex h-full items-center justify-center text-[13px] text-fg-muted">
            {t.prompt.pdfLoading}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {pages.map((p) => (
              <PdfPage
                key={p.number}
                info={p}
                width={pageWidth}
                box={box?.page === p.number ? box.rect : null}
                editable={editable}
                onPlace={(rect) => onChange({ page: p.number, rect })}
                currentBox={box}
                preview={preview}
              />
            ))}
          </div>
        )}
      </div>
      {pages.length > 1 ? (
        <span className="pointer-events-none absolute top-3 right-5 rounded-full bg-surface/90 px-2.5 py-1 text-[11.5px] font-medium text-fg-muted shadow-raised">
          {t.prompt.pdfPage(current, pages.length)}
        </span>
      ) : null}
    </div>
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
