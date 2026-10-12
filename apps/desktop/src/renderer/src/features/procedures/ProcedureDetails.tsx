import type { ProcedureListItem, Requirement, RequirementStatus } from '@sa/shared';
import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleQuestionMark,
  ExternalLink,
  FileText,
  Globe,
  type LucideIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { hostOf } from '../../lib/format';
import { useVaultStore } from '../../store/vault';
import { procedureDict } from './i18n';

/**
 * Everything that does not fit on the card: what you need, documents and official sources.
 * What the agents did is not shown: what matters reaches the user through the chat and the card.
 */
export function ProcedureDetails({ procedure: p }: { procedure: ProcedureListItem }) {
  const t = useT(procedureDict);
  const docs = useVaultStore((s) => s.overview?.documents);
  const mine = useMemo(() => (docs ?? []).filter((d) => d.procedureId === p.id), [docs, p.id]);

  return (
    <div className="grid grid-cols-1 gap-6 border-t border-line bg-surface-2/50 px-6 pt-5 pb-6 @min-[600px]:grid-cols-2">
      <div className="flex flex-col gap-6">
        {p.requirements.length ? <Requirements items={p.requirements} /> : null}
        {p.summary && p.facts.length ? (
          <p className="text-[13.5px] leading-relaxed text-fg-muted">{p.summary}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-6">
        {mine.length ? (
          <Section title={t.documents}>
            <ul className="flex flex-col gap-1">
              {mine.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => void api.invoke('vault.openDocument', d.id)}
                    title={t.openDocument}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-left shadow-xs hover:bg-surface-2"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text">
                      <FileText size={15} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
                      {d.name}
                    </span>
                    <ExternalLink size={13} className="shrink-0 text-fg-faint" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {p.sources.length ? (
          <Section title={t.sources}>
            <ul className="flex flex-col gap-0.5">
              {p.sources.map((s) => {
                const host = hostOf(s.url);
                return (
                  <li key={s.url}>
                    <button
                      type="button"
                      onClick={() => void api.invoke('app.openExternal', s.url)}
                      title={t.openSource(host)}
                      className="group flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-3/70"
                    >
                      <Globe size={14} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium leading-snug text-fg group-hover:text-accent-text">
                          {s.title}
                        </span>
                        <span className="block truncate text-[12px] text-fg-subtle">{host}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[12.5px] font-semibold text-fg-subtle">{title}</h3>
      {children}
    </section>
  );
}

const REQ_STYLE: Record<RequirementStatus, { icon: LucideIcon; icls: string }> = {
  have: { icon: CircleCheck, icls: 'text-st-done-dot' },
  missing: {
    icon: CircleAlert,
    icls: 'text-st-attention-dot',
  },
  unknown: {
    icon: CircleQuestionMark,
    icls: 'text-fg-faint',
  },
  not_needed: {
    icon: CircleMinus,
    icls: 'text-fg-faint',
  },
};

function Requirements({ items }: { items: Requirement[] }) {
  const t = useT(procedureDict);
  const tc = useT(common);
  return (
    <Section title={t.needs}>
      <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {items.map((r) => {
          const s = REQ_STYLE[r.status];
          const Icon = s.icon;
          return (
            <li key={r.id} className="flex items-start gap-2.5 px-3 py-2.5">
              <Icon size={16} className={cn('mt-px shrink-0', s.icls)} aria-hidden />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'text-[13px] font-medium leading-snug text-fg',
                    r.status === 'not_needed' && 'text-fg-subtle line-through decoration-fg-faint',
                  )}
                >
                  {r.label}
                </p>
                {r.detail ? <p className="mt-0.5 text-[12.5px] text-fg-muted">{r.detail}</p> : null}
              </div>
              <span className="sr-only">{tc.requirement[r.status]}</span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
