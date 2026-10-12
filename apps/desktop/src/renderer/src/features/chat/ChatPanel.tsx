import type { ChatItem, PromptItem } from '@sa/shared';
import {
  ArrowDown,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  MessageSquareText,
  MessagesSquare,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BrandLogo, BrandMark } from '../../components/brand';
import { Button, IconButton } from '../../components/ui/button';
import { EmptyState, Skeleton } from '../../components/ui/misc';
import { useT } from '../../i18n';
import { api } from '../../lib/api';
import { useAppStore } from '../../store/app';
import { useChatStore } from '../../store/chat';
import { loadConversation } from '../../store/sync';
import {
  ActivityFailure,
  AssistantMessage,
  DaySeparator,
  NoticeRow,
  ProcedureEventRow,
  PromptCard,
  UserMessage,
} from './ChatItems';
import { Composer } from './Composer';
import { chatDict } from './i18n';
import { buildRows, isProcedureEvent, pendingPrompts } from './rows';

/**
 * Keep routine tool calls out of the conversation. Procedure events and failures remain visible;
 * pending questions are docked, and procedure agents ask on their cards.
 */
const hidden = (item: ChatItem) =>
  (item.type === 'prompt' && (item.status === 'pending' || Boolean(item.procedureId))) ||
  (item.type === 'activity' && !isProcedureEvent(item) && item.status !== 'error');

/**
 * The one, perpetual conversation with the assistant. The assistant's own questions are docked
 * at the bottom, in place of the composer; procedure agents ask on their cards.
 */
export function ChatPanel() {
  const t = useT(chatDict);
  const conversation = useChatStore((s) => s.conversation);
  const state = useChatStore((s) => s.state);
  const configured = useAppStore((s) => Boolean(s.provider?.configured));
  const items = conversation.items;
  const rows = useMemo(() => buildRows(items, { days: true, skip: hidden }), [items]);
  const pending = useMemo(() => pendingPrompts(items), [items]);
  const loading = conversation.status === 'loading' && items.length === 0;
  const empty = conversation.status === 'loaded' && items.length === 0;
  const working = state.activity === 'working';
  const last = items.at(-1);
  const thinking = working && !(last?.type === 'assistant' && last.status === 'streaming');

  // --- Stick to the bottom while new content arrives (unless the user scrolled up) ----------
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = distance < 80;
    setShowJump(distance > 240);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow every transcript change
  useLayoutEffect(() => {
    if (pinned.current) scrollToBottom();
  }, [items, thinking, scrollToBottom]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) scrollToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  return (
    <section
      aria-label={t.assistant}
      className="relative flex w-[clamp(400px,36%,560px)] shrink-0 flex-col border-r border-line bg-surface"
      data-testid="chat-panel"
    >
      <header className="drag flex h-[64px] shrink-0 items-center justify-center border-b border-line px-5">
        <BrandLogo size={28} />
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        data-testid="chat-scroll"
        data-scroll-stable
      >
        <div ref={contentRef} className="flex min-h-full flex-col gap-5 px-6 pt-5 pb-8">
          {loading ? <TranscriptSkeleton label={t.loading} /> : null}
          {conversation.status === 'error' ? (
            <EmptyState
              icon={MessagesSquare}
              title={t.loadError}
              action={
                <Button icon={RotateCcw} onClick={() => void loadConversation()}>
                  {t.retry}
                </Button>
              }
            />
          ) : null}
          {empty ? <Welcome /> : null}
          {rows.map((row) => {
            switch (row.kind) {
              case 'day':
                return <DaySeparator key={row.key} date={row.date} />;
              case 'event':
                return <ProcedureEventRow key={row.key} item={row.item} />;
              case 'activities':
              case 'activity':
                return <ActivityFailure key={row.key} />;
            }
            const item = row.item;
            switch (item.type) {
              case 'user':
                return <UserMessage key={row.key} item={item} />;
              case 'assistant':
                return <AssistantMessage key={row.key} item={item} />;
              case 'notice':
                return <NoticeRow key={row.key} item={item} />;
              case 'prompt':
                return <PromptCard key={row.key} item={item} />;
              default:
                return null;
            }
          })}
          {thinking ? <ThinkingDots label={t.writing} /> : null}
        </div>
      </div>

      <div className="relative shrink-0 px-5 pb-5">
        <div className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-surface to-transparent" />
        <div className="relative">
          {showJump ? (
            <button
              type="button"
              onClick={() => {
                pinned.current = true;
                scrollToBottom(true);
              }}
              className="absolute -top-12 left-1/2 flex h-8 -translate-x-1/2 animate-pop-in items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] font-medium text-fg-muted shadow-raised hover:text-fg"
            >
              <ArrowDown size={14} aria-hidden />
              {t.scrollDown}
            </button>
          ) : null}
          {configured ? (
            <Dock
              pending={pending}
              working={working}
              empty={empty}
              onSent={() => {
                pinned.current = true;
              }}
            />
          ) : (
            <ConnectCard />
          )}
        </div>
      </div>
    </section>
  );
}

/** The assistant's pending questions (one at a time) or the composer. */
function Dock({
  pending,
  working,
  empty,
  onSent,
}: {
  pending: PromptItem[];
  working: boolean;
  empty: boolean;
  onSent: () => void;
}) {
  const t = useT(chatDict);
  const focusTick = useAppStore((s) => s.composerFocusTick);
  const draft = useAppStore((s) => s.draft);
  const [writing, setWriting] = useState(false);
  const [index, setIndex] = useState(0);
  // ⌘N or a suggestion: the user wants to type.
  useEffect(() => {
    if (focusTick) setWriting(true);
  }, [focusTick]);
  useEffect(() => {
    if (draft) setWriting(true);
  }, [draft]);

  const current = pending[Math.min(index, pending.length - 1)];

  if (current && !writing) {
    const at = pending.indexOf(current);
    return (
      <div className="flex max-h-[min(640px,72vh)] flex-col gap-2" data-testid="prompt-dock">
        {pending.length > 1 ? (
          <div className="flex items-center justify-between px-1 text-[12.5px] font-medium text-fg-subtle">
            <span>{t.panel.pager(at + 1, pending.length)}</span>
            <span className="flex items-center gap-0.5">
              <IconButton
                icon={ChevronLeft}
                label={t.panel.previous}
                size="sm"
                disabled={at === 0}
                onClick={() => setIndex(at - 1)}
              />
              <IconButton
                icon={ChevronRight}
                label={t.panel.nextOne}
                size="sm"
                disabled={at === pending.length - 1}
                onClick={() => setIndex(at + 1)}
              />
            </span>
          </div>
        ) : null}
        <div className="min-h-0 overflow-y-auto rounded-2xl">
          <PromptCard key={current.id} item={current} />
        </div>
        <button
          type="button"
          onClick={() => setWriting(true)}
          className="flex h-7 items-center gap-1.5 self-center rounded-md px-2 text-[12.5px] font-medium text-fg-subtle hover:bg-surface-3/70 hover:text-fg-muted"
        >
          <MessageSquareText size={13} aria-hidden />
          {t.panel.writeInstead}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {pending.length ? (
        <button
          type="button"
          onClick={() => setWriting(false)}
          className="flex h-8 items-center gap-2 self-start rounded-full bg-st-attention-bg px-3 text-[12.5px] font-semibold text-st-attention-fg ring-1 ring-st-attention-line ring-inset"
        >
          <span
            className="size-1.5 animate-pulse-soft rounded-full bg-st-attention-dot"
            aria-hidden
          />
          {t.panel.backToQuestion}
          <ArrowRight size={13} aria-hidden />
        </button>
      ) : null}
      <Composer
        variant="chat"
        placeholder={empty ? t.panel.welcome.placeholder : t.composer.placeholder}
        onSubmit={async (text, attachments) => {
          onSent();
          await api.invoke('chat.send', {
            text,
            attachments: attachments.length ? attachments : undefined,
          });
          setWriting(false);
        }}
        working={working}
        onStop={() => void api.invoke('chat.abort')}
        focusTick={focusTick || undefined}
        autoFocus={empty}
        draft={draft ?? undefined}
      />
    </div>
  );
}

/** Empty conversation: what I can do for you. */
function Welcome() {
  const t = useT(chatDict);
  return (
    <div className="my-auto flex flex-col items-start px-1 py-6" data-testid="chat-welcome">
      <BrandMark size={44} />
      <h1 className="mt-5 text-[24px] font-semibold leading-tight tracking-[-0.02em] text-fg">
        {t.panel.welcome.title}
      </h1>
      <ul className="mt-6 flex flex-col gap-3">
        {t.panel.welcome.points.map((point) => (
          <li key={point} className="flex items-start gap-2.5 text-[14px] leading-snug text-fg">
            <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-st-done-bg text-st-done-fg">
              <Check size={12} strokeWidth={3} aria-hidden />
            </span>
            {point}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** No AI connected: the composer is replaced by a way to connect one. */
function ConnectCard() {
  const t = useT(chatDict);
  const navigate = useAppStore((s) => s.navigate);
  return (
    <div
      className="flex items-start gap-3.5 rounded-2xl border border-st-attention-line bg-surface p-4 shadow-raised ring-4 ring-st-attention-bg"
      data-testid="chat-connect"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-st-attention-bg text-st-attention-fg">
        <Sparkles size={18} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-fg">{t.panel.connect.title}</p>
        <p className="mt-0.5 text-[13.5px] leading-snug text-fg-muted">{t.panel.connect.body}</p>
        <Button
          variant="primary"
          iconRight={ArrowRight}
          className="mt-3"
          onClick={() => navigate({ kind: 'settings', section: 'provider' })}
        >
          {t.panel.connect.action}
        </Button>
      </div>
    </div>
  );
}

function ThinkingDots({ label }: { label: string }) {
  return (
    <p className="flex h-6 items-center gap-1" aria-live="polite">
      <span className="sr-only">{label}</span>
      {[0, 180, 360].map((delay) => (
        <span
          key={delay}
          className="size-1.5 animate-pulse-soft rounded-full bg-fg-subtle"
          style={{ animationDelay: `${delay}ms` }}
          aria-hidden
        />
      ))}
    </p>
  );
}

function TranscriptSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="flex justify-end">
        <Skeleton className="h-10 w-1/2 rounded-2xl" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="w-11/12" />
        <Skeleton className="w-4/5" />
        <Skeleton className="w-2/3" />
      </div>
    </div>
  );
}
