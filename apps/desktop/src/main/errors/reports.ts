import { homedir } from 'node:os';
import { scrubPii } from '@sa/pii';
import * as Sentry from '@sentry/electron/main';
import { scrubReport } from './scrub';

export interface ErrorReports {
  /**
   * Decides, per event, whether reports may be sent: the `error-reports` flag and the user's
   * setting. Until it is set (flags load after `ready`) nothing is sent.
   */
  setGate(allowed: () => boolean): void;
}

/**
 * Error reports to GlitchTip with the Sentry SDK (D29). Must run before `ready`: the SDK
 * registers the `sentry-ipc` scheme the renderer's SDK hands its events to main through, so
 * renderer errors pass the same gate and scrubbing.
 *
 * Only errors: no tracing, sessions, breadcrumbs (they hold URLs, console lines and clicked UI
 * text), local variables or minidumps (process memory), and no offline queue (an opt-out must
 * not leave reports on disk to send later).
 */
export function startErrorReports(opts: {
  dsn: string;
  release: string;
  environment: string;
}): ErrorReports {
  let allowed = () => false;
  const homeDir = homedir();
  Sentry.init({
    dsn: opts.dsn,
    release: opts.release,
    environment: opts.environment,
    ipcMode: Sentry.IPCMode.Protocol,
    transport: Sentry.makeElectronTransport,
    dataCollection: { userInfo: false },
    maxBreadcrumbs: 0,
    sendClientReports: false,
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
      // Renderer and GPU process crashes as events (no dumps).
      Sentry.childProcessIntegration({ breadcrumbs: [], events: ['crashed', 'oom', 'killed'] }),
      Sentry.electronContextIntegration(),
      Sentry.nodeContextIntegration({ cloudResource: false }),
      Sentry.normalizePathsIntegration(),
    ],
    beforeSend: (event) => (allowed() ? scrubReport(event, { homeDir, scrubPii }) : null),
    beforeSendTransaction: () => null,
  });
  return {
    setGate(gate) {
      allowed = gate;
    },
  };
}
