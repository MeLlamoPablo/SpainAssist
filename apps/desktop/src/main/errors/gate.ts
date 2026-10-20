import type { FeatureFlags, Settings } from '@sa/shared';

/** The remote kill switch and the user's current anonymous-sharing preference must both allow it. */
export function errorReportsAllowed(
  features: Pick<FeatureFlags, 'errorReports'>,
  settings: Pick<Settings, 'shareLearnings'>,
): boolean {
  return features.errorReports && settings.shareLearnings;
}
