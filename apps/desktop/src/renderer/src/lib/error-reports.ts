import * as Sentry from '@sentry/electron/renderer';

/**
 * Renderer half of the error reports: uncaught errors and rejections go to main through
 * the SDK's `sentry-ipc` scheme, where the flag, the setting and PII scrubbing apply. No
 * breadcrumbs (clicked UI text, URLs, console lines) and no request data.
 */
export function startErrorReports(): void {
  Sentry.init({
    maxBreadcrumbs: 0,
    integrations: (defaults) =>
      defaults.filter((i) => !['Breadcrumbs', 'HttpContext', 'BrowserSession'].includes(i.name)),
  });
}

/**
 * An error an `ErrorBoundary` caught while rendering. React doesn't rethrow those, so the SDK's
 * global handlers never see them. Without `startErrorReports` the SDK has no client: a no-op.
 */
export function reportRenderError(error: unknown, componentStack?: string | null): void {
  Sentry.captureException(error, componentStack ? { contexts: { react: { componentStack } } } : {});
}
