import type { WindowControlsStyle } from '@sa/shared';
import { Minus, Square, X } from 'lucide-react';
import { isMockApi } from '../lib/api';
import { cn } from '../lib/cn';
import { useAppStore } from '../store/app';

/**
 * Browser preview only: draws macOS traffic lights where Electron's hidden-inset title bar puts
 * them, so the standalone preview (and its screenshots) looks like the real window.
 */
export function PreviewTrafficLights() {
  const platform = useAppStore((s) => s.info?.platform);
  if (!isMockApi() || window.sa || platform !== 'darwin') return null;
  return (
    <div className="pointer-events-none fixed top-5 left-5 z-[70] flex gap-2" aria-hidden>
      <span className="size-3 rounded-full bg-(--sa-window-close) ring-1 ring-(--sa-black-10) ring-inset" />
      <span className="size-3 rounded-full bg-(--sa-window-minimize) ring-1 ring-(--sa-black-10) ring-inset" />
      <span className="size-3 rounded-full bg-(--sa-window-maximize) ring-1 ring-(--sa-black-10) ring-inset" />
    </div>
  );
}

/**
 * Browser preview only: draws Windows' window controls (— ☐ ✕) where Electron's title-bar
 * overlay puts them, in the colours main gives them (`app.windowControls`).
 */
export function PreviewWindowControls({ style }: { style: WindowControlsStyle }) {
  const platform = useAppStore((s) => s.info?.platform);
  if (!isMockApi() || window.sa || (platform !== 'win32' && platform !== 'linux')) return null;
  return (
    <div
      className={cn(
        'pointer-events-none fixed top-0 right-0 z-[70] flex',
        style === 'onboarding' ? 'h-[52px] text-(--sa-white)' : 'h-[64px] text-fg',
      )}
      aria-hidden
    >
      {(
        [
          ['minimize', Minus, 15],
          ['maximize', Square, 11],
          ['close', X, 15],
        ] as const
      ).map(([key, Icon, size]) => (
        <span key={key} className="flex w-[46px] items-center justify-center">
          <Icon size={size} strokeWidth={1.25} />
        </span>
      ))}
    </div>
  );
}
