import type { FormPrompt, MapPoint } from '@sa/shared';
import { BridgeError } from '../core/errors';
import { MapQuotaError, type Maps } from './maps';

export type PlaceLookup = Maps['place'];
/**
 * Pins of a form's map fields, by field key, in option order (null: not found). A field maps to
 * null when it has no map because the user's lookups are used up: the form shows only the list.
 */
export type MapPins = Map<string, (MapPoint | null)[] | null>;
/** Lookup results by address (undefined: not found), kept in memory only for a retried form. */
export type PlaceResults = Map<string, MapPoint | undefined>;

/**
 * Place every map option before showing anything to the user (no partial forms). The pins are
 * kept in memory with the pending prompt for its map, never in the saved form: Mapbox results
 * may not be stored. `known` holds the results of an earlier attempt of the same form, so a retry
 * only looks up the addresses that changed; it gets this attempt's results too. When the lookups
 * are used up, the form is shown without maps instead of failing.
 */
export async function locateMapForm(
  prompt: FormPrompt,
  lookup: PlaceLookup,
  signal: AbortSignal,
  known: PlaceResults = new Map(),
): Promise<MapPins> {
  const pins: MapPins = new Map();
  const missing: string[] = [];
  for (const field of prompt.fields) {
    if (field.type !== 'map-options') continue;
    const points: (MapPoint | null)[] = [];
    for (const option of field.options ?? []) {
      signal.throwIfAborted();
      // The form schema requires an address for every map option.
      const address = option.address?.trim() ?? '';
      let point: MapPoint | undefined;
      try {
        point = known.has(address) ? known.get(address) : await lookup(address, signal);
      } catch (err) {
        signal.throwIfAborted();
        if (err instanceof MapQuotaError) return withoutMaps(prompt);
        throw new BridgeError(
          'unavailable',
          'Place lookup unavailable. No form was shown. Retry later; do not switch to select.',
        );
      }
      signal.throwIfAborted();
      known.set(address, point);
      points.push(point ?? null);
      if (!point) missing.push(`${field.key}/${option.value}: ${address}`);
    }
    pins.set(field.key, points);
  }
  if (missing.length) {
    throw new BridgeError(
      'not_found',
      `No matching place in Spain for: ${missing.join('; ')}. No form was shown. Research these public places in official directories or centre websites, find their street addresses and municipality, then retry ask_user with corrected map-options. Do not omit places silently or switch to select.`,
    );
  }
  return pins;
}

function withoutMaps(prompt: FormPrompt): MapPins {
  return new Map(prompt.fields.filter((f) => f.type === 'map-options').map((f) => [f.key, null]));
}

/**
 * Pins of one map field of a pending form, for its map: the ones found before it was shown, or,
 * for a form restored after a restart, looked up once now and kept with the prompt.
 */
export async function pendingFormPins(
  prompt: FormPrompt,
  pins: MapPins,
  fieldKey: string,
  lookup: PlaceLookup,
): Promise<(MapPoint | null)[] | null> {
  const known = pins.get(fieldKey);
  if (known !== undefined) return known;
  const field = prompt.fields.find((f) => f.key === fieldKey && f.type === 'map-options');
  if (!field) throw new Error('Not a map field.');
  let points: (MapPoint | null)[] | null;
  try {
    points = await Promise.all(
      (field.options ?? []).map(async (option) => (await lookup(option.address ?? '')) ?? null),
    );
  } catch (err) {
    if (!(err instanceof MapQuotaError)) throw err;
    points = null;
  }
  pins.set(fieldKey, points);
  return points;
}
