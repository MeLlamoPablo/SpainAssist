import type { CompanionStatus } from '@sa/shared';
import { Loader2, Smartphone, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { encode } from 'uqr';
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
function CompanionQr({ link, size = 196 }: { link: string; size?: number }) {
  const t = useT(companionDict);
  const path = useMemo(() => {
    const qr = encode(link, { ecc: 'M', border: 2 });
    let d = '';
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { d, size: qr.size };
  }, [link]);
  return (
    <svg
      role="img"
      aria-label={t.qrLabel}
      viewBox={`0 0 ${path.size} ${path.size}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-xl bg-white ring-1 ring-line"
      data-testid="companion-qr"
    >
      <path d={path.d} fill="#000" />
    </svg>
  );
}

/** QR code (until a phone pairs) and connection state, while no phone is connected. */
export function PairingPanel({
  status,
  className,
}: {
  status: CompanionStatus;
  className?: string;
}) {
  const t = useT(companionDict);
  // A paired phone reconnects on its own; its QR no longer works.
  const paired = !status.link && (status.state === 'away' || !!status.device);
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
      className={cn('flex flex-wrap items-center gap-5', className)}
      data-testid="companion-pairing"
      data-state={status.state}
    >
      {status.link ? (
        <CompanionQr link={status.link} />
      ) : paired ? (
        <div className="flex size-11 shrink-0 items-center justify-center self-start rounded-full bg-surface-2">
          <Smartphone size={20} className="text-fg-subtle" aria-hidden />
        </div>
      ) : (
        <div className="flex size-[196px] items-center justify-center rounded-xl bg-surface-2">
          <Loader2 size={20} className="animate-spin text-fg-subtle" aria-hidden />
        </div>
      )}
      <div className="min-w-[200px] flex-1">
        {paired ? (
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
        ) : (
          <>
            <p className="text-[14px] font-semibold text-fg">{t.scanTitle}</p>
            <p className="mt-1 text-[13px] text-fg-muted">{t.scanBody}</p>
          </>
        )}
        {status.state === 'connecting' ? (
          <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-fg-subtle">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            {t.connecting}
          </p>
        ) : null}
        {paired ? null : <p className="mt-3 text-[12.5px] text-fg-subtle">{t.getApp}</p>}
      </div>
    </div>
  );
}
