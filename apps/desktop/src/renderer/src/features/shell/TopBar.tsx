import {
  CircleAlert,
  ClipboardList,
  type LucideIcon,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { defineDict, useLang, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { formatCredits } from '../../lib/format';
import { useAppStore, type View } from '../../store/app';
import { cardState, useProcedureStore } from '../../store/procedures';

const dict = defineDict({
  es: {
    nav: 'Secciones',
    procedures: 'Mis trámites',
    myData: 'Mis datos',
    settings: 'Ajustes',
    waiting: (n: number) => (n === 1 ? '1 trámite te espera' : `${n} trámites te esperan`),
    voucher: 'Bono',
    lowCredit: 'Te queda poco saldo',
    none: 'Conecta una IA',
    error: 'Revisa la conexión con la IA',
  },
  en: {
    nav: 'Sections',
    procedures: 'My procedures',
    myData: 'My data',
    settings: 'Settings',
    waiting: (n: number) =>
      n === 1 ? '1 procedure is waiting for you' : `${n} procedures are waiting for you`,
    voucher: 'Voucher',
    lowCredit: 'Credit is running low',
    none: 'Connect an AI',
    error: 'Check the AI connection',
  },
});

const TABS: { kind: View['kind']; icon: LucideIcon; key: 'procedures' | 'myData' | 'settings' }[] =
  [
    { kind: 'procedures', icon: ClipboardList, key: 'procedures' },
    { kind: 'vault', icon: ShieldCheck, key: 'myData' },
    { kind: 'settings', icon: Settings, key: 'settings' },
  ];

/** Tabs of the right-hand pane, and how much AI credit is left. Doubles as the title bar. */
export function TopBar() {
  const t = useT(dict);
  const view = useAppStore((s) => s.view);
  const navigate = useAppStore((s) => s.navigate);
  const procedures = useProcedureStore(useShallow((s) => Object.values(s.byId)));
  const waiting = useMemo(
    () => procedures.filter((p) => !p.archived && cardState(p) === 'yourTurn').length,
    [procedures],
  );

  return (
    <header className="drag flex h-[64px] shrink-0 items-center gap-3 px-6 @min-[760px]:gap-4 @min-[760px]:px-8">
      <nav aria-label={t.nav} className="no-drag flex shrink-0 items-center gap-1">
        {TABS.map(({ kind, icon: Icon, key }) => {
          const active = view.kind === kind;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => navigate({ kind } as View)}
              aria-current={active ? 'page' : undefined}
              data-testid={`tab-${kind}`}
              className={cn(
                'flex h-9 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 text-[14px] @min-[760px]:px-3 transition-colors duration-150',
                active
                  ? 'bg-surface-3 font-semibold text-fg'
                  : 'font-medium text-fg-muted hover:bg-surface-3/60 hover:text-fg',
              )}
            >
              <Icon size={17} aria-hidden className={active ? 'text-fg' : 'text-fg-subtle'} />
              <span className="grid">
                {/* Reserve the bold label's width so selecting a tab never shifts the nav. */}
                <span aria-hidden className="invisible col-start-1 row-start-1 font-semibold">
                  {t[key]}
                </span>
                <span className="col-start-1 row-start-1">{t[key]}</span>
              </span>
              {kind === 'procedures' && waiting > 0 ? (
                <span
                  className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-st-attention-dot px-1 text-[11px] font-semibold tabular-nums text-(--sa-white)"
                  title={t.waiting(waiting)}
                >
                  {waiting}
                  <span className="sr-only">: {t.waiting(waiting)}</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <span className="flex-1" />
      <CreditMeter />
    </header>
  );
}

function CreditMeter() {
  const t = useT(dict);
  const lang = useLang();
  const provider = useAppStore((s) => s.provider);
  const navigate = useAppStore((s) => s.navigate);
  const open = () => navigate({ kind: 'settings', section: 'provider' });

  if (!provider) return null;
  if (!provider.configured || provider.error) {
    return (
      <button
        type="button"
        onClick={open}
        className="no-drag flex h-8 items-center gap-2 rounded-lg bg-st-attention-bg px-3 text-[13px] font-semibold text-st-attention-fg ring-1 ring-st-attention-line ring-inset hover:brightness-[0.98]"
      >
        <CircleAlert size={15} aria-hidden />
        {provider.configured ? t.error : t.none}
      </button>
    );
  }

  const credit = provider.credit;
  const hasCredit = credit && credit.limitUsd !== null && credit.remainingUsd !== null;
  const ratio = hasCredit ? Math.max(0, Math.min(1, credit.remainingUsd! / credit.limitUsd!)) : 0;
  const low = hasCredit && ratio < 0.2;
  const name = provider.kind === 'voucher' ? t.voucher : (provider.label ?? provider.kind);

  return (
    <button
      type="button"
      onClick={open}
      title={low ? t.lowCredit : undefined}
      className="no-drag flex h-9 min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-fg-muted hover:bg-surface-3/60"
      data-testid="credit-meter"
    >
      {hasCredit ? (
        <span className={cn('tabular-nums', low && 'font-semibold text-danger')}>
          {formatCredits(credit.remainingUsd!, lang)}
        </span>
      ) : (
        <>
          <Sparkles size={16} className="shrink-0 text-fg-muted" aria-hidden />
          <span className="hidden max-w-[220px] truncate @min-[720px]:inline">{name}</span>
        </>
      )}
    </button>
  );
}
