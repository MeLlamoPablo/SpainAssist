import {
  type ActivityItem,
  type AssistantItem,
  type NoticeItem,
  type PromptItem,
  REPORT_TOOL,
  type UserItem,
} from '@sa/shared';
import {
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  FileText,
  Info,
  TriangleAlert,
} from 'lucide-react';
import { memo } from 'react';
import { Spinner } from '../../components/ui/misc';
import { useLang, useT } from '../../i18n';
import { activityLabel } from '../../lib/activity';
import { cn } from '../../lib/cn';
import { formatDay } from '../../lib/format';
import { useAppStore } from '../../store/app';
import { useProcedureStore } from '../../store/procedures';
import { useVaultStore } from '../../store/vault';
import { chatDict } from './i18n';
import { Markdown } from './Markdown';
import { ConfirmPromptCard } from './prompts/ConfirmPromptCard';
import { CredentialPromptCard } from './prompts/CredentialPromptCard';
import { DnieSignaturePromptCard } from './prompts/DnieSignaturePromptCard';
import { FormPromptCard } from './prompts/FormPromptCard';
import { PhoneCallPromptCard } from './prompts/PhoneCallPromptCard';
import { UserActionPromptCard } from './prompts/UserActionPromptCard';

export const UserMessage = memo(function UserMessage({ item }: { item: UserItem }) {
  return (
    <div className="flex justify-end pl-12">
      <div className="max-w-full rounded-2xl rounded-br-md bg-surface-3 px-4 py-2.5 text-[15px] leading-relaxed text-fg">
        <p className="selectable whitespace-pre-wrap break-words">{item.text}</p>
        {item.attachments?.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.attachments.map((a) => (
              <span
                key={a.documentId}
                className="inline-flex h-7 max-w-60 items-center gap-1.5 rounded-lg bg-surface px-2 text-[12.5px] font-medium text-fg-muted ring-1 ring-line"
              >
                <FileText size={13} aria-hidden />
                <span className="truncate">{a.name}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});

export const AssistantMessage = memo(function AssistantMessage({ item }: { item: AssistantItem }) {
  const t = useT(chatDict);
  const streaming = item.status === 'streaming';
  return (
    <div className="flex">
      <div className="min-w-0 flex-1">
        <span className="sr-only">{t.assistant}:</span>
        {item.text ? (
          <Markdown text={item.text} streaming={streaming} />
        ) : streaming ? (
          <p className="flex h-6 items-center gap-1">
            <span className="sr-only">{t.writing}</span>
            {[0, 180, 360].map((delay) => (
              <span
                key={delay}
                className="size-1.5 animate-pulse-soft rounded-full bg-fg-subtle"
                style={{ animationDelay: `${delay}ms` }}
                aria-hidden
              />
            ))}
          </p>
        ) : null}
        {item.status === 'aborted' ? (
          <p className="mt-1.5 text-[12.5px] text-fg-subtle">{t.aborted}</p>
        ) : null}
        {item.status === 'error' ? (
          <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-danger">
            <CircleAlert size={14} aria-hidden />
            {t.failed}
          </p>
        ) : null}
      </div>
    </div>
  );
});

function useLabel(item: ActivityItem) {
  const lang = useLang();
  const credentials = useVaultStore((s) => s.overview?.credentials);
  return activityLabel(item.tool, item.args, {
    lang,
    credentialKind: (id) => credentials?.find((c) => c.id === id)?.kind,
  });
}

/** Failed background work stays visible without exposing internal calls or their results. */
export function ActivityFailure() {
  const t = useT(chatDict);
  return (
    <p
      role="alert"
      className="flex min-h-8 items-center gap-2 text-[13px] text-st-blocked-fg"
      data-testid="activity-failure"
    >
      <CircleAlert size={14} className="shrink-0" aria-hidden />
      {t.activity.failed}
    </p>
  );
}

const NOTICE_STYLE = {
  info: { icon: Info, cls: 'bg-st-research-bg text-st-research-fg ring-st-research-line' },
  success: { icon: CircleCheck, cls: 'bg-st-done-bg text-st-done-fg ring-st-done-line' },
  warning: {
    icon: TriangleAlert,
    cls: 'bg-st-attention-bg text-st-attention-fg ring-st-attention-line',
  },
  error: { icon: CircleAlert, cls: 'bg-st-blocked-bg text-st-blocked-fg ring-st-blocked-line' },
} as const;

export function NoticeRow({ item }: { item: NoticeItem }) {
  const { icon: Icon, cls } = NOTICE_STYLE[item.level];
  return (
    <div className="flex justify-center" role={item.level === 'error' ? 'alert' : undefined}>
      <div
        className={cn(
          'inline-flex max-w-full items-start gap-2 rounded-xl px-3.5 py-2 text-[13px] font-medium ring-1 ring-inset',
          cls,
        )}
      >
        <Icon size={15} className="mt-px shrink-0" aria-hidden />
        <span className="selectable">{item.text}</span>
      </div>
    </div>
  );
}

/**
 * The assistant started a procedure, or a procedure's agent reported back: one compact row that
 * links to the procedure's card (the report itself is for the assistant; it shows on hover).
 */
export function ProcedureEventRow({ item }: { item: ActivityItem }) {
  const label = useLabel(item);
  const Icon = label.icon;
  const procedures = useProcedureStore((s) => s.byId);
  const focusProcedure = useAppStore((s) => s.focusProcedure);
  const id =
    typeof item.args.procedureId === 'string'
      ? item.args.procedureId
      : (/\bp_[a-f0-9]{16}\b/.exec(item.summary ?? '')?.[0] ??
        Object.values(procedures).find((p) => p.title === item.args.title)?.id);
  const procedure = id ? procedures[id] : undefined;
  const report = item.tool === REPORT_TOOL;

  return (
    <div className="flex" data-testid="procedure-event" data-tool={item.tool}>
      <button
        type="button"
        disabled={!procedure}
        onClick={() => procedure && focusProcedure(procedure.id)}
        title={report ? item.summary : undefined}
        className={cn(
          'group flex min-h-8 max-w-full items-center gap-2 rounded-full border border-line bg-surface px-3 text-[12.5px] shadow-xs transition-colors duration-150',
          procedure && 'hover:border-accent-line hover:bg-accent-soft',
        )}
      >
        {item.status === 'running' ? (
          <Spinner size={13} className="shrink-0 text-accent" />
        ) : item.status === 'error' ? (
          <CircleAlert size={14} className="shrink-0 text-st-blocked-fg" aria-hidden />
        ) : (
          <Icon size={14} className="shrink-0 text-accent-text" aria-hidden />
        )}
        <span className="min-w-0 truncate font-medium text-fg-muted group-hover:text-accent-text">
          {label.text}
        </span>
        {procedure ? (
          <span className="flex shrink-0 items-center gap-1 text-fg-subtle group-hover:text-accent-text">
            <ArrowUpRight size={12} aria-hidden />
          </span>
        ) : null}
      </button>
    </div>
  );
}

/** "Hoy · 3 oct", "Ayer · 2 oct", "lunes · 28 sept". */
export function DaySeparator({ date }: { date: string }) {
  const t = useT(chatDict);
  const lang = useLang();
  return (
    <div className="flex justify-center py-1">
      <span className="text-[12.5px] font-medium text-fg-subtle" data-testid="day-separator">
        {formatDay(date, lang, t.panel)}
      </span>
    </div>
  );
}

/** A question: docked in the chat (the assistant's) or `embedded` in a procedure's card. */
export function PromptCard({ item, embedded }: { item: PromptItem; embedded?: boolean }) {
  const procedureId = item.procedureId;
  switch (item.prompt.kind) {
    case 'form':
      return (
        <FormPromptCard
          item={item}
          prompt={item.prompt}
          procedureId={procedureId}
          embedded={embedded}
        />
      );
    case 'confirm':
      return <ConfirmPromptCard item={item} prompt={item.prompt} embedded={embedded} />;
    case 'user_action':
      return (
        <UserActionPromptCard
          item={item}
          prompt={item.prompt}
          procedureId={procedureId}
          embedded={embedded}
        />
      );
    case 'credential':
      return <CredentialPromptCard item={item} prompt={item.prompt} embedded={embedded} />;
    case 'phone_call':
      return <PhoneCallPromptCard item={item} prompt={item.prompt} embedded={embedded} />;
    case 'dnie_signature':
      return <DnieSignaturePromptCard item={item} prompt={item.prompt} embedded={embedded} />;
  }
}
