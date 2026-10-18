import type { Language, SettingsPatch } from '@sa/shared';
import {
  Bug,
  ChevronDown,
  Download,
  FileArchive,
  Globe,
  Share2,
  Sparkles,
  Ticket,
} from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { BrandMark, BrandName } from '../../components/brand';
import { Button } from '../../components/ui/button';
import { SegmentedControl, Switch } from '../../components/ui/controls';
import { Card, Pill } from '../../components/ui/misc';
import { useT } from '../../i18n';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { type SettingsSection, useAppStore } from '../../store/app';
import { toast } from '../../store/toast';
import { settingsDict } from './i18n';
import {
  ByokForm,
  ChatGptConnect,
  CodexDeviceConnect,
  CustomProviderForm,
  ExaKeyForm,
  ModelPicker,
  ProviderStatusCard,
  VoucherRedeem,
} from './provider';
import { WipeDataSection } from './WipeDataSection';

async function update(patch: SettingsPatch) {
  const settings = await api.invoke('settings.update', patch);
  useAppStore.setState({ settings });
  return settings;
}

export function SettingsView({ section }: { section?: SettingsSection }) {
  const t = useT(settingsDict);
  const settings = useAppStore((s) => s.settings);
  const info = useAppStore((s) => s.info);
  const kind = useAppStore((s) => s.provider?.kind);
  // With a voucher connected, more codes top up its balance; ChatGPT is not offered.
  const voucherConnected = kind === 'voucher';
  // A ChatGPT subscription needs nothing else: the card shows only its status.
  const chatGptConnected = kind === 'chatgpt' || kind === 'codex';
  // Without a gateway key, web research uses Exa, keyless or with the user's own key.
  const researchesWithExa = kind === 'byok' || kind === 'custom';
  const scrollRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef<HTMLDivElement>(null);
  const generalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = section === 'provider' ? providerRef : section === 'general' ? generalRef : null;
    const scroller = scrollRef.current;
    const element = target?.current;
    if (!scroller || !element) return;
    scroller.scrollTo({
      top:
        scroller.scrollTop +
        element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        16,
      behavior: 'smooth',
    });
  }, [section]);

  if (!settings) return null;

  const set = async (patch: SettingsPatch) => {
    try {
      await update(patch);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} data-scroll-stable className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-8 pt-2 pb-16">
          <h1 className="sr-only">{t.title}</h1>

          <div ref={providerRef} className="scroll-mt-4">
            <SectionCard icon={Sparkles} title={t.provider.title}>
              <ProviderStatusCard />
              {researchesWithExa ? (
                <div className="mt-5 border-t border-line pt-5">
                  <ExaKeyForm />
                </div>
              ) : null}
              {chatGptConnected ? null : (
                <>
                  <div
                    className={cn(
                      'mt-5 flex flex-col',
                      // A lone "Añadir otro código" row sits on the card without a frame.
                      !voucherConnected && 'divide-y divide-line rounded-xl border border-line',
                    )}
                  >
                    {voucherConnected ? null : (
                      <OptionRow
                        title={t.provider.chatgpt.title}
                        body={t.provider.chatgpt.body}
                        icon={Sparkles}
                      >
                        <ChatGptConnect />
                      </OptionRow>
                    )}
                    <OptionRow
                      title={
                        voucherConnected ? t.provider.voucher.addTitle : t.provider.voucher.title
                      }
                      body={voucherConnected ? undefined : t.provider.voucher.body}
                      icon={Ticket}
                      naked={voucherConnected}
                    >
                      <VoucherRedeem naked={voucherConnected} />
                    </OptionRow>
                  </div>
                  <Advanced title={t.provider.advanced.title}>
                    <div className="flex flex-col gap-6">
                      <SubSection
                        title={t.provider.advanced.byok}
                        body={t.provider.advanced.byokBody}
                      >
                        <ByokForm />
                      </SubSection>
                      <SubSection
                        title={t.provider.advanced.custom}
                        body={t.provider.advanced.customBody}
                      >
                        <CustomProviderForm />
                      </SubSection>
                      {/* Impersonates Codex CLI (against OpenAI's terms): never in production builds. */}
                      {import.meta.env.DEV ? (
                        <SubSection
                          title={t.provider.advanced.codex}
                          body={t.provider.advanced.codexBody}
                        >
                          <CodexDeviceConnect />
                        </SubSection>
                      ) : null}
                      <ModelPicker />
                    </div>
                  </Advanced>
                </>
              )}
            </SectionCard>
          </div>

          <div ref={generalRef} className="scroll-mt-4">
            <SectionCard icon={Globe} title={t.language.title} lead={t.language.body}>
              <SegmentedControl<Language>
                label={t.language.title}
                value={settings.language}
                onValueChange={(language) => void set({ language })}
                options={[
                  { value: 'es', label: 'Español' },
                  { value: 'en', label: 'English' },
                ]}
              />
            </SectionCard>
          </div>

          <SectionCard icon={Share2} title={t.learnings.title}>
            <Switch
              checked={settings.shareLearnings}
              onCheckedChange={(shareLearnings) => void set({ shareLearnings })}
              label={t.learnings.title}
              description={t.learnings.body}
            />
          </SectionCard>

          {info?.features.errorReports ? (
            <SectionCard icon={Bug} title={t.errorReports.title}>
              <Switch
                checked={settings.errorReports}
                onCheckedChange={(errorReports) => void set({ errorReports })}
                label={t.errorReports.title}
                description={t.errorReports.body}
              />
            </SectionCard>
          ) : null}

          <ExportHistory />

          <WipeDataSection />

          <div className="px-6 py-2">
            <div className="flex items-center gap-4">
              <BrandMark size={44} />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-fg">
                  <BrandName className="text-[24px]" />
                  {info?.isDev ? <Pill size="sm">{t.about.dev}</Pill> : null}
                </p>
                <p className="text-[13px] text-fg-muted">
                  {info ? t.about.version(info.version) : ''}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExportHistory() {
  const t = useT(settingsDict);
  const [exporting, setExporting] = useState(false);

  const run = async () => {
    setExporting(true);
    try {
      toast.success(t.history.saved(await api.invoke('app.exportTranscripts')));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <SectionCard icon={FileArchive} title={t.history.title} lead={t.history.body}>
      <Button
        icon={Download}
        loading={exporting}
        onClick={() => void run()}
        data-testid="export-history"
      >
        {t.history.export}
      </Button>
    </SectionCard>
  );
}

function SectionCard({
  icon: Icon,
  title,
  lead,
  children,
}: {
  icon: typeof Sparkles;
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  return (
    <Card className="px-6 py-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-fg-muted">
          <Icon size={16} aria-hidden />
        </span>
        <div className="min-w-0 pt-1">
          <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
          {lead ? (
            <p className="mt-0.5 whitespace-pre-line text-[13.5px] text-fg-muted">{lead}</p>
          ) : null}
        </div>
      </div>
      {children}
    </Card>
  );
}

function OptionRow({
  icon: Icon,
  title,
  body,
  naked,
  children,
}: {
  icon: typeof Sparkles;
  title: string;
  body?: string;
  /** No frame around the row: no side padding, so it lines up with the card's content. */
  naked?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-3 @min-[700px]:grid-cols-[minmax(0,1fr)_minmax(0,300px)] @min-[700px]:items-center',
        naked ? 'py-1' : 'px-4 py-4',
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Icon size={17} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-fg">{title}</p>
          {body ? <p className="mt-0.5 text-[13px] text-fg-muted">{body}</p> : null}
        </div>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function SubSection({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <div>
      <p className="text-[14px] font-semibold text-fg">{title}</p>
      <p className="mb-3 text-[13px] text-fg-muted">{body}</p>
      {children}
    </div>
  );
}

function Advanced({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="mt-4">
      <Collapsible.Trigger className="flex w-full items-center gap-2 rounded-lg py-1.5 text-left text-[13.5px] font-medium text-fg-muted hover:text-fg">
        <ChevronDown
          size={16}
          className={cn('transition-transform duration-150', !open && '-rotate-90')}
          aria-hidden
        />
        {title}
      </Collapsible.Trigger>
      <Collapsible.Content className="pt-3 pl-6">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
