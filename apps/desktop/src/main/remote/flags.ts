import { randomUUID } from 'node:crypto';
import { FEATURE_FLAG_NAMES, FEATURES_OFF, type FeatureFlags } from '@sa/shared';
import { z } from 'zod';
import type { Logger } from '../core/logger';
import { type FetchFn, joinUrl, requestJson } from './http';

const FrontendResponse = z.object({
  toggles: z.array(z.object({ name: z.string(), enabled: z.boolean() })),
});

/** Feature flags from a list of enabled Unleash flag names. */
export function featuresFromNames(enabled: Iterable<string>): FeatureFlags {
  const names = new Set(enabled);
  const entries = Object.entries(FEATURE_FLAG_NAMES).map(([key, name]) => [key, names.has(name)]);
  return Object.fromEntries(entries) as FeatureFlags;
}

/**
 * Reads the feature flags from Unleash's frontend API, which lists only the flags that are on.
 * Fails closed: when Unleash can't be reached or answers nonsense, every feature is off.
 * Once read, it reports their use in the background (see reportFlagMetrics).
 */
export async function loadFeatureFlags(deps: {
  fetch: FetchFn;
  url: string;
  token: string;
  appName: string;
  logger: Logger;
  timeoutMs?: number;
}): Promise<FeatureFlags> {
  const start = new Date();
  try {
    const json = await requestJson(
      deps.fetch,
      joinUrl(deps.url, `/api/frontend?${new URLSearchParams({ appName: deps.appName })}`),
      { headers: { authorization: deps.token }, timeoutMs: deps.timeoutMs ?? 3_000 },
    );
    const parsed = FrontendResponse.parse(json);
    const features = featuresFromNames(parsed.toggles.filter((t) => t.enabled).map((t) => t.name));
    void reportFlagMetrics(deps, start, features);
    return features;
  } catch (err) {
    deps.logger.warn('feature flags unavailable: every feature is off', {
      error: err instanceof Error ? err.message : String(err),
    });
    return FEATURES_OFF;
  }
}

/**
 * Tells Unleash each flag was checked once, on or off, so its UI shows the flags as used (last
 * seen, yes/no counts). The app checks every flag once per launch. The instance id is random per
 * launch: nothing identifies the user. Failures are only logged.
 */
async function reportFlagMetrics(
  deps: { fetch: FetchFn; url: string; token: string; appName: string; logger: Logger },
  start: Date,
  features: FeatureFlags,
): Promise<void> {
  const toggles = Object.fromEntries(
    Object.entries(FEATURE_FLAG_NAMES).map(([key, name]) => {
      const on = features[key as keyof FeatureFlags];
      return [name, { yes: on ? 1 : 0, no: on ? 0 : 1, variants: {} }];
    }),
  );
  try {
    await requestJson(deps.fetch, joinUrl(deps.url, '/api/frontend/client/metrics'), {
      headers: { authorization: deps.token },
      body: {
        appName: deps.appName,
        instanceId: randomUUID(),
        bucket: { start: start.toISOString(), stop: new Date().toISOString(), toggles },
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    deps.logger.debug('feature flag metrics not sent', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
