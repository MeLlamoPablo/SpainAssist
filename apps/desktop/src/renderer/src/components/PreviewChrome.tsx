import { isMockApi } from '../lib/api';
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
