import type {
  DocumentMeta,
  ProcedureListItem,
  ProcedureStep,
  Requirement,
  RequirementStatus,
} from '@sa/shared';
import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  Download,
  ExternalLink,
  FileText,
  Globe,
  type LucideIcon,
  Minus,
  X,
} from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { IconButton } from '../../components/ui/button';
import { useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { hostOf } from '../../lib/format';
import { useVaultStore } from '../../store/vault';
import { procedureDict } from '../procedures/i18n';
import { openDocument, useDownloadDocument } from '../vault/document-actions';
import { codemodeDict } from './i18n';

/**
 * The folded part of a card ("Detalles"): the plan on one side, documents and official sources
 * on the other. Also what the top of the card leaves out: the summary when facts stand in for
 * it, and the requirements when none is missing (missing ones are on the card, under
 * "Necesitas"). What the agents did is not shown: what matters reaches the user through the chat
 * and the card.
 */
export function ProcedureDetails({ procedure: p }: { procedure: ProcedureListItem }) {
  const t = useT(procedureDict);
  const tr = useT(codemodeDict);
  const docs = useVaultStore((s) => s.overview?.documents);
  const mine = useMemo(() => (docs ?? []).filter((d) => d.procedureId === p.id), [docs, p.id]);
  const requirements = p.requirements.some((r) => r.status === 'missing') ? [] : p.requirements;

  return (
    <div className="mt-4 border-t border-line pt-6" data-testid="card-plan">
      {p.summary && p.facts.length ? (
        <p className="selectable mb-6 max-w-[68ch] text-[13.5px] leading-relaxed text-fg-muted">
          {p.summary}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 @min-[560px]:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          {p.steps.length ? (
            <Section title={tr.row.plan}>
              <Steps steps={p.steps} />
            </Section>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          {requirements.length ? <Requirements items={requirements} /> : null}
          {mine.length ? (
            <Section title={t.documents}>
              <ul className="flex flex-col gap-2">
                {mine.map((d) => (
                  <li key={d.id}>
                    <DocumentRow doc={d} />
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {p.sources.length ? (
            <Section title={t.sources}>
              <ul className="-mx-2 flex flex-col gap-0.5">
                {p.sources.map((s) => {
                  const host = hostOf(s.url);
                  return (
                    <li key={s.url}>
                      <button
                        type="button"
                        onClick={() => void api.invoke('app.openExternal', s.url)}
                        title={t.openSource(host)}
                        className="group flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
                      >
                        <Globe size={15} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13.5px] font-medium leading-snug text-fg group-hover:underline group-hover:underline-offset-2">
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
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-[13px] font-medium text-fg-subtle">{title}</h3>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------

function StepMarker({ status }: { status: ProcedureStep['status'] }) {
  if (status === 'done')
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-st-done-dot text-(--sa-white)">
        <Check size={12} strokeWidth={3.2} aria-hidden />
      </span>
    );
  if (status === 'current')
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-accent bg-surface">
        <span className="size-2 rounded-full bg-accent" />
      </span>
    );
  if (status === 'failed')
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-st-blocked-dot text-(--sa-white)">
        <X size={12} strokeWidth={3} aria-hidden />
      </span>
    );
  if (status === 'skipped')
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-line-strong bg-surface text-fg-faint">
        <Minus size={11} strokeWidth={3} aria-hidden />
      </span>
    );
  return (
    <span className="block size-5 shrink-0 rounded-full border-2 border-line-strong bg-surface" />
  );
}

function Steps({ steps }: { steps: ProcedureStep[] }) {
  const t = useT(procedureDict);
  return (
    <ol className="relative" data-testid="card-steps">
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        return (
          <li key={step.id} className="relative flex gap-3 pb-3.5 last:pb-0">
            {!last ? (
              <span
                className={cn(
                  'absolute top-6 bottom-1 left-[9.5px] w-px',
                  step.status === 'done' ? 'bg-st-done-dot/40' : 'bg-line-strong/70',
                )}
                aria-hidden
              />
            ) : null}
            <span className="relative z-[1] flex">
              <StepMarker status={step.status} />
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'text-[14px] leading-5',
                  step.status === 'current' && 'font-semibold text-fg',
                  step.status === 'done' && 'text-fg',
                  step.status === 'pending' && 'text-fg-subtle',
                  step.status === 'skipped' && 'text-fg-subtle line-through',
                  step.status === 'failed' && 'font-medium text-st-blocked-fg',
                )}
              >
                <span className="sr-only">{t.stepStatus[step.status]}: </span>
                {step.title}
              </p>
              {step.detail && step.status === 'current' ? (
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{step.detail}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------
// Requirements (all in hand), documents
// ---------------------------------------------------------------------------------------------

/** How each requirement status is marked, on the card and here. */
export const REQUIREMENT_ICON: Record<RequirementStatus, { icon: LucideIcon; className: string }> =
  {
    have: { icon: CircleCheck, className: 'text-st-done-dot' },
    missing: { icon: CircleAlert, className: 'text-st-attention-dot' },
    not_needed: { icon: CircleMinus, className: 'text-fg-faint' },
  };

function Requirements({ items }: { items: Requirement[] }) {
  const tr = useT(codemodeDict);
  const tc = useT(common);
  return (
    <Section title={tr.row.requirements}>
      <ul className="flex flex-col gap-2.5">
        {items.map((r) => {
          const { icon: Icon, className } = REQUIREMENT_ICON[r.status];
          return (
            <li key={r.id} className="flex items-start gap-2.5">
              <Icon size={16} className={cn('mt-px shrink-0', className)} aria-hidden />
              <div className="selectable min-w-0 flex-1">
                <p
                  className={cn(
                    'text-[14px] leading-snug text-fg',
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

function DocumentRow({ doc }: { doc: DocumentMeta }) {
  const t = useT(procedureDict);
  const { download, downloading } = useDownloadDocument(doc.id);
  return (
    <div className="flex items-center gap-1 rounded-xl border border-line bg-surface pr-2 transition-colors hover:bg-surface-2">
      <button
        type="button"
        onClick={() => openDocument(doc.id)}
        title={t.openDocument}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-2 pl-2.5 text-left"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-fg-muted">
          <FileText size={16} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg">
          {doc.name}
        </span>
        <ExternalLink size={14} className="shrink-0 text-fg-subtle" aria-hidden />
      </button>
      <IconButton
        icon={Download}
        label={t.downloadDocument}
        size="sm"
        disabled={downloading}
        onClick={download}
      />
    </div>
  );
}
