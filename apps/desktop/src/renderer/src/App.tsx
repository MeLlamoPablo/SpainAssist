import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { PreviewTrafficLights, PreviewWindowControls } from './components/PreviewChrome';
import { Toaster } from './components/ui/toaster';
import { TooltipProvider } from './components/ui/tooltip';
import { Onboarding } from './features/onboarding/Onboarding';
import { StoreMigration } from './features/shell/DataImport';
import { MustUpdate } from './features/shell/MustUpdate';
import { Shell } from './features/shell/Shell';
import { useT } from './i18n';
import { common } from './i18n/common';
import { api, isMockApi } from './lib/api';
import { useAppStore } from './store/app';

const Playground = lazy(() =>
  import('./features/playground/Playground').then((m) => ({ default: m.Playground })),
);

export function App() {
  const t = useT(common);
  const playground = isMockApi() && new URLSearchParams(location.search).has('playground');
  const onboardingDone = useAppStore((s) => s.settings?.onboardingCompleted ?? true);
  const lang = useAppStore((s) => s.settings?.language ?? 'es');
  // This version may no longer be used: nothing else of the app shows.
  const mustUpdate = useAppStore((s) => s.info?.features.mustUpdate ?? false);
  // The Store build shows nothing else until the GitHub install is gone and its data copied in.
  const dataImport = useAppStore((s) => s.dataImport.state);
  // Keep the onboarding on top of the freshly mounted app while it plays its exit.
  const [onboardingShown, setOnboardingShown] = useState(false);
  if (!onboardingDone && !onboardingShown) setOnboardingShown(true);
  const leaving = onboardingDone && onboardingShown;
  const onExited = useCallback(() => setOnboardingShown(false), []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Windows and Linux: white window controls over the onboarding's gradient, until it exits.
  const controls =
    !playground && !mustUpdate && dataImport === 'none' && !onboardingDone ? 'onboarding' : 'app';
  useEffect(() => {
    void api.invoke('app.windowControls', controls);
  }, [controls]);

  return (
    <TooltipProvider>
      {playground ? (
        <Suspense fallback={null}>
          <Playground />
        </Suspense>
      ) : mustUpdate ? (
        <MustUpdate />
      ) : dataImport !== 'none' ? (
        <StoreMigration />
      ) : (
        <div className="relative h-full">
          {onboardingDone ? (
            <div key="shell" className={leaving ? 'h-full animate-app-enter' : 'h-full'}>
              <Shell />
            </div>
          ) : null}
          {!onboardingDone || leaving ? (
            // Above the shell, but below dialogs (z-40/z-50), which portal to <body>.
            <div key="onboarding" className="absolute inset-0 z-30">
              <Onboarding exiting={leaving} onExited={onExited} />
            </div>
          ) : null}
        </div>
      )}
      {!playground && <PreviewTrafficLights />}
      {!playground && <PreviewWindowControls style={controls} />}
      <Toaster closeLabel={t.close} />
    </TooltipProvider>
  );
}
