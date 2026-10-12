import type { HomeAddress, MapPoint } from '@sa/shared';
import { z } from 'zod';

/**
 * Address lookups through our maps server (services/maps-server), which forwards them to Mapbox
 * Geocoding v6 for Spain with our secret token, so no Mapbox token ships in the app. Requests
 * carry the user's gateway key (voucher or ChatGPT key), which the server checks and rate-limits.
 * Results are Mapbox "temporary geocodes": use them to place pins, never store, cache, log or
 * show their coordinates, and never send them to the agent. Queries are personal data: never log
 * them, and never let a service error (which contains the URL) escape.
 */

const text = z.object({ name: z.string() }).optional();
const Feature = z.object({
  properties: z.object({
    coordinates: z.object({
      latitude: z.number().min(-85).max(85),
      longitude: z.number().min(-180).max(180),
    }),
    context: z
      .object({
        country: z.object({ country_code: z.string() }).optional(),
        place: text,
        locality: text,
      })
      .default({}),
  }),
});
type Feature = z.infer<typeof Feature>;
const Response = z.object({ features: z.array(Feature).max(20) });

function normalize(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The result's town must be named in the request: an address in another town is not a match. */
function inTown(feature: Feature, request: string) {
  const wanted = ` ${normalize(request)} `;
  const { place, locality } = feature.properties.context;
  return [place?.name, locality?.name].some(
    (town) => town && wanted.includes(` ${normalize(town)} `),
  );
}

/** The user's address lookups are used up for now (the maps server's daily or weekly quota). */
export class MapQuotaError extends Error {
  constructor() {
    super('Map lookups used up.');
    this.name = 'MapQuotaError';
  }
}

const ErrorBody = z.object({ error: z.object({ code: z.string() }) });

export interface MapsOptions {
  /** Maps server base URL; undefined disables lookups (e2e runs). */
  endpoint?: string;
  /** The user key; undefined when the provider has none (BYOK, custom endpoints). */
  access: () => Promise<{ apiKey: string } | undefined>;
  fetch?: typeof fetch;
}

export function createMaps({
  endpoint,
  access,
  fetch: fetchImpl = (...args) => fetch(...args),
}: MapsOptions) {
  /** An address or street as written (abbreviations, floor and door are fine), in `town`. */
  async function locate(
    query: string,
    town: string,
    signal?: AbortSignal,
  ): Promise<MapPoint | undefined> {
    const key = endpoint ? await access().catch(() => undefined) : undefined;
    if (!endpoint || !key) throw new Error('Map lookup unavailable.');
    const url = new URL('/v1/geocode', endpoint);
    url.searchParams.set('q', query);
    let response: globalThis.Response;
    try {
      signal?.throwIfAborted();
      response = await fetchImpl(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${key.apiKey}` },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch {
      // Fetch errors can include the request URL: the personal address.
      throw new Error('Map lookup unavailable.');
    }
    if (response.status === 429) {
      const body = ErrorBody.safeParse(await response.json().catch(() => undefined));
      if (body.success && body.data.error.code === 'quota_exceeded') throw new MapQuotaError();
    }
    if (!response.ok) throw new Error('Map lookup unavailable.');
    let data: z.infer<typeof Response>;
    try {
      data = Response.parse(await response.json());
    } catch {
      throw new Error('Invalid map lookup response.');
    }
    // A service ignoring the country filter must never show foreign pins.
    const match = data.features.find(
      (f) => f.properties.context.country?.country_code.toLowerCase() === 'es' && inTown(f, town),
    );
    return (
      match && {
        latitude: match.properties.coordinates.latitude,
        longitude: match.properties.coordinates.longitude,
      }
    );
  }

  return {
    /** A public place from the agent, by its street address (which names its town). */
    place: (address: string, signal?: AbortSignal) => locate(address, address, signal),

    /** The user's home, from the address saved in Mis datos. */
    async home(home: HomeAddress, signal?: AbortSignal): Promise<MapPoint | null> {
      const query = [
        home.street,
        [home.postalCode, home.municipality].filter(Boolean).join(' '),
      ].join(', ');
      return (await locate(query, home.municipality, signal)) ?? null;
    },
  };
}

export type Maps = ReturnType<typeof createMaps>;
