import { type CompanionStatus, companionOutdatedSide } from '@sa/shared';
import { Loader2, RotateCw, Smartphone, TriangleAlert, WifiOff } from 'lucide-react';
import { useMemo } from 'react';
import { encode } from 'uqr';
import { BrandMark } from '../../components/brand';
import { Button } from '../../components/ui/button';
import { useT } from '../../i18n';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useAppStore } from '../../store/app';
import { toast } from '../../store/toast';
import { companionDict } from './i18n';

/**
 * The pairing link as a QR code. Always dark modules on a white tile, whatever the theme:
 * phone scanners read inverted codes badly.
 */
function CompanionQr({ link, size = 232 }: { link: string; size?: number }) {
  const t = useT(companionDict);
  const path = useMemo(() => {
    // Leave a full quiet zone and enough redundancy for the small centre mark.
    const qr = encode(link, { ecc: 'H', border: 4 });
    const finders = [
      [4, 4],
      [qr.size - 11, 4],
      [4, qr.size - 11],
    ];
    let d = '';
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (!dark || finders.some(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7))
          return;
        d += `M${x + 0.2} ${y}h.6q.2 0 .2.2v.6q0 .2-.2.2h-.6q-.2 0-.2-.2v-.6q0-.2.2-.2z`;
      });
    });
    return { d, size: qr.size, finders };
  }, [link]);
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-2xl bg-white shadow-xs ring-1 ring-line"
      style={{ width: size, height: size }}
    >
      <svg
        role="img"
        aria-label={t.qrLabel}
        viewBox={`0 0 ${path.size} ${path.size}`}
        width={size}
        height={size}
        data-testid="companion-qr"
      >
        <rect width={path.size} height={path.size} fill="#fff" />
        <path d={path.d} fill="#201c19" />
        {path.finders.map(([x, y]) => (
          <g key={`${x}-${y}`}>
            <rect x={x} y={y} width={7} height={7} rx={1.4} fill="#201c19" />
            <rect x={x + 1} y={y + 1} width={5} height={5} rx={0.8} fill="#fff" />
            <rect x={x + 2} y={y + 2} width={3} height={3} rx={0.6} fill="#201c19" />
          </g>
        ))}
      </svg>
      <span
        aria-hidden
        className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg bg-white"
        style={{ width: size * 0.18, height: size * 0.18 }}
      >
        <BrandMark size={size * 0.15} />
      </span>
    </div>
  );
}

/**
 * QR code (until a phone pairs) and connection state, while no phone is connected. With
 * `request`, a DNIe request waits for a paired phone: opening the app is the user's next step.
 * Says which app to update when the phone speaks another protocol version, and when the relay
 * can't be reached (`stalled`) hides the QR and offers to try again.
 */
export function PairingPanel({
  status,
  request,
  className,
}: {
  status: CompanionStatus;
  request?: boolean;
  className?: string;
}) {
  const t = useT(companionDict);
  // A paired phone reconnects on its own; its QR no longer works.
  const paired = !status.link && (status.state === 'away' || !!status.device);
  const stalled = status.state === 'connecting' && !!status.stalled;
  const pairAnother = async () => {
    try {
      useAppStore.setState({ companion: await api.invoke('companion.pairAnother') });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const pairAgain = async () => {
    try {
      useAppStore.setState({ companion: await api.invoke('companion.pair') });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  if (status.state === 'unavailable')
    return (
      <p className={cn('flex items-start gap-2 text-[13.5px] text-fg-muted', className)}>
        <TriangleAlert size={16} className="mt-0.5 shrink-0 text-st-attention-fg" aria-hidden />
        {t.unavailable}
      </p>
    );
  // The pairing ended on its own (from the phone, its 72 hours, the relay): say why.
  if (status.state === 'off' && status.reason)
    return (
      <div
        className={cn('flex items-start gap-2', className)}
        data-testid="companion-ended"
        data-reason={status.reason}
      >
        <TriangleAlert size={16} className="mt-0.5 shrink-0 text-st-attention-fg" aria-hidden />
        <div className="min-w-0">
          <p className="text-[13.5px] text-fg">{t.ended[status.reason]}</p>
          <Button
            variant="secondary"
            size="sm"
            icon={Smartphone}
            className="mt-3"
            onClick={() => void pairAgain()}
          >
            {t.pairAgain}
          </Button>
        </div>
      </div>
    );
  if (status.state === 'connected')
    return (
      <p
        className={cn('flex items-center gap-2 text-[13.5px] font-medium text-fg', className)}
        data-testid="companion-connected"
      >
        <Smartphone size={16} className="text-st-done-fg" aria-hidden />
        {t.connected(status.device ?? t.app)}
      </p>
    );
  return (
    <div
      className={cn(
        'flex items-center',
        paired || stalled ? 'flex-wrap gap-5' : 'flex-col gap-4 py-2',
        paired && request && 'gap-3',
        className,
      )}
      data-testid="companion-pairing"
      data-state={status.state}
    >
      {status.outdated ? <OutdatedNotice side={companionOutdatedSide(status.outdated)} /> : null}
      {stalled && !paired ? (
        <div className="flex size-[232px] items-center justify-center rounded-2xl bg-st-attention-bg">
          <WifiOff size={22} className="text-st-attention-fg" aria-hidden />
        </div>
      ) : status.link ? (
        <CompanionQr link={status.link} />
      ) : paired && request ? (
        <span className="flex size-10 shrink-0 items-center justify-center self-start rounded-xl bg-st-attention-bg text-st-attention-fg">
          <Smartphone size={19} aria-hidden />
        </span>
      ) : paired ? (
        <div className="flex size-11 shrink-0 items-center justify-center self-start rounded-full bg-surface-2">
          <Smartphone size={20} className="text-fg-subtle" aria-hidden />
        </div>
      ) : (
        <div className="flex size-[232px] items-center justify-center rounded-2xl bg-surface-2">
          <Loader2 size={20} className="animate-spin text-fg-subtle" aria-hidden />
        </div>
      )}
      <div className={cn('min-w-[200px] flex-1', !paired && !stalled && 'text-center')}>
        {paired && request ? (
          <>
            <p className="text-[14.5px] font-semibold text-fg" data-testid="companion-open-app">
              {t.openApp}
            </p>
            <p className="mt-0.5 text-[13px] text-fg-muted">{t.openAppHint}</p>
            <p className="mt-2 text-[12.5px] text-fg-subtle">
              {t.notConnected(status.device ?? t.app)}. {t.otherPhone}
            </p>
            <Button
              variant="secondary"
              size="sm"
              icon={Smartphone}
              className="mt-3"
              onClick={() => void pairAnother()}
            >
              {t.pairOther}
            </Button>
          </>
        ) : paired ? (
          <>
            <p className="text-[14px] font-semibold text-fg">{t.away(status.device ?? t.app)}</p>
            <p className="mt-1 text-[13px] text-fg-muted">{t.otherPhone}</p>
            <Button
              variant="secondary"
              size="sm"
              icon={Smartphone}
              className="mt-3"
              onClick={() => void pairAnother()}
            >
              {t.pairOther}
            </Button>
          </>
        ) : stalled ? (
          <div data-testid="companion-stalled">
            <p className="text-[14px] font-semibold text-fg">{t.stalled}</p>
            <Button
              variant="secondary"
              size="sm"
              icon={RotateCw}
              className="mt-3"
              onClick={() => void pairAnother()}
            >
              {t.retry}
            </Button>
          </div>
        ) : (
          <p className="text-[14px] font-semibold text-fg">{t.scanTitle}</p>
        )}
        {stalled && paired ? (
          <p
            className="mt-2 flex items-center gap-1.5 text-[12.5px] text-st-attention-fg"
            data-testid="companion-stalled"
          >
            <WifiOff size={13} aria-hidden />
            {t.stalled}
          </p>
        ) : status.state === 'connecting' && !stalled ? (
          <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-fg-subtle">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            {t.connecting}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The phone and this desktop speak different protocol versions: which app to update. */
export function OutdatedNotice({ side }: { side: 'phone' | 'desktop' }) {
  const t = useT(companionDict);
  return (
    <p
      role="alert"
      className="flex basis-full items-start gap-2 rounded-lg bg-st-attention-bg px-3 py-2 text-[13px] font-medium text-st-attention-fg ring-1 ring-st-attention-line ring-inset"
      data-testid="companion-outdated"
      data-side={side}
    >
      <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
      {t.outdated[side]}
    </p>
  );
}
