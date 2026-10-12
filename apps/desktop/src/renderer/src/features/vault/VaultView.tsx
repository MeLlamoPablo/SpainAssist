import { EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useEffect, useState } from 'react';
import { Skeleton } from '../../components/ui/misc';
import { useT } from '../../i18n';
import { cn } from '../../lib/cn';
import type { VaultTab } from '../../store/app';
import { useVaultStore } from '../../store/vault';
import { CredentialsSection } from './CredentialsSection';
import { DocumentsSection } from './DocumentsSection';
import { vaultDict } from './i18n';
import { PersonalSection } from './PersonalSection';

const TABS: VaultTab[] = ['personal', 'documents', 'credentials'];

export function VaultView({ initialTab }: { initialTab?: VaultTab }) {
  const t = useT(vaultDict);
  const overview = useVaultStore((s) => s.overview);
  const [tab, setTab] = useState<VaultTab>(initialTab ?? 'personal');

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  const counts: Partial<Record<VaultTab, number>> = overview
    ? {
        personal: overview.personal.length,
        documents: overview.documents.length,
        credentials: overview.credentials.length,
      }
    : {};

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto" id="vault-scroll" data-scroll-stable>
        <div className="mx-auto w-full max-w-[880px] px-8 pt-4.5 pb-16">
          <h1 className="sr-only">{t.title}</h1>
          <ul className="grid grid-cols-1 gap-3 @min-[760px]:grid-cols-3">
            {[
              { icon: Lock, text: t.trust.device },
              { icon: EyeOff, text: t.trust.passwords },
              { icon: ShieldCheck, text: t.trust.ai },
            ].map(({ icon: Icon, text }) => (
              <li
                key={text}
                className="flex min-h-[108px] flex-col gap-[13px] rounded-[14px] bg-surface p-4 text-[13px] leading-snug text-fg-muted ring-1 ring-line ring-inset"
              >
                <Icon size={15} className="shrink-0 text-st-done-dot" aria-hidden />
                {text}
              </li>
            ))}
          </ul>

          {overview && !overview.storage.secure ? (
            <p className="mt-4 rounded-lg bg-st-attention-bg px-3 py-2 text-[13px] text-st-attention-fg">
              {t.privacy.insecure}
            </p>
          ) : null}

          <Tabs.Root value={tab} onValueChange={(v) => setTab(v as VaultTab)} className="mt-8">
            <Tabs.List
              aria-label={t.title}
              className="sticky top-0 z-10 -mx-1 flex gap-1 overflow-x-auto overflow-y-hidden bg-surface/95 shadow-[inset_0_-1px_0_var(--color-line)] px-1 backdrop-blur"
            >
              {TABS.map((key) => (
                <Tabs.Trigger
                  key={key}
                  value={key}
                  className={cn(
                    'relative flex h-11 shrink-0 items-center gap-2 px-3 text-[13.5px] font-medium text-fg-muted transition-colors duration-150 hover:text-fg',
                    'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent data-[state=active]:text-fg data-[state=active]:after:bg-accent',
                  )}
                  data-testid={`vault-tab-${key}`}
                >
                  {t.tabs[key]}
                  {counts[key] !== undefined ? (
                    <span className="rounded-full bg-surface-3 px-1.5 text-[11px] tabular-nums text-fg-subtle">
                      {counts[key]}
                    </span>
                  ) : null}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            {overview ? (
              <>
                <Tabs.Content value="personal" className="pt-6 focus:outline-none">
                  <PersonalSection overview={overview} />
                </Tabs.Content>
                <Tabs.Content value="documents" className="pt-6 focus:outline-none">
                  <DocumentsSection overview={overview} />
                </Tabs.Content>
                <Tabs.Content value="credentials" className="pt-6 focus:outline-none">
                  <CredentialsSection overview={overview} />
                </Tabs.Content>
              </>
            ) : (
              <div className="flex flex-col gap-3 pt-6">
                <Skeleton className="h-24 rounded-xl" />
                <Skeleton className="h-40 rounded-xl" />
              </div>
            )}
          </Tabs.Root>
        </div>
      </div>
    </div>
  );
}

/** Lead paragraph + actions row used at the top of every vault section. */
export function SectionIntro({ lead, actions }: { lead: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-[520px] text-[14px] text-fg-muted">{lead}</p>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
