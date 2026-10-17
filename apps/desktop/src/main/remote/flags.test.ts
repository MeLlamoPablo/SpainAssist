import { FEATURES_OFF } from '@sa/shared';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../core/logger';
import { createFakeFetch, jsonResponse } from '../testing/harness';
import { loadFeatureFlags } from './flags';

const logger = createLogger({ level: 'error', sinks: [] });

function load(handler: Parameters<typeof createFakeFetch>[0]) {
  const fetch = createFakeFetch(handler);
  const flags = loadFeatureFlags({
    fetch,
    url: 'https://flags.test',
    token: 'default:production.token',
    appName: 'desktop',
    appVersion: '0.2.0-beta.1',
    platform: 'darwin',
    arch: 'arm64',
    logger,
  });
  return { fetch, flags };
}

describe('loadFeatureFlags', () => {
  it("reads the flags that are on from Unleash's frontend API", async () => {
    const { fetch, flags } = load(() =>
      jsonResponse(200, { toggles: [{ name: 'feedback-server', enabled: true }] }),
    );
    expect(await flags).toEqual({
      feedbackServer: true,
      dniePhone: false,
      mustUpdate: false,
      errorReports: false,
    });
    const request = fetch.requests[0];
    expect(request?.url.pathname).toBe('/api/frontend');
    // The version, OS and CPU are context properties, so Unleash constraints can target them.
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      appName: 'desktop',
      'properties[appVersion]': '0.2.0-beta.1',
      'properties[platform]': 'darwin',
      'properties[arch]': 'arm64',
    });
    expect(request?.headers.get('authorization')).toBe('default:production.token');
  });

  it('reports to Unleash that each flag was checked once, on or off', async () => {
    const { fetch, flags } = load((req) =>
      req.url.pathname === '/api/frontend'
        ? jsonResponse(200, { toggles: [{ name: 'dnie-phone', enabled: true }] })
        : jsonResponse(202, {}),
    );
    await flags;
    await vi.waitFor(() => expect(fetch.requests).toHaveLength(2));
    const metrics = fetch.requests[1];
    expect(metrics?.url.href).toBe('https://flags.test/api/frontend/client/metrics');
    expect(metrics?.method).toBe('POST');
    expect(metrics?.headers.get('authorization')).toBe('default:production.token');
    expect(metrics?.body).toMatchObject({
      appName: 'desktop',
      instanceId: expect.any(String),
      bucket: {
        start: expect.any(String),
        stop: expect.any(String),
        toggles: {
          'feedback-server': { yes: 0, no: 1, variants: {} },
          'dnie-phone': { yes: 1, no: 0, variants: {} },
          'must-update': { yes: 0, no: 1, variants: {} },
        },
      },
    });
  });

  it('keeps the flags when the metrics report fails', async () => {
    const { fetch, flags } = load((req) =>
      req.url.pathname === '/api/frontend'
        ? jsonResponse(200, { toggles: [{ name: 'feedback-server', enabled: true }] })
        : jsonResponse(500, {}),
    );
    expect(await flags).toEqual({
      feedbackServer: true,
      dniePhone: false,
      mustUpdate: false,
      errorReports: false,
    });
    await vi.waitFor(() => expect(fetch.requests).toHaveLength(2));
  });

  it('turns on DNIe with the phone only when dnie-phone is on', async () => {
    const on = load(() =>
      jsonResponse(200, { toggles: [{ name: 'dnie-phone', enabled: true }] }),
    ).flags;
    expect(await on).toEqual({
      feedbackServer: false,
      dniePhone: true,
      mustUpdate: false,
      errorReports: false,
    });
    const off = load(() =>
      jsonResponse(200, { toggles: [{ name: 'dnie-phone', enabled: false }] }),
    ).flags;
    expect((await off).dniePhone).toBe(false);
  });

  it('blocks this version only when must-update is on', async () => {
    const on = load(() =>
      jsonResponse(200, { toggles: [{ name: 'must-update', enabled: true }] }),
    ).flags;
    expect(await on).toEqual({
      feedbackServer: false,
      dniePhone: false,
      mustUpdate: true,
      errorReports: false,
    });
  });

  it('reads error-reports as errorReports', async () => {
    const on = load(() =>
      jsonResponse(200, { toggles: [{ name: 'error-reports', enabled: true }] }),
    ).flags;
    expect((await on).errorReports).toBe(true);
  });

  it('turns off every feature Unleash does not list', async () => {
    const { flags } = load(() => jsonResponse(200, { toggles: [] }));
    expect(await flags).toEqual(FEATURES_OFF);
  });

  it('turns off every feature when Unleash fails or answers nonsense', async () => {
    expect(await load(() => jsonResponse(401, {})).flags).toEqual(FEATURES_OFF);
    expect(await load(() => jsonResponse(200, { nope: true })).flags).toEqual(FEATURES_OFF);
    expect(
      await load(() => {
        throw new TypeError('fetch failed');
      }).flags,
    ).toEqual(FEATURES_OFF);
  });
});
